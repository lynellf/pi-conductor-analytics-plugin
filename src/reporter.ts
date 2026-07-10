/**
 * Pi-independent analytics reporter factory.
 *
 * Provides a lifecycle boundary for programmatic analytics delivery
 * without requiring the Pi extension. Library integrations can create
 * a reporter with explicit cwd, runsDir, configPath, and source options.
 *
 * The reporter owns:
 * - Config resolution (from explicit path or standard discovery)
 * - Queue construction and delivery
 * - JSONL backfill against an explicit runs directory
 * - Delivery-aware watermark updates
 * - Flush, shutdown, and stats lifecycle
 *
 * ## Example
 *
 * ```ts
 * import { createAnalyticsReporter } from "./reporter.js";
 *
 * const reporter = createAnalyticsReporter({
 *   cwd: process.cwd(),
 *   runsDir: join(process.cwd(), ".pi-conductor/runs"),
 *   source: "library:conductor:record",
 * });
 *
 * reporter.enqueue({ type: "my_event", value: 42 });
 * await reporter.flush();
 * await reporter.shutdown();
 * ```
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig, loadConfigFromPath } from "./config.js";
import { DeliveryQueue, defaultPost } from "./queue.js";
import type {
  AnalyticsRecord,
  AnalyticsReporter,
  AnalyticsReporterOptions,
  OverflowCallback,
  QueueStats,
  ResolvedConfig,
} from "./types.js";

// ─── Constants ──────────────────────────────────────────────────────────

const PLUGIN_VERSION = "0.1.0";

// ─── Reporter implementation ────────────────────────────────────────────

/**
 * Minimal record validation: must be a non-null object with a string `type`.
 */
function isValidRecord(data: unknown): data is AnalyticsRecord {
  return (
    typeof data === "object" && data !== null && typeof (data as AnalyticsRecord).type === "string"
  );
}

/**
 * Create a Pi-independent analytics reporter.
 *
 * The reporter is disabled when config is missing, invalid, or explicitly
 * disabled. In disabled state all lifecycle methods settle immediately
 * without performing network operations.
 *
 * @param options  Reporter configuration options.
 * @param options.cwd        Required. The working directory for config discovery.
 * @param options.runsDir    Required. The directory containing run JSONL files.
 * @param options.configPath  Optional. Explicit config file path (bypasses cache).
 * @param options.source      Optional. Envelope source label (default: pi.events:conductor:record).
 * @param overflowCallback   Optional. Callback invoked on queue overflow.
 * @returns An AnalyticsReporter lifecycle interface.
 */
