import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DeliveryQueue } from "../src/queue.js";
import type { ResolvedConfig } from "../src/types.js";
import { runBackstop } from "../src/watermark.js";

describe("watermark / backstop", () => {
  let tmpDir: string;
  let runsDir: string;
  let enqueued: unknown[] = [];

  const TEST_CONFIG: ResolvedConfig = {
    enabled: true,
    endpoint: "https://example.com/events",
    headers: {},
    batch: { enabled: false, maxRecords: 25, flushIntervalMs: 100000 },
    request: {
      timeoutMs: 5000,
      maxRetries: 0,
      retry: { baseDelayMs: 200, maxDelayMs: 5000, jitterFactor: 0 },
    },
  };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-analytics-wm-"));
    runsDir = join(tmpDir, ".pi-conductor", "runs");
    mkdirSync(runsDir, { recursive: true });
    enqueued = [];
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createTestQueue(success = true): DeliveryQueue {
    const queue = new DeliveryQueue(TEST_CONFIG, async () => success, tmpDir);
    // Override both enqueue and enqueueFromRun to track records.
    // runBackstop uses enqueueFromRun to preserve run metadata.
    const origEnqueue = queue.enqueue.bind(queue);
    const origEnqueueFromRun = queue.enqueueFromRun.bind(queue);
    queue.enqueue = (record: unknown) => {
      enqueued.push(record);
      origEnqueue(record);
    };
    queue.enqueueFromRun = (record: unknown, runId: string, runIndex: number) => {
      enqueued.push(record);
      origEnqueueFromRun(record, runId, runIndex);
    };
    return queue;
  }

  it("enqueues records from JSONL files past watermark", async () => {
    // Create a JSONL run file with 3 records
    const runFile = join(runsDir, "test-run-1.jsonl");
    const records = [
      { type: "session_started", run_id: "test-run-1", ts: 100 },
      { type: "transition_accepted", run_id: "test-run-1", ts: 200 },
      { type: "session_ended", run_id: "test-run-1", ts: 300 },
    ];
    writeFileSync(runFile, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);

    // Create watermark at index 0 (skip first record)
    writeFileSync(join(runsDir, "test-run-1.watermark.json"), JSON.stringify({ lastSentIndex: 0 }));

    const queue = createTestQueue(true);
    const count = await runBackstop(tmpDir, queue, TEST_CONFIG);

    // Should have enqueued records at index > 0 (2 records: ts 200 and ts 300)
    expect(count).toBe(2);
    expect(enqueued).toHaveLength(2);
    expect(enqueued[0]).toEqual(records[1]);
    expect(enqueued[1]).toEqual(records[2]);

    // Watermark should be updated after successful delivery
    const wmPath = join(runsDir, "test-run-1.watermark.json");
    expect(existsSync(wmPath)).toBe(true);
  });

  it("enqueues all records when no watermark exists", async () => {
    const runFile = join(runsDir, "test-run-2.jsonl");
    const records = [
      { type: "session_started", run_id: "test-run-2", ts: 100 },
      { type: "session_ended", run_id: "test-run-2", ts: 200 },
    ];
    writeFileSync(runFile, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);

    const queue = createTestQueue(true);
    const count = await runBackstop(tmpDir, queue, TEST_CONFIG);

    expect(count).toBe(2);
    expect(enqueued).toHaveLength(2);
  });

  it("handles empty runs directory", async () => {
    const queue = createTestQueue(true);
    const count = await runBackstop(tmpDir, queue, TEST_CONFIG);
    expect(count).toBe(0);
  });

  it("handles missing runs directory", async () => {
    const noRunsDir = join(tmpDir, "nonexistent");
    const queue = createTestQueue(true);
    const count = await runBackstop(noRunsDir, queue, TEST_CONFIG);
    expect(count).toBe(0);
  });

  it("enqueues no records when watermark is at end", async () => {
    const runFile = join(runsDir, "test-run-3.jsonl");
    const records = [{ type: "session_started", run_id: "test-run-3", ts: 100 }];
    writeFileSync(runFile, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);

    // Watermark at index 0 (0-based)
    writeFileSync(join(runsDir, "test-run-3.watermark.json"), JSON.stringify({ lastSentIndex: 0 }));

    const queue = createTestQueue(true);
    const count = await runBackstop(tmpDir, queue, TEST_CONFIG);

    // Index 0 was the only record, no new records past it
    expect(count).toBe(0);
  });

  it("does NOT advance watermark if delivery fails", async () => {
    // Use fake timers to skip the 300-second safety timeout in runBackstop.
    // Without this, the test would hang for 300 seconds waiting for delivery.
    vi.useFakeTimers();

    // Create a JSONL run file with 2 records
    const runFile = join(runsDir, "fail-run.jsonl");
    const records = [
      { type: "session_started", run_id: "fail-run", ts: 100 },
      { type: "session_ended", run_id: "fail-run", ts: 200 },
    ];
    writeFileSync(runFile, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);

    // No existing watermark — backstop starts from -1
    const wmPath = join(runsDir, "fail-run.watermark.json");
    expect(existsSync(wmPath)).toBe(false);

    // Queue that always fails delivery
    const failingQueue = createTestQueue(false);

    // Fast-forward through the 300-second safety timeout so the promise resolves
    const backstopPromise = runBackstop(tmpDir, failingQueue, TEST_CONFIG);
    await vi.runAllTimersAsync();
    await backstopPromise;

    // Watermark must NOT be created/updated if delivery failed.
    // Previously (buggy) code updated the watermark immediately after reading,
    // before delivery — that would cause records to be permanently lost.
    expect(existsSync(wmPath)).toBe(false);

    vi.useRealTimers();
  });

  it("advances watermark after successful delivery", async () => {
    const runFile = join(runsDir, "success-run.jsonl");
    const records = [
      { type: "session_started", run_id: "success-run", ts: 100 },
      { type: "session_ended", run_id: "success-run", ts: 200 },
    ];
    writeFileSync(runFile, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);

    // No existing watermark
    const wmPath = join(runsDir, "success-run.watermark.json");
    expect(existsSync(wmPath)).toBe(false);

    // Queue that always succeeds
    const successQueue = createTestQueue(true);

    await runBackstop(tmpDir, successQueue, TEST_CONFIG);

    // After delivery, watermark should be at index 1 (last record index, 0-based)
    expect(existsSync(wmPath)).toBe(true);
    const wm = JSON.parse(readFileSync(wmPath, "utf-8")) as { lastSentIndex?: unknown };
    expect(wm.lastSentIndex).toBe(1);
  });
});
