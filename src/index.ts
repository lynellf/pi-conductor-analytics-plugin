/**
 * pi-conductor-analytics-plugin public API.
 *
 * Re-exports types and utilities for programmatic use or testing.
 *
 * ## Reporter API (issue #1)
 *
 * For library integrations, use `createAnalyticsReporter()`:
 *
 * ```ts
 * import { createAnalyticsReporter } from "pi-conductor-analytics-plugin";
 *
 * const reporter = createAnalyticsReporter({
 *   cwd: process.cwd(),
 *   runsDir: join(process.cwd(), ".pi-conductor/runs"),
 * });
 * reporter.enqueue({ type: "my_event" });
 * await reporter.shutdown();
 * ```
 *
 * ## Low-level API
 *
 * Existing exports remain available for direct queue/envelope/config usage.
 */

export {
  clearConfigCache,
  getConfig,
  interpolateEnv,
  loadConfig,
  loadConfigFromPath,
  validateAndResolve,
} from "./config.js";
export { createEnvelope } from "./envelope.js";
export { DeliveryQueue, defaultPost } from "./queue.js";
export { createAnalyticsReporter } from "./reporter.js";
export type {
  AnalyticsConfig,
  AnalyticsEnvelope,
  AnalyticsRecord,
  AnalyticsReporter,
  AnalyticsReporterOptions,
  OverflowCallback,
  QueueStats,
  ResolvedConfig,
} from "./types.js";
export { runBackstop } from "./watermark.js";
