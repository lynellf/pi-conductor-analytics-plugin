import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    request: { timeoutMs: 5000, maxRetries: 0 },
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

  function createTestQueue(): DeliveryQueue {
    const queue = new DeliveryQueue(TEST_CONFIG, async () => true, tmpDir);
    // Override enqueue to also track records
    const origEnqueue = queue.enqueue.bind(queue);
    queue.enqueue = (record: unknown) => {
      enqueued.push(record);
      origEnqueue(record);
    };
    return queue;
  }

  it("enqueues records from JSONL files past watermark", () => {
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

    const queue = createTestQueue();
    const count = runBackstop(tmpDir, queue, TEST_CONFIG);

    // Should have enqueued records at index > 0 (2 records: ts 200 and ts 300)
    expect(count).toBe(2);
    expect(enqueued).toHaveLength(2);
    expect(enqueued[0]).toEqual(records[1]);
    expect(enqueued[1]).toEqual(records[2]);

    // Watermark should be updated
    const wmPath = join(runsDir, "test-run-1.watermark.json");
    expect(existsSync(wmPath)).toBe(true);
  });

  it("enqueues all records when no watermark exists", () => {
    const runFile = join(runsDir, "test-run-2.jsonl");
    const records = [
      { type: "session_started", run_id: "test-run-2", ts: 100 },
      { type: "session_ended", run_id: "test-run-2", ts: 200 },
    ];
    writeFileSync(runFile, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);

    const queue = createTestQueue();
    const count = runBackstop(tmpDir, queue, TEST_CONFIG);

    expect(count).toBe(2);
    expect(enqueued).toHaveLength(2);
  });

  it("handles empty runs directory", () => {
    const queue = createTestQueue();
    const count = runBackstop(tmpDir, queue, TEST_CONFIG);
    expect(count).toBe(0);
  });

  it("handles missing runs directory", () => {
    const noRunsDir = join(tmpDir, "nonexistent");
    const queue = createTestQueue();
    const count = runBackstop(noRunsDir, queue, TEST_CONFIG);
    expect(count).toBe(0);
  });

  it("enqueues no records when watermark is at end", () => {
    const runFile = join(runsDir, "test-run-3.jsonl");
    const records = [{ type: "session_started", run_id: "test-run-3", ts: 100 }];
    writeFileSync(runFile, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);

    // Watermark at index 0 (0-based)
    writeFileSync(join(runsDir, "test-run-3.watermark.json"), JSON.stringify({ lastSentIndex: 0 }));

    const queue = createTestQueue();
    const count = runBackstop(tmpDir, queue, TEST_CONFIG);

    // Index 0 was the only record, no new records past it
    expect(count).toBe(0);
  });
});