export function createAnalyticsReporter(
  options: AnalyticsReporterOptions,
  overflowCallback?: OverflowCallback,
): AnalyticsReporter {
  // ── Resolve config ───────────────────────────────────────────────────
  const [config, configSource, configWarnings]: [ResolvedConfig, string | null, string[]] =
    options.configPath !== undefined
      ? loadConfigFromPath(options.configPath, options.cwd)
      : loadConfig(options.cwd, homedir());

  // ── Build queue (disabled if no config or endpoint) ──────────────────
  const isDisabled = !config.enabled || config.endpoint === undefined;
  const source = options.source ?? "pi.events:conductor:record";
  const queue = isDisabled
    ? null
    : new DeliveryQueue(config, defaultPost, options.cwd, PLUGIN_VERSION, source);

  // Wire overflow callback (queue handles rate-limiting internally)
  if (queue && overflowCallback) {
    queue.setOverflowCallback(overflowCallback);
  }

  // ── Watermark management ──────────────────────────────────────────────

  /**
   * Write a watermark file for a run using atomic temp file + rename.
   *
   * This ensures crash-safety: if the process crashes during the write,
   * either the old or new watermark file will be valid, never a partial write.
   */
  function writeWatermark(runId: string, lastSentIndex: number): void {
    const wmPath = join(options.runsDir, `${runId}.watermark.json`);
    const tmpPath = join(options.runsDir, `.${runId}.watermark.tmp`);

    // Ensure directory exists
    mkdirSync(options.runsDir, { recursive: true });

    const data = { lastSentIndex };
    const content = JSON.stringify(data);

    // Write to temp file first
    writeFileSync(tmpPath, content, "utf-8");

    // Atomic rename (on POSIX systems; cross-platform renameSync is atomic on same fs)
    try {
      renameSync(tmpPath, wmPath);
    } catch (err) {
      // If rename fails, clean up temp file and re-throw
      try {
        unlinkSync(tmpPath);
      } catch {
        // Ignore cleanup failure
      }
      throw err;
    }
  }

  /**
   * Track pending watermark updates for delivery-aware updates.
   * Maps runId -> highest contiguously-acknowledged index.
   */
  const pendingWatermarks = new Map<string, number>();

  /**
   * Delivery callback that advances watermarks only through contiguous indices.
   *
   * The spec requires: "Successful acknowledgements are accumulated per run and
   * advance only through the highest contiguous acknowledged line; an
   * acknowledgement after a failed gap cannot skip that gap."
   *
   * This function checks the effective committed position (max of on-disk watermark
   * and in-memory pending value) and only advances through strictly increasing,
   * gap-free indices from that position.
   */
  function handleDelivery(runId: string | null, _count: number, indices?: number[]): void {
    if (runId === null || indices === undefined) {
      // Mixed run IDs or no indices - cannot update watermarks precisely
      return;
    }

    // Effective committed position: max of on-disk and in-memory pending
    const committed = readWatermark(runId);
    const pending = pendingWatermarks.get(runId) ?? -1;
    const effectiveStart = Math.max(committed, pending);

    // Only contiguous indices from effectiveStart + 1 are acknowledged
    const sorted = [...new Set(indices)].sort((a, b) => a - b);
    let nextExpected = effectiveStart + 1;

    for (const idx of sorted) {
      if (idx > nextExpected) break; // gap — stop advancing
      if (idx === nextExpected) {
        pendingWatermarks.set(runId, idx);
        nextExpected = idx + 1;
      }
      // idx < nextExpected is a duplicate — skip
    }
  }

  /**
   * Flush pending watermark updates to disk.
   * Call this after successful flush to commit watermarks.
   *
   * Only the highest contiguous index per run is written.
   */
  function flushWatermarks(): void {
    for (const [runId, lastIndex] of pendingWatermarks) {
      // Only update if the new index is greater than what's committed
      const committed = readWatermark(runId);
      if (lastIndex > committed) {
        writeWatermark(runId, lastIndex);
      }
    }
    pendingWatermarks.clear();
  }

  // Wire delivery callback for watermark updates
  if (queue) {
    queue.setDeliveryCallback(handleDelivery);
  }

  // ── Backstop / JSONL scanning ────────────────────────────────────────

  /**
   * Discover JSONL run files in the runs directory.
   */
  function discoverRuns(): Array<{ runId: string; filePath: string }> {
    if (!existsSync(options.runsDir)) return [];
    try {
      const entries = readdirSync(options.runsDir);
      const result: Array<{ runId: string; filePath: string }> = [];
      for (const entry of entries) {
        // Match `*.jsonl` but not `*.watermark.json`
        if (entry.endsWith(".jsonl") && !entry.endsWith(".watermark.json")) {
          const runId = entry.slice(0, -6); // strip ".jsonl"
          result.push({ runId, filePath: join(options.runsDir, entry) });
        }
      }
      return result.sort((a, b) => a.runId.localeCompare(b.runId));
    } catch {
      return [];
    }
  }

  /**
   * Read the committed watermark for a run, or -1 if none exists.
   */
  function readWatermark(runId: string): number {
    const wmPath = join(options.runsDir, `${runId}.watermark.json`);
    if (!existsSync(wmPath)) return -1;
    try {
      const data = JSON.parse(readFileSync(wmPath, "utf-8")) as {
        lastSentIndex?: unknown;
      };
      return typeof data.lastSentIndex === "number" ? data.lastSentIndex : -1;
    } catch {
      return -1;
    }
  }

  /**
   * Read records from a JSONL file starting after the given index.
   *
   * Returns an array of parsed records with their line indices and the number
   * of complete lines read.
   * Malformed complete lines are skipped. A trailing incomplete line is not
   * included and does not advance the position.
   */
  function readRecordsFrom(
    filePath: string,
    startIndex: number,
  ): { records: Array<{ record: AnalyticsRecord; index: number }>; linesRead: number } {
    if (!existsSync(filePath)) return { records: [], linesRead: 0 };
    try {
      const content = readFileSync(filePath, "utf-8");
      const lines = content.split("\n");
      const records: Array<{ record: AnalyticsRecord; index: number }> = [];
      let linesRead = 0;

      // Lines are 1-indexed; startIndex is 0-based and inclusive
      for (let lineIdx = startIndex + 1; lineIdx < lines.length; lineIdx++) {
        const raw = lines[lineIdx] ?? "";
        const trimmed = raw.trim();

        // An empty line at the end of the file is a trailing-incomplete case
        if (trimmed === "") {
          // Check if this is the last line (trailing incomplete)
          if (lineIdx === lines.length - 1) {
            // Don't include it; stop here so it can be retried after restart
            break;
          }
          // Empty lines between records are skipped
          continue;
        }

        // Try to parse as JSON; skip malformed lines
        try {
          const parsed = JSON.parse(trimmed) as AnalyticsRecord;
          // Store with 0-based index for watermark tracking
          records.push({ record: parsed, index: lineIdx });
          linesRead++;
        } catch {
          // Malformed line — skip but count it so we don't block
          linesRead++;
        }
      }

      return { records, linesRead };
    } catch {
      return { records: [], linesRead: 0 };
    }
  }

  // ── Reporter lifecycle ────────────────────────────────────────────────

  /**
   * Enqueue a record for delivery. Returns immediately.
   * Invalid records are silently ignored.
   */
  function enqueue(record: unknown): void {
    if (isDisabled || queue === null) return;
    if (!isValidRecord(record)) return;
    queue.enqueue(record);
  }

  /**
   * Scan JSONL runs from the configured runsDir and enqueue records
   * past each run's committed watermark.
   *
   * Returns the count of records queued. Does not block on delivery.
   */
  async function backfill(): Promise<number> {
    if (isDisabled || queue === null) return 0;

    const runs = discoverRuns();
    if (runs.length === 0) return 0;

    let totalEnqueued = 0;
    for (const run of runs) {
      const committedIndex = readWatermark(run.runId);
      const { records } = readRecordsFrom(run.filePath, committedIndex);

      for (const { record, index } of records) {
        // Use enqueueFromRun to preserve run metadata for watermark tracking
        queue.enqueueFromRun(record, run.runId, index);
        totalEnqueued++;
      }
    }

    return totalEnqueued;
  }

  /**
   * Flush all pending records. Resolves when the flush attempt
   * completes (success or failure) or when the overall deadline
   * (request timeout or explicit override) is reached.
   *
   * After a successful flush, pending watermark updates are committed
   * to disk for delivery-aware watermark tracking.
   *
   * @param deadlineMs  Optional deadline override in ms. Uses config timeoutMs if not provided.
   */
  async function flush(deadlineMs?: number): Promise<void> {
    if (isDisabled || queue === null) return;
    // Validate deadlineMs: must be positive if provided
    if (deadlineMs !== undefined && (typeof deadlineMs !== "number" || deadlineMs <= 0)) {
      return; // Silently ignore invalid deadline values
    }
    await queue.flush(deadlineMs);
    // Commit watermark updates after flush attempt
    flushWatermarks();
  }

  /**
   * Flush remaining records and stop the reporter.
   * Uses a 2-second shutdown deadline.
   *
   * Commits any pending watermark updates before stopping.
   */
  async function shutdown(): Promise<void> {
    if (isDisabled || queue === null) return;
    await queue.shutdown();
    // Ensure any pending watermarks are committed
    flushWatermarks();
  }

  /**
   * Get a snapshot of delivery statistics.
   */
  function stats(): QueueStats {
    if (queue === null) {
      return { enqueued: 0, delivered: 0, failed: 0, dropped: 0, pending: 0 };
    }
    return queue.stats();
  }

  // ── Surface config warnings for library callers ─────────────────────────
  // Log warnings so library callers have visibility into config issues.
  for (const w of configWarnings) {
    console.warn(`[pi-conductor-analytics-plugin] ${w}`);
  }
  if (configSource !== null && !isDisabled) {
    console.warn(`[pi-conductor-analytics-plugin] Config loaded from ${configSource}`);
  }

  if (isDisabled) {
    if (configSource === null) {
      console.warn("[pi-conductor-analytics-plugin] No config found. Reporter inactive.");
    } else {
      console.warn(
        "[pi-conductor-analytics-plugin] Config disabled or missing endpoint. Reporter inactive.",
      );
    }
  }

  return { enqueue, backfill, flush, shutdown, stats };
}
