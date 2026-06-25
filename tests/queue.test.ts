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
        { ...TEST_CONFIG, request: { timeoutMs: 5000, maxRetries: 3 } },
        createPostFn(true, 2),
        "/cwd",
      );
      queue.enqueue({ type: "test", ts: 1 });
      await queue.flush();

      expect(queue.stats().delivered).toBe(1);
    });

    it("fails permanently after exhausting retries", async () => {
      const queue = new DeliveryQueue(
        { ...TEST_CONFIG, request: { timeoutMs: 5000, maxRetries: 2 } },
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
