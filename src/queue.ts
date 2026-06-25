/**
 * Bounded async delivery queue for non-blocking HTTP POST delivery.
 *
 * Records are enqueued from the `conductor:record` handler and flushed
 * either on batch-size threshold or on a configurable interval.
 * The queue is bounded to prevent unbounded memory growth.
 */

import type { AnalyticsEnvelope, QueueStats, ResolvedConfig } from "./types.js";

// ─── Constants ──────────────────────────────────────────────────────────

/** Hard cap on total pending records to prevent unbounded growth. */
const MAX_PENDING_RECORDS = 500;

// ─── Queue internals ────────────────────────────────────────────────────

type PostFunction = (envelope: AnalyticsEnvelope, config: ResolvedConfig) => Promise<boolean>;

/**
 * Delivery queue with batching, retries, and bounded memory.
 */
export class DeliveryQueue {
  private buffer: unknown[] = [];
  private posting = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private _stats: QueueStats = { enqueued: 0, delivered: 0, failed: 0, dropped: 0, pending: 0 };
  private _overflowCount = 0;

  // Config snapshot
  private config: ResolvedConfig;
  private postFn: PostFunction;
  private _cwd: string;
  private _pluginVersion: string;

  constructor(
    config: ResolvedConfig,
    postFn: PostFunction,
    cwd: string,
    pluginVersion: string = "0.1.0",
  ) {
    this.config = config;
    this.postFn = postFn;
    this._cwd = cwd;
    this._pluginVersion = pluginVersion;

    if (config.batch.enabled) {
      this.startInterval();
    }
  }

  // ─── Public API ─────────────────────────────────────────────────────

  /**
   * Enqueue a record for delivery. Returns immediately.
   * Drops oldest records on overflow.
   */
  enqueue(record: unknown): void {
    if (this.buffer.length >= MAX_PENDING_RECORDS) {
      // Drop oldest
      this.buffer.shift();
      this._overflowCount++;
      this._stats.dropped++;
    }
    this.buffer.push(record);
    this._stats.enqueued++;

    if (this.config.batch.enabled && this.buffer.length >= this.config.batch.maxRecords) {
      this.flush().catch(() => {});
    }
  }

  /**
   * Best-effort flush of pending records. Returns a promise that resolves
   * after the flush attempt (or timeout), but does not throw.
   */
  async flush(timeoutMs?: number): Promise<void> {
    if (this.posting || this.buffer.length === 0) return;

    const batch = this.buffer.splice(0, this.config.batch.maxRecords);
    this.posting = true;

    try {
      const envelope: AnalyticsEnvelope = this.buildEnvelope(batch);

      const result = await this.postWithTimeout(envelope, timeoutMs);
      if (result) {
        this._stats.delivered += batch.length;
      } else {
        this._stats.failed += batch.length;
      }
    } catch {
      this._stats.failed += batch.length;
    } finally {
      this.posting = false;
    }
  }

  /**
   * Flush remaining records and stop the interval timer.
   * Best-effort; does not wait indefinitely.
   */
  async shutdown(): Promise<void> {
    this.stopInterval();
    if (this.buffer.length > 0) {
      // Short timeout for shutdown flush
      await this.flush(2000);
    }
  }

  /** Get current delivery statistics. */
  stats(): QueueStats {
    this._stats.pending = this.buffer.length;
    return { ...this._stats };
  }

  /** Get the overflow drop count for diagnostics. */
  overflowCount(): number {
    return this._overflowCount;
  }

  /** Update configuration at runtime. */
  updateConfig(config: ResolvedConfig): void {
    this.config = config;
    if (!config.batch.enabled) {
      this.stopInterval();
    } else {
      this.startInterval();
    }
  }

  /** Exposed for testing: inject a different post function. */
  setPostFn(fn: PostFunction): void {
    this.postFn = fn;
  }

  // ─── Private ────────────────────────────────────────────────────────

  private buildEnvelope(records: unknown[]): AnalyticsEnvelope {
    return {
      plugin: "pi-conductor-analytics-plugin",
      plugin_version: this._pluginVersion,
      schema_version: 1,
      sent_at: new Date().toISOString(),
      cwd: this._cwd,
      source: "pi.events:conductor:record",
      records,
    };
  }

  private async postWithTimeout(envelope: AnalyticsEnvelope, timeoutMs?: number): Promise<boolean> {
    const effectiveTimeout = timeoutMs ?? this.config.request.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), effectiveTimeout);

    let _lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.config.request.maxRetries; attempt++) {
      try {
        const ok = await this.postFn(envelope, this.config);
        clearTimeout(timer);
        return ok;
      } catch (err) {
        _lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < this.config.request.maxRetries) {
          // Short delay before retry
          await new Promise((r) => setTimeout(r, 100 * (attempt + 1)));
        }
      }
    }
    clearTimeout(timer);
    return false;
  }

  private startInterval(): void {
    this.stopInterval();
    if (this.config.batch.flushIntervalMs > 0) {
      this.flushTimer = setInterval(() => {
        this.flush().catch(() => {});
      }, this.config.batch.flushIntervalMs);
    }
  }

  private stopInterval(): void {
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }
}

// ─── Default POST function ──────────────────────────────────────────────

/**
 * Default HTTP POST implementation using global fetch.
 *
 * Returns `true` for 2xx responses, `false` for non-retryable failures.
 * Throws on network/retryable errors so the caller can retry.
 */
export async function defaultPost(
  envelope: AnalyticsEnvelope,
  config: ResolvedConfig,
): Promise<boolean> {
  const endpoint = config.endpoint;
  if (endpoint === undefined) return false;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...config.headers,
    },
    body: JSON.stringify(envelope),
  });

  if (response.ok) return true;

  const status = response.status;
  // Retryable: 408 Request Timeout, 429 Too Many Requests, 5xx Server Error
  if (status === 408 || status === 429 || (status >= 500 && status < 600)) {
    throw new Error(`HTTP ${status}: retryable response`);
  }

  // Non-retryable: 4xx client errors, 3xx redirects, etc.
  return false;
}
