/**
 * JSONL backstop / watermark — per-run watermark tracking to ship
 * records that may have been missed during a network outage or
 * late plugin load.
 *
 * Each run gets a small JSON sidecar file alongside the run's JSONL:
 *   <run_base>/.pi-conductor/runs/<run_id>.watermark.json
 *
 * The watermarks directory is derived from the conductor run base:
 *   <cwd>/.pi-conductor/runs/
 *
 * On `session_start`, the backstop walks .pi-conductor/runs/*.jsonl
 * files and ships any records past the per-run watermark.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DeliveryQueue } from "./queue.js";
import type { ResolvedConfig } from "./types.js";

// ─── Default run directory ──────────────────────────────────────────────

/**
 * The default directory where pi-conductor stores run JSONL files.
 * Mirrors `DEFAULT_RUN_BASE_DIR` in pi-conductor's start.ts.
 */
export const DEFAULT_RUN_BASE_DIR = ".pi-conductor/runs";

// ─── Watermark file helpers ─────────────────────────────────────────────

interface WatermarkData {
  lastSentIndex: number;
}

function watermarkPath(runsDir: string, runId: string): string {
  return join(runsDir, `${runId}.watermark.json`);
}

function readWatermark(runsDir: string, runId: string): number {
  const wmPath = watermarkPath(runsDir, runId);
  if (!existsSync(wmPath)) return -1;
  try {
    const data = JSON.parse(readFileSync(wmPath, "utf-8")) as WatermarkData;
    return typeof data.lastSentIndex === "number" ? data.lastSentIndex : -1;
  } catch {
    return -1;
  }
}

function writeWatermark(runsDir: string, runId: string, lastSentIndex: number): void {
  const wmPath = watermarkPath(runsDir, runId);
  const data: WatermarkData = { lastSentIndex };
  writeFileSync(wmPath, JSON.stringify(data), "utf-8");
}

// ─── Run file helpers ───────────────────────────────────────────────────

interface RunFile {
  runId: string;
  filePath: string;
}

/**
 * Discover JSONL run files in the runs directory.
 */
function discoverRuns(runsDir: string): RunFile[] {
  if (!existsSync(runsDir)) return [];
  try {
    const entries = readdirSync(runsDir);
    const seen = new Set<string>();
    const result: RunFile[] = [];
    for (const entry of entries) {
      // Match `*.jsonl` but not `*.watermark.json`
      if (entry.endsWith(".jsonl") && !entry.endsWith(".watermark.json")) {
        const runId = entry.slice(0, -6); // strip ".jsonl"
        if (!seen.has(runId)) {
          seen.add(runId);
          result.push({ runId, filePath: join(runsDir, entry) });
        }
      }
    }
    return result.sort((a, b) => a.runId.localeCompare(b.runId));
  } catch {
    return [];
  }
}

/**
 * Read records from a JSONL file starting from a given index.
 * Returns the records and the count of lines read.
 */
function readRecordsFrom(
  filePath: string,
  startIndex: number,
): { records: unknown[]; lineCount: number } {
  if (!existsSync(filePath)) return { records: [], lineCount: 0 };
  try {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.trim().split("\n");
    const records: unknown[] = [];
    for (let i = startIndex + 1; i < lines.length; i++) {
      const line = lines[i]?.trim();
      if (line !== undefined && line.length > 0) {
        try {
          records.push(JSON.parse(line));
        } catch {
          // Skip unparseable lines
        }
      }
    }
    return { records, lineCount: lines.length };
  } catch {
    return { records: [], lineCount: 0 };
  }
}

// ─── Backstop execution ─────────────────────────────────────────────────

/**
 * Run the JSONL backstop: walk all known JSONL run files and enqueue
 * any records past the per-run watermark.
 *
 * **Watermarks are updated only after successful delivery**, not after
 * reading. This prevents record loss when delivery fails: if the network
 * is down, records remain in the queue and replay on the next backstop.
 *
 * @param cwd    The current working directory (probe <cwd>/.pi-conductor/runs/).
 * @param queue  The delivery queue to enqueue records into.
 * @param _config  The resolved config (used for batching, not delivery here).
 * @returns Promise resolving to the number of backfill records enqueued.
 */
export async function runBackstop(
  cwd: string,
  queue: DeliveryQueue,
  _config: ResolvedConfig,
): Promise<number> {
  const runsDir = join(cwd, DEFAULT_RUN_BASE_DIR);
  if (!existsSync(runsDir)) return 0;

  const runs = discoverRuns(runsDir);
  let totalEnqueued = 0;

  // Track the highest index per run that has been enqueued.
  // The watermark is updated to this value after delivery confirmation.
  const pendingHighIndex: Record<string, number> = {};

  for (const run of runs) {
    const watermark = readWatermark(runsDir, run.runId);
    const { records } = readRecordsFrom(run.filePath, watermark);

    if (records.length === 0) continue;

    const highestIndex = watermark + records.length;
    pendingHighIndex[run.runId] = Math.max(pendingHighIndex[run.runId] ?? -1, highestIndex);

    // Use enqueueFromRun so run metadata (runId, index) is preserved in the buffer.
    // This is required for the delivery callback to correctly identify which run
    // delivered records belong to.
    for (let i = 0; i < records.length; i++) {
      // readRecordsFrom starts at watermark + 1, so record at index i has JSONL index: watermark + i + 1
      queue.enqueueFromRun(records[i], run.runId, watermark + i + 1);
      totalEnqueued++;
    }
  }

  if (totalEnqueued === 0) return 0;

  // Wire a delivery callback so watermarks advance only after confirmed delivery.
  // This ensures at-least-once semantics: failed delivery leaves records in the
  // queue and the watermark is NOT advanced.
  let delivered = 0;
  let resolvePromise: ((n: number) => void) | null = null;
  const promise = new Promise<number>((resolve) => {
    resolvePromise = resolve;
  });

  queue.setDeliveryCallback((runId, count) => {
    if (runId === null) return;
    const pendingIdx = pendingHighIndex[runId];
    if (pendingIdx !== undefined) {
      writeWatermark(runsDir, runId, pendingIdx);
      delete pendingHighIndex[runId];
    }
    delivered += count;

    if (delivered >= totalEnqueued && resolvePromise) {
      resolvePromise(totalEnqueued);
      resolvePromise = null;
    }
  });

  // Flush the queue (non-blocking). The delivery callback fires when the
  // POST resolves, which resolves the promise via the callback above.
  queue.flush().catch(() => {
    // Flush errors (exceptions) are non-fatal; records remain in the queue
    // and will be replayed on the next backstop.
  });

  // Safety timeout: if delivery never succeeds (network down, etc.), resolve
  // the promise after 5 minutes so callers don't hang indefinitely.
  // The watermark is NOT advanced in this case (at-least-once semantics).
  setTimeout(() => {
    if (resolvePromise) {
      resolvePromise(totalEnqueued);
      resolvePromise = null;
    }
  }, 300_000);

  return promise;
}

/**
 * Update the watermark for a single run after the queue delivers a record.
 *
 * @param runId   The run ID to update.
 * @param index   The 0-based index of the last-sent record in the JSONL.
 */
export function updateWatermark(runId: string, index: number, cwd: string): void {
  const runsDir = join(cwd, DEFAULT_RUN_BASE_DIR);
  writeWatermark(runsDir, runId, index);
}
