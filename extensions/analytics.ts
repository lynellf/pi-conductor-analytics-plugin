/**
 * pi-conductor analytics plugin extension entrypoint.
 *
 * This extension is a thin adapter that:
 * 1. Creates an `AnalyticsReporter` using `process.cwd()` and the
 *    default `.pi-conductor/runs` directory.
 * 2. Forwards valid `conductor:record` events to `reporter.enqueue()`.
 * 3. Calls `reporter.backfill()` once on `session_start`.
 * 4. Calls `reporter.shutdown()` on `session_shutdown`.
 *
 * No delivery or watermark business logic lives in this file.
 * Library callers should use `createAnalyticsReporter()` directly
 * with explicit `cwd`, `runsDir`, and optional `configPath`.
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

import { join } from "node:path";
import type {
  ExtensionAPI,
  SessionShutdownEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { createAnalyticsReporter } from "../src/reporter.js";
import type { AnalyticsReporter, OverflowCallback } from "../src/types.js";

// ─── Default runs directory ──────────────────────────────────────────────

/**
 * The default directory where pi-conductor stores run JSONL files.
 * Mirrors `DEFAULT_RUN_BASE_DIR` in the watermark module.
 */
const DEFAULT_RUN_BASE_DIR = ".pi-conductor/runs";

// ─── Module-level state ─────────────────────────────────────────────────

let reporter: AnalyticsReporter | undefined;
let recordsObserved = false;
let backstopDone = false;
let noRecordWarningTimer: ReturnType<typeof setTimeout> | null = null;
let latestOverflowDropped = 0;
let latestOverflowPending = 0;

// ─── Overflow callback ──────────────────────────────────────────────────

/**
 * Safe overflow callback that logs a redacted warning immediately
 * and stores the latest aggregate for UI notification.
 *
 * This callback does not require conductor record handler context,
 * does not throw, and does not await.
 */
const overflowCallback: OverflowCallback = (
  dropped: number,
  pending: number,
  _suppressed: number,
): void => {
  latestOverflowDropped = dropped;
  latestOverflowPending = pending;
  console.warn(
    `[pi-conductor-analytics-plugin] Queue overflow: ${dropped} total dropped, ${pending} pending`,
  );
};

// ─── Extension factory ──────────────────────────────────────────────────

export default function analyticsExtension(pi: ExtensionAPI): void {
  const cwd = process.cwd();
  const runsDir = join(cwd, DEFAULT_RUN_BASE_DIR);

  // ── Create the reporter ─────────────────────────────────────────────
  // The reporter surfaces config warnings and disabled state via console.warn.
  // When disabled, its methods are safe no-ops; we still register lifecycle
  // handlers so the no-record warning and overflow surfacing work.
  reporter = createAnalyticsReporter(
    {
      cwd,
      runsDir,
      // configPath is intentionally omitted so standard discovery is used.
      // Library callers should provide an explicit configPath for isolation.
    },
    overflowCallback,
  );

  // ── Listen for conductor records ────────────────────────────────────
  // This is the primary hook: pi-conductor's extension emits
  // "conductor:record" on the shared pi.events bus.
  pi.events.on("conductor:record", (data: unknown) => {
    if (
      typeof data !== "object" ||
      data === null ||
      typeof (data as Record<string, unknown>).type !== "string"
    ) {
      console.warn(
        "[pi-conductor-analytics-plugin] Ignoring invalid record (not a non-null object with a string `type`)",
      );
      return;
    }

    recordsObserved = true;
    reporter?.enqueue(data);
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

    // ── Surface overflow aggregate if any occurred ───────────────────
    if (latestOverflowDropped > 0) {
      ctx.ui.notify(
        `[pi-conductor-analytics-plugin] Queue overflow: ${latestOverflowDropped} total dropped, ${latestOverflowPending} pending`,
        "warning",
      );
    }

    // ── Run JSONL backfill on session start ──────────────────────────
    if (!backstopDone && reporter !== undefined) {
      backstopDone = true;
      // backfill() does not block; it enqueues and returns the count.
      // Delivery happens asynchronously via the queue interval.
      reporter
        .backfill()
        .then((backfilled: number) => {
          if (backfilled > 0) {
            const msg = `[pi-conductor-analytics-plugin] Backfill enqueued ${backfilled} records from disk.`;
            console.warn(msg);
            ctx.ui.notify(msg, "info");
          }
        })
        .catch((err: unknown) => {
          const msg = `[pi-conductor-analytics-plugin] Backfill error: ${(err as Error).message}`;
          console.warn(msg);
          ctx.ui.notify(msg, "warning");
        });
    }
  });

  // ── Best-effort flush on shutdown ───────────────────────────────────
  pi.on("session_shutdown", async (_event: SessionShutdownEvent, ctx) => {
    // Cancel warning timer
    if (noRecordWarningTimer !== null) {
      clearTimeout(noRecordWarningTimer);
      noRecordWarningTimer = null;
    }

    if (reporter !== undefined) {
      ctx.ui.notify(
        "[pi-conductor-analytics-plugin] Shutdown: flushing pending records...",
        "info",
      );
      try {
        await reporter.shutdown();
        const s = reporter.stats();
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
