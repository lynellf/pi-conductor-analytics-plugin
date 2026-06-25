/**
 * pi-conductor-analytics-plugin public API.
 *
 * Re-exports types and utilities for programmatic use or testing.
 */

export {
  clearConfigCache,
  getConfig,
  interpolateEnv,
  loadConfig,
  validateAndResolve,
} from "./config.js";
export { createEnvelope } from "./envelope.js";
export { DeliveryQueue, defaultPost } from "./queue.js";
export type { AnalyticsConfig, AnalyticsEnvelope, QueueStats, ResolvedConfig } from "./types.js";
export { runBackstop } from "./watermark.js";
