/**
 * Bounded async delivery queue for non-blocking HTTP POST delivery.
 *
 * Records are enqueued from the `conductor:record` handler and flushed
 * either on batch-size threshold or on a configurable interval.
 * The queue is bounded to prevent unbounded memory growth.
 */

import type {
  AnalyticsEnvelope,
  DeadlineState,
  DeliveryCallback,
  OverflowCallback,
  QueueStats,
  ResolvedConfig,
} from "./types.js";
import { createDeadline } from "./types.js";

// ─── Constants ──────────────────────────────────────────────────────────

/** Default source label for envelopes. */
const DEFAULT_SOURCE = "pi.events:conductor:record";

// ─── Constants ──────────────────────────────────────────────────────────

/** Hard cap on total pending records to prevent unbounded growth. */
const MAX_PENDING_RECORDS = 500;

/** Default rate-limit window for overflow callbacks (ms). */
const OVERFLOW_RATE_LIMIT_MS = 5_000;

// ─── Queue internals ────────────────────────────────────────────────────

type PostFunction = (
  envelope: AnalyticsEnvelope,
  config: ResolvedConfig,
  signal?: AbortSignal,
) => Promise<boolean>;

/**
 * Result of a post attempt with deadline tracking.
 */
export interface PostResult {
  success: boolean;
  reason?: string;
}

/**
 * Internal buffer entry with optional run metadata for watermark tracking.
 */
interface BufferedEntry {
  /** The record data. */
  data: unknown;
  /** Run ID this record belongs to (optional). */
  runId?: string;
  /** Line index in the JSONL file (optional). */
  runIndex?: number;
}

/**
 * Delivery queue with batching, retries, and bounded memory.
 */
export class DeliveryQueue {
  private buffer: BufferedEntry[] = [];
  private posting = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private _stats: QueueStats = { enqueued: 0, delivered: 0, failed: 0, dropped: 0, pending: 0 };
  private _overflowCount = 0;

  // Overflow callback state
  private overflowCallback: OverflowCallback | null = null;
  private lastOverflowNotification: number = 0;
  private suppressedDropsSinceLastNotify = 0;

  // Config snapshot
  private config: ResolvedConfig;
  private postFn: PostFunction;
  private _cwd: string;
  private _pluginVersion: string;
  private _source: string;

  // Delivery callback for watermark updates
  private deliveryCallback: DeliveryCallback | null = null;

  constructor(
    config: ResolvedConfig,
    postFn: PostFunction,
    cwd: string,
    pluginVersion: string = "0.1.0",
    source: string = DEFAULT_SOURCE,
  ) {
    this.config = config;
    this.postFn = postFn;
    this._cwd = cwd;
    this._pluginVersion = pluginVersion;
    this._source = source;

    if (config.batch.enabled) {
      this.startInterval();
    }
  }

  // ─── Public API ─────────────────────────────────────────────────────

  /**
   * Enqueue a record for delivery. Returns immediately.
   * Drops oldest records on overflow.
   *
   * @param record  The record to enqueue.
   */
  enqueue(record: unknown): void {
    this.enqueueEntry({ data: record });
  }

  /**
   * Enqueue a record with run metadata for watermark tracking.
   *
   * Use this method when enqueueing records from JSONL backfill
   * so that watermarks can be updated after successful delivery.
   *
   * @param record    The record to enqueue.
   * @param runId     The run ID this record belongs to.
   * @param runIndex  The line index of this record in the JSONL file.
   */
  enqueueFromRun(record: unknown, runId: string, runIndex: number): void {
    this.enqueueEntry({ data: record, runId, runIndex });
  }

  /**
   * Internal enqueue helper for BufferedEntry.
   */
  private enqueueEntry(entry: BufferedEntry): void {
    if (this.buffer.length >= MAX_PENDING_RECORDS) {
      // Drop oldest
      this.buffer.shift();
      this._overflowCount++;
      this._stats.dropped++;
      this._notifyOverflow();
    }
    this.buffer.push(entry);
    this._stats.enqueued++;

    if (this.config.batch.enabled && this.buffer.length >= this.config.batch.maxRecords) {
      this.flush().catch(() => {});
    }
  }

