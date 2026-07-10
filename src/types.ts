/**
 * Public types for the pi-conductor analytics plugin.
 */

// ─── Reporter API (issue #1) ─────────────────────────────────────────────

/**
 * Minimal record shape accepted by the reporter.
 * Must be a non-null object with a string `type` field.
 */
export interface AnalyticsRecord {
  readonly [key: string]: unknown;
  readonly type: string;
}

/**
 * Options for creating an analytics reporter.
 *
 * @example
 * ```ts
 * const reporter = createAnalyticsReporter({
 *   cwd: process.cwd(),
 *   runsDir: join(process.cwd(), ".pi-conductor/runs"),
 *   configPath: "./analytics.json",
 *   source: "library:conductor:record",
 * });
 * ```
 */
export interface AnalyticsReporterOptions {
  /**
   * The current working directory for config discovery.
   * Required.
   */
  readonly cwd: string;
  /**
   * The directory where pi-conductor stores run JSONL files.
   * Required — library integrations must provide this explicitly.
   *
   * Example: `<cwd>/.pi-conductor/runs`
   */
  readonly runsDir: string;
  /**
   * Path to an explicit config file.
   * When supplied, config is loaded from this path only and
   * bypasses the `getConfig()` cache to ensure isolation.
   * Optional.
   */
  readonly configPath?: string;
  /**
   * The `source` label placed in outgoing envelopes.
   * Defaults to `"pi.events:conductor:record"`.
   * Library callers may use `"library:conductor:record"` or another
   * explicit label.
   */
  readonly source?: string;
}

/**
 * Pi-independent lifecycle interface for programmatic analytics delivery.
 *
 * Create an instance with `createAnalyticsReporter()`.
 *
 * All methods are safe to call when the reporter is disabled:
 * - `enqueue()` silently drops invalid records.
 * - `backfill()`, `flush()`, and `shutdown()` resolve immediately with 0.
 * - `stats()` returns a snapshot with all counters at zero.
 */
export interface AnalyticsReporter {
  /**
   * Enqueue a record for delivery. Returns immediately (non-blocking).
   * Invalid records are ignored without throwing.
   */
  enqueue(record: unknown): void;
  /**
   * Scan JSONL runs from the configured `runsDir` and enqueue records
   * past each run's committed watermark.
   *
   * Returns the count of records queued.
   * Does not block on delivery.
   */
  backfill(): Promise<number>;
  /**
   * Flush all pending records. Resolves when the flush attempt
   * completes (success or failure) or when the overall deadline
   * (request timeout or explicit override) is reached.
   *
   * @param deadlineMs  Optional deadline override in ms. Uses config timeoutMs if not provided.
   */
  flush(deadlineMs?: number): Promise<void>;
  /**
   * Flush remaining records and stop the reporter.
   * Uses a 2-second shutdown deadline.
   */
  shutdown(): Promise<void>;
  /**
   * Get a snapshot of delivery statistics.
   */
  stats(): QueueStats;
}

/**
 * Callback invoked when the delivery queue overflows (drops the oldest
 * pending record).
 *
 * Implementations must not throw or await. The callback is invoked
 * synchronously for the first overflow; subsequent callbacks are
 * rate-limited (default 5 seconds) and aggregate suppressed drops.
 *
 * @param dropped    Cumulative dropped record count since reporter creation.
 * @param pending    Current pending (un-flushed) record count.
 * @param suppressed Number of suppressed callbacks since the last callback.
 */
export type OverflowCallback = (dropped: number, pending: number, suppressed: number) => void;

// ─── Existing types ───────────────────────────────────────────────────────

/** Configuration shape for the analytics plugin. */
export interface AnalyticsConfig {
  /** Master switch. Default: true. */
  enabled?: boolean;
  /** HTTP(S) endpoint to POST records to. Required when enabled is not false. */
  endpoint?: string;
  /** Custom HTTP headers to include in every POST. */
  headers?: Record<string, string>;
  /** Batching configuration. */
  batch?: {
    /** Enable batching. Default: true. */
    enabled?: boolean;
    /** Maximum records per batch POST. Default: 25. */
    maxRecords?: number;
    /** Maximum interval in ms before a partial batch is flushed. Default: 1000. */
    flushIntervalMs?: number;
  };
  /** Request-level configuration. */
  request?: {
    /** Request timeout in ms. Default: 5000. */
    timeoutMs?: number;
    /** Maximum retries per failed request. Default: 2. */
    maxRetries?: number;
    /** Retry behavior configuration. */
    retry?: {
      /** Base delay in ms for exponential backoff. Default: 100. */
      baseDelayMs?: number;
      /** Maximum delay in ms between retries. Default: 2000. */
      maxDelayMs?: number;
      /** Jitter factor (0-1). Random fraction of delay added for thundering herd prevention. Default: 0 (deterministic backoff). */
      jitterFactor?: number;
    };
  };
}

