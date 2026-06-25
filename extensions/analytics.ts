/**
 * pi-conductor analytics plugin extension entrypoint.
 *
 * This extension hooks into pi-conductor's `conductor:record` event
 * (emitted via `pi.events`) and POSTs telemetry to a configured
 * external HTTP endpoint in a non-blocking fashion.
 *
 * ## Warning surface discipline
 *
 * - Factory context (this function): only `console.warn` is available.
 * - `pi.on("session_start", ...)` / `pi.on("session_shutdown", ...)`:
 *   handlers receive `ctx` with `ctx.ui.notify`.
 * - `pi.events.on("conductor:record", ...)`: receives only `data`,
 *   no ctx; use `console.warn`.
 *
 * ## Events
 *
 * - `pi.events.on("conductor:record", ...)` – fire-and-forget records
 *   from pi-conductor. Handler enqueues and returns immediately.
 * - `pi.on("session_start", ...)` – trigger JSONL backstop/watermark
 *   to ship missed records from disk.
 * - `pi.on("session_shutdown", ...)` – best-effort flush on shutdown.
 */

import type {
  ExtensionAPI,
  SessionShutdownEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

import { getConfig } from "../src/config.js";
import { DeliveryQueue, defaultPost } from "../src/queue.js";
import { runBackstop } from "../src/watermark.js";

// ─── Module-level state ─────────────────────────────────────────────────

let queue: DeliveryQueue | undefined;
let recordsObserved = false;
let backstopDone = false;
let noRecordWarningTimer: ReturnType<typeof setTimeout> | null = null;

// ─── Package version ────────────────────────────────────────────────────

const PLUGIN_VERSION = "0.1.0";

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Minimal record validation: must be a non-null object with a string `type`.
 */
function isValidRecord(data: unknown): data is Record<string, unknown> {
  return (
    typeof data === "object" &&
    data !== null &&
    typeof (data as Record<string, unknown>).type === "string"
  );
}

// ─── Extension factory ──────────────────────────────────────────────────

export default function analyticsExtension(pi: ExtensionAPI): void {
  // ── Load config ─────────────────────────────────────────────────────
  const cwd = process.cwd();
  const [config, sourcePath, warnings] = getConfig(cwd);

  // Surface config warnings in factory context (only console.warn available)
  for (const w of warnings) {
    console.warn(`[pi-conductor-analytics-plugin] ${w}`);
  }

  if (sourcePath !== null) {
    console.warn(`[pi-conductor-analytics-plugin] Config loaded from ${sourcePath}`);
  }

  if (!config.enabled || config.endpoint === undefined) {
    if (sourcePath === null) {
      console.warn("[pi-conductor-analytics-plugin] No config found. Plugin loaded but inactive.");
    } else {
      console.warn(
        "[pi-conductor-analytics-plugin] Config explicitly disabled. Plugin loaded but inactive.",
      );
    }
    return; // Early return: nothing to register
  }

  // ── Initialize delivery queue ───────────────────────────────────────
  queue = new DeliveryQueue(config, defaultPost, cwd, PLUGIN_VERSION);
  console.warn(`[pi-conductor-analytics-plugin] Active — posting to ${config.endpoint}`);

  // ── Listen for conductor records ────────────────────────────────────
  // This is the primary hook: pi-conductor's extension emits
  // "conductor:record" on the shared pi.events bus.
  pi.events.on("conductor:record", (data: unknown) => {
    if (!isValidRecord(data)) {
      console.warn(
        "[pi-conductor-analytics-plugin] Ignoring invalid record (not a non-null object with a string `type`)",
      );
      return;
    }

    recordsObserved = true;
    queue?.enqueue(data);
  });

  // ── Warn if no conductor records after session start ─────────────────
  pi.on("session_start", (_event: SessionStartEvent, ctx) => {
    // Clear any previous warning timer
    if (noRecordWarningTimer !== null) {
      clearTimeout(noRecordWarningTimer);
    }

    // Set a timer to warn if no records observed after 30 seconds
    noRecordWarningTimer = setTimeout(() => {
      if (!recordsObserved) {
        const msg =
          "[pi-conductor-analytics-plugin] No conductor records received since session start. Is pi-conductor installed and loaded?";
        console.warn(msg);
        ctx.ui.notify(msg, "warning");
      }
    }, 30_000);

    // ── Run JSONL backstop on session start ─────────────────────────
    if (!backstopDone && queue !== undefined && config.endpoint !== undefined) {
      backstopDone = true;
      try {
        const backfilled = runBackstop(cwd, queue, config);
        if (backfilled > 0) {
          const msg = `[pi-conductor-analytics-plugin] Backstop enqueued ${backfilled} records from disk.`;
          console.warn(msg);
          ctx.ui.notify(msg, "info");
        }
      } catch (err) {
        const msg = `[pi-conductor-analytics-plugin] Backstop error: ${(err as Error).message}`;
        console.warn(msg);
        ctx.ui.notify(msg, "warning");
      }
    }
  });

  // ── Best-effort flush on shutdown ───────────────────────────────────
  pi.on("session_shutdown", async (_event: SessionShutdownEvent, ctx) => {
    // Cancel warning timer
    if (noRecordWarningTimer !== null) {
      clearTimeout(noRecordWarningTimer);
      noRecordWarningTimer = null;
    }

    if (queue !== undefined) {
      ctx.ui.notify(
        "[pi-conductor-analytics-plugin] Shutdown: flushing pending records...",
        "info",
      );
      try {
        await queue.shutdown();
        const s = queue.stats();
        ctx.ui.notify(
          `[pi-conductor-analytics-plugin] Flush complete. Delivered: ${s.delivered}, Failed: ${s.failed}, Dropped: ${s.dropped}`,
          "info",
        );
      } catch (err) {
        ctx.ui.notify(
          `[pi-conductor-analytics-plugin] Flush error: ${(err as Error).message}`,
          "warning",
        );
      }
    }
  });
}
