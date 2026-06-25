/**
 * Public types for the pi-conductor analytics plugin.
 */

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
  };
}

/** The envelope sent to the configured endpoint. */
export interface AnalyticsEnvelope {
  plugin: "pi-conductor-analytics-plugin";
  plugin_version: string;
  schema_version: 1;
  sent_at: string;
  cwd: string;
  source: "pi.events:conductor:record";
  records: unknown[];
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
