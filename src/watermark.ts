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
 * @param cwd   The current working directory (probe <cwd>/.pi-conductor/runs/).
 * @param queue  The delivery queue to enqueue records into.
 * @param config  The resolved config (used for batching, not delivery here).
 * @returns The number of backfill records enqueued.
 */
export function runBackstop(cwd: string, queue: DeliveryQueue, _config: ResolvedConfig): number {
  const runsDir = join(cwd, DEFAULT_RUN_BASE_DIR);
  if (!existsSync(runsDir)) return 0;

  const runs = discoverRuns(runsDir);
  let totalEnqueued = 0;

  for (const run of runs) {
    const watermark = readWatermark(runsDir, run.runId);
    const { records, lineCount } = readRecordsFrom(run.filePath, watermark);

    for (const record of records) {
      queue.enqueue(record);
      totalEnqueued++;
    }

    // Update watermark to reflect all lines read
    if (lineCount > watermark + 1) {
      writeWatermark(runsDir, run.runId, lineCount - 1);
    }
  }

  return totalEnqueued;
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
