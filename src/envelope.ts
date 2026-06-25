/**
 * Analytics envelope builder.
 *
 * Wraps raw conductor records in a versioned envelope for POST delivery.
 * Records are preserved unchanged inside `records[]`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AnalyticsEnvelope } from "./types.js";

// ─── Package version loader ─────────────────────────────────────────────

let _pluginVersion: string | undefined;

/**
 * Read the plugin version from package.json.
 * Cached after first read.
 */
function getPluginVersion(): string {
  if (_pluginVersion !== undefined) return _pluginVersion;
  try {
    // Probe CWD first, then fall back to the module's own location.
    const paths = [
      join(process.cwd(), "package.json"),
      new URL("../package.json", import.meta.url).pathname,
    ];
    for (const p of paths) {
      try {
        const pkg = JSON.parse(readFileSync(p, "utf-8")) as { version?: string };
        if (typeof pkg.version === "string") {
          _pluginVersion = pkg.version;
          return _pluginVersion;
        }
      } catch {}
    }
  } catch {
    // Fallback
  }
  _pluginVersion = "0.0.0";
  return _pluginVersion;
}

/**
 * Create an analytics envelope wrapping one or more conductor records.
 *
 * @param records  One or more conductor PersistedRecord objects.
 * @param cwd      The current working directory at send time.
 * @returns A complete AnalyticsEnvelope ready for JSON serialization.
 */
export function createEnvelope(records: unknown[], cwd: string = process.cwd()): AnalyticsEnvelope {
  return {
    plugin: "pi-conductor-analytics-plugin",
    plugin_version: getPluginVersion(),
    schema_version: 1,
    sent_at: new Date().toISOString(),
    cwd,
    source: "pi.events:conductor:record",
    records: [...records],
  };
}