/** Resolved config with all defaults applied. */
export interface ResolvedConfig {
  enabled: boolean;
  endpoint: string | undefined;
  headers: Record<string, string>;
  batch: {
    enabled: boolean;
    maxRecords: number;
    flushIntervalMs: number;
  };
  request: {
    timeoutMs: number;
    maxRetries: number;
    retry: {
      baseDelayMs: number;
      maxDelayMs: number;
      jitterFactor: number;
    };
  };
}

/**
 * The envelope sent to the configured endpoint.
 *
 * `source` is typically `"pi.events:conductor:record"` for the Pi extension
 * or a caller-provided label for library integrations.
 */
export interface AnalyticsEnvelope {
  plugin: "pi-conductor-analytics-plugin";
  plugin_version: string;
  schema_version: 1;
  sent_at: string;
  cwd: string;
  source: string;
  records: unknown[];
  /**
   * Optional metadata for delivery-aware watermark tracking.
   * When set, the delivery callback will receive this run ID
   * so watermarks can be updated after successful delivery.
   */
  run_id?: string;
  /**
   * Optional line indices in the JSONL file for the records in this envelope.
   * Used for precise watermark tracking.
   */
  run_indices?: number[];
}

/** Queue item representing a record to be delivered. */
export interface QueueItem {
  records: unknown[];
}

/** Diagnostic counters exposed by the delivery queue. */
export interface QueueStats {
  enqueued: number;
  delivered: number;
  failed: number;
  dropped: number;
  pending: number;
}

/** Internal queue state for testing and diagnostics. */
export interface QueueDiagnostics {
  stats: QueueStats;
  overflowCount: number;
}

/** Per-run watermark tracking the last-sent record index. */
export interface RunWatermark {
  runId: string;
  lastSentIndex: number;
}

// ─── Deadline and abort types ─────────────────────────────────────────────

/**
 * Deadline tracking state passed through flush operations.
 * Allows callers to set a total time budget for all retries.
 */
export interface DeadlineState {
  /** Absolute deadline in milliseconds (Date.now() style). 0 = no deadline. */
  readonly deadline: number;
  /** Remaining time in ms. Returns 0 if deadline exceeded. */
  remaining(): number;
  /** Check if deadline is exceeded. */
  isExceeded(): boolean;
  /** Time already elapsed in ms. */
  elapsed(): number;
}

/**
 * Creates a DeadlineState for tracking time budgets.
 *
 * @param deadlineMs  Total budget in ms from now. 0 = no deadline.
 */
export function createDeadline(deadlineMs: number): DeadlineState {
  const start = Date.now();
  const absDeadline = deadlineMs > 0 ? start + deadlineMs : 0;
  return {
    deadline: absDeadline,
    remaining: () => {
      if (absDeadline === 0) return Infinity;
      const rem = absDeadline - Date.now();
      return rem > 0 ? rem : 0;
    },
    isExceeded: () => {
      if (absDeadline === 0) return false;
      return Date.now() >= absDeadline;
    },
    elapsed: () => Date.now() - start,
  };
}

// ─── Delivery callback types ──────────────────────────────────────────────

/**
 * Callback invoked after records are successfully delivered.
 * Enables watermark updates and other delivery-aware behavior.
 *
 * @param runId    The run ID these records belong to, or null if unknown.
 * @param count    Number of records in the batch.
 * @param indices  Optional indices of records in the run (for watermark tracking).
 */
export type DeliveryCallback = (runId: string | null, count: number, indices?: number[]) => void;

/**
 * Options for creating a delivery-aware queue.
 */
export interface DeliveryQueueOptions {
  /** Called when a batch is successfully delivered. */
  onDelivery?: DeliveryCallback;
}