  /**
   * Best-effort flush of pending records. Returns a promise that resolves
   * after the flush attempt (or timeout), but does not throw.
   *
   * @param deadlineMs  Optional deadline override in ms. Uses config timeoutMs if not provided.
   */
  async flush(deadlineMs?: number): Promise<void> {
    if (this.posting || this.buffer.length === 0) return;

    // Use provided deadline or fall back to config timeout
    const deadline = createDeadline(deadlineMs ?? this.config.request.timeoutMs);
    const batch = this.buffer.splice(0, this.config.batch.maxRecords);
    this.posting = true;

    try {
      const { envelope, runId, runIndices } = this.buildEnvelope(batch);

      const result = await this.postWithDeadline(envelope, deadline);
      if (result.success) {
        this._stats.delivered += batch.length;
        // Notify delivery callback for watermark updates
        // Always call callback (with null runId if no run metadata)
        if (this.deliveryCallback) {
          this.deliveryCallback(
            runId,
            batch.length,
            runIndices.length > 0 ? runIndices : undefined,
          );
        }
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
   *
   * Uses a single **overall** 2-second deadline for the entire shutdown flush,
   * not a per-batch timeout. If a flush is already in progress, waits for it
   * (up to 5 seconds) before starting the final flush.
   */
  async shutdown(): Promise<void> {
    this.stopInterval();

    // Wait for any in-progress flush to complete, with defensive deadline
    const waitForPosting = Date.now();
    while (this.posting) {
      if (Date.now() - waitForPosting > 5000) {
        // Safety: if posting is stuck for > 5s, abandon and reset so we can flush
        this.posting = false;
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }

    // Single overall 2-second deadline for the entire shutdown flush
    const shutdownDeadline = createDeadline(2000);
    while (this.buffer.length > 0) {
      if (shutdownDeadline.isExceeded()) break;
      const remaining = shutdownDeadline.remaining();
      await this.flush(remaining);
    }
  }

  /**
   * Reset the overflow notification window.
   *
   * Call this after the queue drains (pending returns to 0) to ensure
   * a subsequent overflow is reported immediately rather than rate-limited.
   */
  resetOverflowNotification(): void {
    this.lastOverflowNotification = 0;
    this.suppressedDropsSinceLastNotify = 0;
  }

  /** Get current delivery statistics. */
  stats(): QueueStats {
    this._stats.pending = this.buffer.length;
    return { ...this._stats };
  }

  /**
   * Set an overflow callback.
   *
   * The callback is invoked synchronously on the first overflow event,
   * then rate-limited (default 5 seconds) for subsequent events.
   * Suppressed drop counts are accumulated and reported on the next
   * non-suppressed callback.
   *
   * The callback must not throw or await.
   */
  setOverflowCallback(cb: OverflowCallback): void {
    this.overflowCallback = cb;
  }

  /** Get the overflow drop count for diagnostics. */
  overflowCount(): number {
    return this._overflowCount;
  }

  /**
   * Set a delivery callback invoked after successful batch delivery.
   *
   * This enables delivery-aware watermark updates. The callback receives
   * the run ID and count of records in the batch.
   *
   * The callback must not throw or await.
   */
  setDeliveryCallback(cb: DeliveryCallback): void {
    this.deliveryCallback = cb;
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

  /**
   * Build an envelope from a batch, collecting run metadata.
   *
   * @param batch  The buffered entries to include.
   * @returns Object containing the envelope and collected run metadata.
   */
  private buildEnvelope(batch: BufferedEntry[]): {
    envelope: AnalyticsEnvelope;
    runId: string | null;
    runIndices: number[];
  } {
    const records = batch.map((entry) => entry.data);

    // Collect run metadata from all entries
    // If all entries have the same runId, propagate it to the envelope
    const runIds = new Set<string>();
    const runIndices: number[] = [];

    for (const entry of batch) {
      if (entry.runId) {
        runIds.add(entry.runId);
      }
      if (entry.runIndex !== undefined) {
        runIndices.push(entry.runIndex);
      }
    }

    // Use the run ID if all entries are from the same run
    const runId = runIds.size === 1 ? [...runIds][0] : null;

    const envelope: AnalyticsEnvelope = {
      plugin: "pi-conductor-analytics-plugin",
      plugin_version: this._pluginVersion,
      schema_version: 1,
      sent_at: new Date().toISOString(),
      cwd: this._cwd,
      source: this._source,
      records,
    };

    // Only add run metadata if there's a single run ID
    if (runId !== null && runId !== undefined) {
      envelope.run_id = runId;
      if (runIndices.length > 0) {
        envelope.run_indices = runIndices;
      }
    }

    return { envelope, runId: runId ?? null, runIndices };
  }

  /**
   * Calculate exponential backoff delay with jitter.
   *
   * Backoff delays follow the spec formula: min(100 * 2^attempt, maxDelay)
   * where attempt starts at 0 for the first retry.
   * Example: baseDelay=100, maxDelay=2000:
   *   - First retry (attempt=0): 100ms
   *   - Second retry (attempt=1): 200ms
   *   - Third retry (attempt=2): 400ms
   *   - Fourth retry (attempt=3): 800ms
   *   - Fifth retry (attempt=4): 1600ms
   *   - And so on, capped at maxDelay.
   *
   * @param attempt    Zero-based retry attempt number (0 = first retry).
   * @param baseDelay  Base delay in ms (default: 100).
   * @param maxDelay   Maximum delay cap in ms (default: 2000).
   * @param jitter     Jitter factor (0-1), fraction of delay added as random noise.
   * @returns Delay in ms.
   */
  private calculateBackoffDelay(
    attempt: number,
    baseDelay: number,
    maxDelay: number,
    jitter: number,
  ): number {
    // Spec formula: baseDelay * 2^attempt, capped at maxDelay
    // attempt=0 gives baseDelay (100ms), attempt=1 gives 200ms, etc.
    const exponentialDelay = baseDelay * 2 ** attempt;
    // Cap at maxDelay
    const cappedDelay = Math.min(exponentialDelay, maxDelay);
    // Add jitter to prevent thundering herd (jitterFactor=0 means no jitter)
    const jitterAmount = cappedDelay * jitter * Math.random();
    return Math.round(cappedDelay + jitterAmount);
  }

  /**
   * Post with deadline tracking and exponential backoff.
   *
   * Retries with exponential backoff until either:
   * - The request succeeds (returns true)
   * - The deadline is exceeded
   * - All retries are exhausted
   *
   * The backoff delay is applied **before** each retry attempt, as specified:
   * `min(100 * 2 ** attempt, 2_000)` milliseconds before retry attempt `attempt + 1`.
   *
   * @param envelope  The envelope to post.
   * @param deadline   Deadline tracking state.
   * @returns PostResult indicating success/failure.
   */
  private async postWithDeadline(
    envelope: AnalyticsEnvelope,
    deadline: DeadlineState,
  ): Promise<PostResult> {
    const { baseDelayMs, maxDelayMs, jitterFactor } = this.config.request.retry;
    const maxRetries = this.config.request.maxRetries;
    const perRequestTimeout = this.config.request.timeoutMs;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Check deadline before starting attempt
      if (deadline.isExceeded()) {
        return { success: false, reason: "deadline_exceeded" };
      }

      // Apply capped exponential backoff BEFORE the retry attempt, not after.
      // Spec: min(100 * 2^attempt, 2000) ms before retry attempt+1.
      if (attempt > 0) {
        // attempt-1 because the formula's 'attempt' is zero-based for the first retry
        const delay = this.calculateBackoffDelay(
          attempt - 1,
          baseDelayMs,
          maxDelayMs,
          jitterFactor,
        );

        // Check if we have time for the delay before starting this retry
        const remainingAfterDelay = deadline.remaining();
        if (remainingAfterDelay <= delay) {
          // Not enough time to wait — deadline would be exceeded
          return { success: false, reason: "deadline_exceeded" };
        }

        // Sleep for the backoff delay
        await new Promise((r) => setTimeout(r, delay));
      }

      // Calculate remaining time AFTER any delays to ensure accurate deadline tracking
      const remaining = deadline.remaining();
      if (remaining === 0) {
        return { success: false, reason: "deadline_exceeded" };
      }

      // Create abort controller for this attempt
      const controller = new AbortController();
      // Use remaining deadline as timeout if less than per-request timeout
      const requestTimeout =
        remaining > 0 && remaining < perRequestTimeout ? remaining : perRequestTimeout;
      const timer = setTimeout(() => controller.abort(), requestTimeout);

      try {
        // Pass the abort signal to the post function so it can abort on timeout
        const ok = await this.postFn(envelope, this.config, controller.signal);
        clearTimeout(timer);

        if (ok) {
          return { success: true };
        }

        // Non-retryable response (4xx, 3xx): return false, do not retry
        return { success: false, reason: "non_retryable" };
      } catch {
        clearTimeout(timer);
        // Retryable error (network failure, timeout, 5xx, 408, 429): continue loop
      }
    }

    return { success: false, reason: "retries_exhausted" };
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

  private _notifyOverflow(): void {
    const cb = this.overflowCallback;
    if (!cb) return;

    const now = Date.now();
    const suppressed = this.suppressedDropsSinceLastNotify;

    if (now - this.lastOverflowNotification >= OVERFLOW_RATE_LIMIT_MS) {
      // Not suppressed — notify and reset
      this.lastOverflowNotification = now;
      this.suppressedDropsSinceLastNotify = 0;
      try {
        cb(this._overflowCount, this.buffer.length, suppressed);
      } catch {
        // Guarded: observer errors must not affect enqueue
      }
    } else {
      // Rate-limited — aggregate suppressed drops
      this.suppressedDropsSinceLastNotify++;
    }
  }
}

// ─── Default POST function ──────────────────────────────────────────────

/**
 * Default HTTP POST implementation using global fetch.
 *
 * Returns `true` for 2xx responses, `false` for non-retryable failures.
 * Throws on network/retryable errors so the caller can retry.
 *
 * @param envelope  The envelope to POST.
 * @param config    The resolved config (provides endpoint and headers).
 * @param signal    Optional AbortSignal to cancel the request on deadline/abort.
 */
export async function defaultPost(
  envelope: AnalyticsEnvelope,
  config: ResolvedConfig,
  signal?: AbortSignal,
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
    signal,
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
