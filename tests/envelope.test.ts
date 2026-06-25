import { describe, expect, it } from "vitest";
import { createEnvelope } from "../src/envelope.js";

describe("envelope", () => {
  it("preserves records unchanged", () => {
    const records = [
      { type: "session_started", run_id: "abc", ts: 123 },
      { type: "transition_accepted", run_id: "abc", ts: 456 },
    ];

    const envelope = createEnvelope(records, "/fake/cwd");

    expect(envelope.records).toHaveLength(2);
    expect(envelope.records[0]).toEqual(records[0]);
    expect(envelope.records[1]).toEqual(records[1]);
    // Ensure it's not the same reference — it's a shallow copy
    expect(envelope.records).not.toBe(records);
  });

  it("sets correct plugin identifier", () => {
    const envelope = createEnvelope([{ type: "test", ts: 1 }], "/cwd");
    expect(envelope.plugin).toBe("pi-conductor-analytics-plugin");
    expect(envelope.schema_version).toBe(1);
    expect(envelope.source).toBe("pi.events:conductor:record");
  });

  it("includes sent_at as ISO string", () => {
    const envelope = createEnvelope([{ type: "test", ts: 1 }], "/cwd");
    expect(envelope.sent_at).toBeDefined();
    expect(() => new Date(envelope.sent_at)).not.toThrow();
  });

  it("includes cwd as provided", () => {
    const envelope = createEnvelope([{ type: "test", ts: 1 }], "/my/custom/cwd");
    expect(envelope.cwd).toBe("/my/custom/cwd");
  });

  it("accepts a single record in the array", () => {
    const record = { type: "checkpoint_snapshot", run_id: "abc", ts: 789 };
    const envelope = createEnvelope([record], "/cwd");
    expect(envelope.records).toHaveLength(1);
    expect(envelope.records[0]).toEqual(record);
  });

  it("handles empty records array", () => {
    const envelope = createEnvelope([], "/cwd");
    expect(envelope.records).toHaveLength(0);
  });
});
