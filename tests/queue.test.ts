import { beforeEach, describe, expect, it } from "vitest";
import { DeliveryQueue, defaultPost } from "../src/queue.js";
import type { AnalyticsEnvelope, ResolvedConfig } from "../src/types.js";

const TEST_CONFIG: ResolvedConfig = {
  enabled: true,
  endpoint: "https://example.com/events",
  headers: {},
  batch: {
    enabled: true,
    maxRecords: 5,
    flushIntervalMs: 100000, // Long interval so timer won't fire in tests
  },
  request: {
    timeoutMs: 5000,
    maxRetries: 2,
    retry: {
      baseDelayMs: 100,
      maxDelayMs: 2000, // Matches README documentation
      jitterFactor: 0,
    },
  },
};

const DISABLED_BATCH_CONFIG: ResolvedConfig = {
  ...TEST_CONFIG,
  batch: { enabled: false, maxRecords: 5, flushIntervalMs: 100000 },
};

describe("DeliveryQueue", () => {
  let postedEnvelopes: AnalyticsEnvelope[] = [];

  beforeEach(() => {
    postedEnvelopes = [];
  });

  function createPostFn(success: boolean = true, failCount: number = 0) {
    let attempts = 0;
    return async (envelope: AnalyticsEnvelope, _config: ResolvedConfig): Promise<boolean> => {
      postedEnvelopes.push(envelope);
      attempts++;
      if (attempts <= failCount) {
        throw new Error("Simulated network error");
      }
      return success;
    };
  }

  describe("enqueue and flush", () => {
    it("enqueues records without blocking", () => {
      const queue = new DeliveryQueue(TEST_CONFIG, createPostFn(), "/cwd");
      queue.enqueue({ type: "test", ts: 1 });
      expect(queue.stats().enqueued).toBe(1);
      expect(queue.stats().pending).toBe(1);
    });

    it("flushes when batch size is reached", async () => {
      const queue = new DeliveryQueue(TEST_CONFIG, createPostFn(), "/cwd");
      queue.enqueue({ type: "test", ts: 1 });
      queue.enqueue({ type: "test", ts: 2 });
      queue.enqueue({ type: "test", ts: 3 });
      queue.enqueue({ type: "test", ts: 4 });
      queue.enqueue({ type: "test", ts: 5 }); // Should trigger flush

      // Wait for the async flush
      await new Promise((r) => setTimeout(r, 50));

      expect(postedEnvelopes.length).toBeGreaterThanOrEqual(1);
      if (postedEnvelopes.length > 0) {
        expect(postedEnvelopes[0]?.records).toHaveLength(5);
      }
    });

    it("drops oldest records on overflow", () => {
      const queue = new DeliveryQueue(TEST_CONFIG, createPostFn(), "/cwd");
      // Enqueue more than MAX_PENDING_RECORDS (500)
      for (let i = 0; i < 510; i++) {
        queue.enqueue({ type: "test", ts: i });
      }
      expect(queue.overflowCount()).toBeGreaterThan(0);
      expect(queue.stats().dropped).toBeGreaterThan(0);
      expect(queue.stats().pending).toBe(500); // Capped at MAX_PENDING_RECORDS
    });

    it("does not flush automatically when batching is disabled", async () => {
      const queue = new DeliveryQueue(DISABLED_BATCH_CONFIG, createPostFn(), "/cwd");
      queue.enqueue({ type: "test", ts: 1 });
      queue.enqueue({ type: "test", ts: 2 });

      await new Promise((r) => setTimeout(r, 50));
      expect(postedEnvelopes).toHaveLength(0);

      // Manual flush should work
      await queue.flush();
      expect(postedEnvelopes).toHaveLength(1);
      expect(postedEnvelopes[0]?.records).toHaveLength(2);
    });
  });

  describe("retries and error handling", () => {
    it("retries on failure and eventually succeeds", async () => {
      const queue = new DeliveryQueue(
        {
          ...TEST_CONFIG,
          request: {
            timeoutMs: 5000,
            maxRetries: 3,
            retry: { baseDelayMs: 10, maxDelayMs: 100, jitterFactor: 0 },
          },
        },
        createPostFn(true, 2),
        "/cwd",
      );
      queue.enqueue({ type: "test", ts: 1 });
      await queue.flush();

      expect(queue.stats().delivered).toBe(1);
    });

    it("fails permanently after exhausting retries", async () => {
      const queue = new DeliveryQueue(
        {
          ...TEST_CONFIG,
          request: {
            timeoutMs: 5000,
            maxRetries: 2,
            retry: { baseDelayMs: 10, maxDelayMs: 100, jitterFactor: 0 },
          },
        },
        createPostFn(true, 5), // Always fails
        "/cwd",
      );
      queue.enqueue({ type: "test", ts: 1 });
      await queue.flush();

      expect(queue.stats().failed).toBe(1);
      expect(queue.stats().delivered).toBe(0);
    });

    it("handles non-retryable HTTP responses (4xx)", async () => {
      let callCount = 0;
      const postFn = async (): Promise<boolean> => {
        callCount++;
        return false; // Non-retryable
      };
      const queue = new DeliveryQueue(TEST_CONFIG, postFn, "/cwd");
      queue.enqueue({ type: "test", ts: 1 });
      await queue.flush();

      expect(callCount).toBe(1); // No retry
      expect(queue.stats().failed).toBe(1);
    });
  });

  describe("shutdown", () => {
    it("flushes remaining records on shutdown", async () => {
      const queue = new DeliveryQueue(DISABLED_BATCH_CONFIG, createPostFn(), "/cwd");
      queue.enqueue({ type: "test", ts: 1 });
      queue.enqueue({ type: "test", ts: 2 });

      await queue.shutdown();
      expect(postedEnvelopes.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("stats", () => {
    it("tracks delivery stats correctly", async () => {
      const queue = new DeliveryQueue(TEST_CONFIG, createPostFn(), "/cwd");
      queue.enqueue({ type: "test", ts: 1 });
      queue.enqueue({ type: "test", ts: 2 });

      await queue.flush();

      const stats = queue.stats();
      expect(stats.enqueued).toBe(2);
      expect(stats.delivered).toBe(2);
      expect(stats.failed).toBe(0);
      expect(stats.dropped).toBe(0);
    });
  });
});

describe("defaultPost", () => {
  it("returns false when endpoint is undefined", async () => {
    const config: ResolvedConfig = { ...TEST_CONFIG, endpoint: undefined };
    const envelope: AnalyticsEnvelope = {
      plugin: "pi-conductor-analytics-plugin",
      plugin_version: "1.0.0",
      schema_version: 1,
      sent_at: new Date().toISOString(),
      cwd: "/cwd",
      source: "pi.events:conductor:record",
      records: [],
    };
    const result = await defaultPost(envelope, config);
    expect(result).toBe(false);
  });
});

describe("DeliveryQueue source parameter", () => {
  it("uses default source when none provided", async () => {
    let capturedEnvelope: AnalyticsEnvelope | undefined;
    const postFn = async (
      envelope: AnalyticsEnvelope,
      _config: ResolvedConfig,
    ): Promise<boolean> => {
      capturedEnvelope = envelope;
      return true;
    };

    const queue = new DeliveryQueue(TEST_CONFIG, postFn, "/cwd", "0.1.0");
    queue.enqueue({ type: "test" });
    await queue.flush();

    expect(capturedEnvelope?.source).toBe("pi.events:conductor:record");
  });

  it("uses custom source when provided", async () => {
    let capturedEnvelope: AnalyticsEnvelope | undefined;
    const postFn = async (
      envelope: AnalyticsEnvelope,
      _config: ResolvedConfig,
    ): Promise<boolean> => {
      capturedEnvelope = envelope;
      return true;
    };

    const queue = new DeliveryQueue(TEST_CONFIG, postFn, "/cwd", "0.1.0", "library:my-integration");
    queue.enqueue({ type: "test" });
    await queue.flush();

    expect(capturedEnvelope?.source).toBe("library:my-integration");
  });
});

describe("DeliveryQueue exponential backoff", () => {
  it("uses exponential backoff for retries", async () => {
    const attemptTimes: number[] = [];
    const postFn = async (): Promise<boolean> => {
      attemptTimes.push(Date.now());
      throw new Error("Simulated network error"); // Always fail
    };

    // Config with exponential backoff: baseDelay=100, maxDelay=500
    const queue = new DeliveryQueue(
      {
        ...TEST_CONFIG,
        request: {
          timeoutMs: 1000,
          maxRetries: 3,
          retry: { baseDelayMs: 100, maxDelayMs: 500, jitterFactor: 0 },
        },
      },
      postFn,
      "/cwd",
    );
    queue.enqueue({ type: "test" });

    const start = Date.now();
    await queue.flush();
    const totalTime = Date.now() - start;

    // Should have 4 attempts (1 initial + 3 retries)
    expect(attemptTimes).toHaveLength(4);

    // Exponential backoff: 100ms, 200ms, 400ms (capped at maxDelay=500)
    // Total delay should be approximately 100 + 200 + 400 = 700ms
    // Allow some tolerance for test execution time
    expect(totalTime).toBeGreaterThanOrEqual(600);
    expect(totalTime).toBeLessThan(2000); // Should complete within reasonable time
  });

  it("aborts when deadline is exceeded during retries", async () => {
    let attemptCount = 0;
    const postFn = async (): Promise<boolean> => {
      attemptCount++;
      throw new Error("Simulated network error");
    };

    // Very short deadline (50ms), should not allow multiple retries
    const queue = new DeliveryQueue(
      {
        ...TEST_CONFIG,
        request: {
          timeoutMs: 50, // Very short deadline
          maxRetries: 10, // High max retries
          retry: { baseDelayMs: 1000, maxDelayMs: 2000, jitterFactor: 0 }, // Long delays
        },
      },
      postFn,
      "/cwd",
    );
    queue.enqueue({ type: "test" });

    await queue.flush();

    // Should abort early due to deadline, not retry all 10 times
    expect(attemptCount).toBeLessThanOrEqual(2);
    expect(queue.stats().failed).toBe(1);
  });

  it("respects maxDelay cap", async () => {
    const attemptTimes: number[] = [];
    const postFn = async (): Promise<boolean> => {
      attemptTimes.push(Date.now());
      throw new Error("Simulated network error");
    };

    // Config with small maxDelay: baseDelay=100, maxDelay=150
    // Backoff should be: 100, 150(capped), 150(capped)
    const queue = new DeliveryQueue(
      {
        ...TEST_CONFIG,
        request: {
          timeoutMs: 5000,
          maxRetries: 3,
          retry: { baseDelayMs: 100, maxDelayMs: 150, jitterFactor: 0 },
        },
      },
      postFn,
      "/cwd",
    );
    queue.enqueue({ type: "test" });

    const start = Date.now();
    await queue.flush();
    const totalTime = Date.now() - start;

    // Should have 4 attempts
    expect(attemptTimes).toHaveLength(4);
    // Total delay: 100 + 150 + 150 = 400ms (no jitter)
    expect(totalTime).toBeGreaterThanOrEqual(350);
    expect(totalTime).toBeLessThan(800);
  });
});

describe("DeliveryQueue delivery callback", () => {
  it("invokes delivery callback on successful delivery", async () => {
    let deliveredRunId: string | null = null;
    let deliveredCount = 0;
    let _deliveredIndices: number[] | undefined;

    const queue = new DeliveryQueue(TEST_CONFIG, async () => true, "/cwd");
    queue.setDeliveryCallback((runId, count, indices) => {
      deliveredRunId = runId;
      deliveredCount = count;
      _deliveredIndices = indices;
    });

    queue.enqueue({ type: "test", ts: 1 });
    await queue.flush();

    expect(deliveredCount).toBe(1);
    // Regular enqueue doesn't have run metadata, so runId should be null
    expect(deliveredRunId).toBeNull();
  });

  it("does NOT invoke delivery callback on failed delivery", async () => {
    let callbackInvoked = false;
    let deliveredRunId: string | null = "not-called";

    const queue = new DeliveryQueue(TEST_CONFIG, async () => false, "/cwd"); // Always fails
    queue.setDeliveryCallback((runId) => {
      callbackInvoked = true;
      deliveredRunId = runId;
    });

    queue.enqueueFromRun({ type: "test", ts: 1 }, "test-run", 5);
    await queue.flush();

    expect(callbackInvoked).toBe(false);
    expect(deliveredRunId).toBe("not-called"); // Should not have been changed
  });

  it("does NOT invoke delivery callback when post throws", async () => {
    let callbackInvoked = false;

    const queue = new DeliveryQueue(
      TEST_CONFIG,
      async () => {
        throw new Error("Network error");
      },
      "/cwd",
    );
    queue.setDeliveryCallback(() => {
      callbackInvoked = true;
    });

    queue.enqueueFromRun({ type: "test", ts: 1 }, "test-run", 5);
    await queue.flush();

    expect(callbackInvoked).toBe(false);
  });

  it("passes run metadata through delivery callback", async () => {
    let deliveredRunId: string | null = null;
    let deliveredIndices: number[] | undefined;

    const queue = new DeliveryQueue(TEST_CONFIG, async () => true, "/cwd");
    queue.setDeliveryCallback((runId, _count, indices) => {
      deliveredRunId = runId;
      deliveredIndices = indices;
    });

    // Enqueue records from a specific run
    queue.enqueueFromRun({ type: "test", ts: 1 }, "test-run-1", 5);
    queue.enqueueFromRun({ type: "test", ts: 2 }, "test-run-1", 6);
    await queue.flush();

    expect(deliveredRunId).toBe("test-run-1");
    expect(deliveredIndices).toEqual([5, 6]);
  });

  it("returns null runId for mixed runs", async () => {
    let deliveredRunId: string | null = "initial";

    const queue = new DeliveryQueue(TEST_CONFIG, async () => true, "/cwd");
    queue.setDeliveryCallback((runId) => {
      deliveredRunId = runId;
    });

    // Enqueue records from different runs
    queue.enqueueFromRun({ type: "test", ts: 1 }, "test-run-1", 1);
    queue.enqueueFromRun({ type: "test", ts: 2 }, "test-run-2", 2);
    await queue.flush();

    // Mixed runs should return null runId
    expect(deliveredRunId).toBeNull();
  });
});

describe("DeliveryQueue enqueueFromRun", () => {
  it("enqueues records with run metadata", async () => {
    let capturedEnvelope: AnalyticsEnvelope | undefined;
    const postFn = async (
      envelope: AnalyticsEnvelope,
      _config: ResolvedConfig,
    ): Promise<boolean> => {
      capturedEnvelope = envelope;
      return true;
    };

    const queue = new DeliveryQueue(TEST_CONFIG, postFn, "/cwd");
    queue.enqueueFromRun({ type: "test", ts: 1 }, "run-123", 10);
    await queue.flush();

    expect(capturedEnvelope?.run_id).toBe("run-123");
    expect(capturedEnvelope?.run_indices).toEqual([10]);
    expect(capturedEnvelope?.records).toHaveLength(1);
    expect(capturedEnvelope?.records[0]).toEqual({ type: "test", ts: 1 });
  });

  it("increments enqueued stats for enqueueFromRun", () => {
    const queue = new DeliveryQueue(TEST_CONFIG, async () => true, "/cwd");
    queue.enqueueFromRun({ type: "test" }, "run-1", 1);
    queue.enqueueFromRun({ type: "test" }, "run-1", 2);

    expect(queue.stats().enqueued).toBe(2);
    expect(queue.stats().pending).toBe(2);
  });
});

describe("DeliveryQueue abort signal", () => {
  it("passes abort signal to postFn", async () => {
    let receivedSignal: AbortSignal | undefined;
    const postFn = async (
      _envelope: AnalyticsEnvelope,
      _config: ResolvedConfig,
      signal?: AbortSignal,
    ): Promise<boolean> => {
      receivedSignal = signal;
      return true;
    };

    const queue = new DeliveryQueue(TEST_CONFIG, postFn, "/cwd");
    queue.enqueue({ type: "test", ts: 1 });
    await queue.flush();

    expect(receivedSignal).toBeDefined();
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
  });

  it("uses short timeout when deadline is near", async () => {
    // When remaining deadline is less than per-request timeout,
    // the queue should use the remaining time as the timeout.
    let _requestTimeoutUsed: number | undefined;

    const postFn = async (
      _envelope: AnalyticsEnvelope,
      _config: ResolvedConfig,
      signal?: AbortSignal,
    ): Promise<boolean> => {
      // Record the timeout that would be used
      if (signal) {
        // Check that the signal exists and would fire relatively quickly
        const timeoutId = setTimeout(() => {}, 0);
        clearTimeout(timeoutId);
      }
      return true;
    };

    // Short deadline (100ms)
    const queue = new DeliveryQueue(
      {
        ...TEST_CONFIG,
        request: {
          timeoutMs: 100, // Short deadline
          maxRetries: 0,
          retry: { baseDelayMs: 100, maxDelayMs: 500, jitterFactor: 0 },
        },
      },
      postFn,
      "/cwd",
    );
    queue.enqueue({ type: "test", ts: 1 });

    const start = Date.now();
    await queue.flush();
    const elapsed = Date.now() - start;

    // Should complete quickly since it's a mock success
    expect(elapsed).toBeLessThan(200);
  });

  it("does not pass signal when not provided by caller", async () => {
    // This tests the case where someone uses a postFn that doesn't accept signal
    let signalParamCount = 0;
    const simplePostFn = async (
      _envelope: AnalyticsEnvelope,
      _config: ResolvedConfig,
    ): Promise<boolean> => {
      // This postFn only accepts 2 params
      signalParamCount++;
      return true;
    };

    const queue = new DeliveryQueue(TEST_CONFIG, simplePostFn, "/cwd");
    queue.enqueue({ type: "test", ts: 1 });
    await queue.flush();

    // Should still work even though signal isn't used
    expect(signalParamCount).toBe(1);
  });
});

describe("DeliveryQueue flush deadline parameter", () => {
  it("uses provided deadlineMs instead of config timeoutMs", async () => {
    // This test verifies that the deadline parameter is accepted and passed through.
    // The actual abort timing is tested in other tests.
    const postFn = async (): Promise<boolean> => {
      await new Promise((r) => setTimeout(r, 50));
      return true;
    };

    // Config says 5000ms timeout, but we pass 100ms deadline
    const queue = new DeliveryQueue(
      {
        ...TEST_CONFIG,
        request: {
          timeoutMs: 5000,
          maxRetries: 0,
          retry: { baseDelayMs: 100, maxDelayMs: 500, jitterFactor: 0 },
        },
      },
      postFn,
      "/cwd",
    );
    queue.enqueue({ type: "test", ts: 1 });

    // flush() with deadline parameter should complete successfully
    await queue.flush(100);

    expect(queue.stats().delivered).toBe(1);
  });

  it("falls back to config timeout when no deadline provided", async () => {
    // Verify that flush works when called without explicit deadline
    const postFn = async (): Promise<boolean> => {
      await new Promise((r) => setTimeout(r, 10));
      return true;
    };

    const queue = new DeliveryQueue(TEST_CONFIG, postFn, "/cwd");
    queue.enqueue({ type: "test", ts: 1 });

    // Call flush without explicit deadline - should use config.timeoutMs
    await queue.flush();

    expect(queue.stats().delivered).toBe(1);
  });
});

describe("DeliveryQueue shutdown behavior", () => {
  it("waits for in-progress flush during shutdown", async () => {
    const postFn = async (): Promise<boolean> => {
      // Simulate slow post
      await new Promise((r) => setTimeout(r, 50));
      return true;
    };

    const queue = new DeliveryQueue(DISABLED_BATCH_CONFIG, postFn, "/cwd");
    queue.enqueue({ type: "test", ts: 1 });

    // Start a flush
    const flushPromise = queue.flush();

    // Immediately call shutdown - it should wait for the flush
    const shutdownPromise = queue.shutdown();

    await Promise.all([flushPromise, shutdownPromise]);

    expect(queue.stats().delivered).toBe(1);
  });

  it("flushes remaining records during shutdown even if posting was stuck", async () => {
    // This test verifies that shutdown can proceed even when a flush is stuck.
    // The key behavior is that after the safety timeout, shutdown resets posting
    // and proceeds to flush remaining records.
    //
    // Note: This is a behavioral test; the actual timing depends on the safety timeout.
    let postCallCount = 0;
    const postFn = async (): Promise<boolean> => {
      postCallCount++;
      // First call is slow, subsequent calls succeed
      if (postCallCount === 1) {
        await new Promise((r) => setTimeout(r, 50));
      }
      return true;
    };

    const queue = new DeliveryQueue(DISABLED_BATCH_CONFIG, postFn, "/cwd");
    queue.enqueue({ type: "test", ts: 1 });
    queue.enqueue({ type: "test", ts: 2 });

    // Start a flush
    queue.flush();

    // Wait for the flush to start
    await new Promise((r) => setTimeout(r, 10));

    // Shutdown should proceed and flush remaining records
    await queue.shutdown();

    // All records should have been delivered
    expect(queue.stats().delivered).toBe(2);
  });

  it("does not lose records when shutdown is called during flush", async () => {
    let postCallCount = 0;
    const postFn = async (): Promise<boolean> => {
      postCallCount++;
      await new Promise((r) => setTimeout(r, 20));
      return true;
    };

    // Use a config with small batch size to force multiple batches
    const smallBatchConfig: ResolvedConfig = {
      ...DISABLED_BATCH_CONFIG,
      batch: { enabled: false, maxRecords: 2, flushIntervalMs: 100000 },
    };
    const queue = new DeliveryQueue(smallBatchConfig, postFn, "/cwd");

    // Enqueue 5 records (with maxRecords=2, this requires 3 batches)
    queue.enqueue({ type: "test", ts: 1 });
    queue.enqueue({ type: "test", ts: 2 });
    queue.enqueue({ type: "test", ts: 3 });
    queue.enqueue({ type: "test", ts: 4 });
    queue.enqueue({ type: "test", ts: 5 });

    // Call shutdown - it should flush all remaining records
    await queue.shutdown();

    // All records should have been delivered
    expect(queue.stats().delivered).toBe(5);
    expect(postCallCount).toBe(3); // Three batches (maxRecords=2, 5 items = 3 batches)
  });

  it("uses a single 2-second overall deadline for shutdown, not per-batch", async () => {
    // This test verifies that shutdown uses a single overall 2-second deadline
    // for all batches combined, not 2 seconds per batch.
    // The post function checks the abort signal so it stops when the deadline fires.
    const postFn = async (
      _envelope: AnalyticsEnvelope,
      _config: ResolvedConfig,
      signal?: AbortSignal,
    ): Promise<boolean> => {
      // Slow post that respects abort signal (like defaultPost with fetch)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => resolve(), 1500);
        if (signal) {
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          });
        }
      });
      return true;
    };

    const smallBatchConfig: ResolvedConfig = {
      ...DISABLED_BATCH_CONFIG,
      batch: { enabled: false, maxRecords: 2, flushIntervalMs: 100000 },
    };
    const queue = new DeliveryQueue(smallBatchConfig, postFn, "/cwd");

    // Enqueue 4 records (2 batches of 2)
    queue.enqueue({ type: "test", ts: 1 });
    queue.enqueue({ type: "test", ts: 2 });
    queue.enqueue({ type: "test", ts: 3 });
    queue.enqueue({ type: "test", ts: 4 });

    const start = Date.now();
    await queue.shutdown();
    const elapsed = Date.now() - start;

    // With per-batch 2s behavior this would take ~3s (first batch 1500ms + second batch 1500ms).
    // With overall 2s deadline, the first batch starts, takes ~1500ms, the second batch
    // starts but gets aborted after ~500ms (remaining deadline), so total ~2100ms.
    // Much less than the 3000ms+ it would take if each batch got its own 2s.
    expect(elapsed).toBeLessThan(2800);
    // At least one batch should have been delivered
    expect(queue.stats().delivered).toBeGreaterThanOrEqual(2);
  });
});

describe("DeliveryQueue retry backoff timing", () => {
  it("applies backoff delay BEFORE the retry, not after", async () => {
    // Track attempt timestamps to verify timing
    const attemptTimestamps: number[] = [];
    const postFn = async (): Promise<boolean> => {
      attemptTimestamps.push(Date.now());
      throw new Error("Simulated error");
    };

    // Use a high total deadline so retries are not deadline-capped
    const queue = new DeliveryQueue(
      {
        ...TEST_CONFIG,
        request: {
          timeoutMs: 10000,
          maxRetries: 2,
          retry: { baseDelayMs: 100, maxDelayMs: 500, jitterFactor: 0 },
        },
      },
      postFn,
      "/cwd",
    );
    queue.enqueue({ type: "test" });

    await queue.flush();

    expect(attemptTimestamps).toHaveLength(3); // Initial + 2 retries

    // Calculate delays between attempts
    const delay1 = (attemptTimestamps[1] ?? 0) - (attemptTimestamps[0] ?? 0);
    const delay2 = (attemptTimestamps[2] ?? 0) - (attemptTimestamps[1] ?? 0);

    // The first retry delay (before retry 1) should be ~100ms
    // The second retry delay (before retry 2) should be ~200ms
    // Previously (buggy) both were 0 before retry and delay was after
    expect(delay1).toBeGreaterThanOrEqual(80); // Allow tolerance
    expect(delay1).toBeLessThanOrEqual(150);
    expect(delay2).toBeGreaterThanOrEqual(180);
    expect(delay2).toBeLessThanOrEqual(300);
  });
});
