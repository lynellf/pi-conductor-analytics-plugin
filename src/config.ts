/**
 * Config discovery, validation, and env interpolation.
 *
 * Config lookup order (first existing file wins):
 *   1. <cwd>/.pi-conductor-analytics.json
 *   2. <cwd>/.pi/conductor-analytics.json
 *   3. <home>/.pi-conductor-analytics.json
 *   4. <home>/.config/pi-conductor/analytics.json
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { AnalyticsConfig, ResolvedConfig } from "./types.js";

// ─── Helpers ───────────────────────────────────────────────────────────

const { env } = process;

/**
 * Interpolate `${ENV_VAR}` patterns in string values.
 * Leaves unrecognized patterns as-is.
 */
export function interpolateEnv(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    return env[name] ?? `$\{${name}}`;
  });
}

// ─── Config file paths ──────────────────────────────────────────────────

function* configPaths(cwd: string, home: string): Generator<string> {
  yield join(cwd, ".pi-conductor-analytics.json");
  yield join(cwd, ".pi", "conductor-analytics.json");
  yield join(home, ".pi-conductor-analytics.json");
  yield join(home, ".config", "pi-conductor", "analytics.json");
}

// ─── Defaults ───────────────────────────────────────────────────────────

const DEFAULTS: ResolvedConfig = {
  enabled: true,
  endpoint: undefined,
  headers: {},
  batch: {
    enabled: true,
    maxRecords: 25,
    flushIntervalMs: 1000,
  },
  request: {
    timeoutMs: 5000,
    maxRetries: 2,
    retry: {
      baseDelayMs: 200,
      maxDelayMs: 5000,
      jitterFactor: 0,
    },
  },
};

// ─── Config loading ─────────────────────────────────────────────────────

/**
 * Load and resolve config from disk or return defaults.
 *
 * @param cwd  Current working directory (probe dirs 1–2).
 * @param home  Home directory (probe dirs 3–4). Defaults to `os.homedir()`.
 * @returns Tuple of [resolved config, loaded from path or null, warnings[]].
 */
export function loadConfig(
  cwd: string,
  home: string = homedir(),
): [ResolvedConfig, string | null, string[]] {
  const warnings: string[] = [];
  let raw: AnalyticsConfig | undefined;
  let sourcePath: string | null = null;

  // Find first existing config file.
  for (const p of configPaths(cwd, home)) {
    if (existsSync(p)) {
      try {
        const content = readFileSync(p, "utf-8");
        raw = JSON.parse(content) as AnalyticsConfig;
        sourcePath = p;
        break;
      } catch (err) {
        warnings.push(`Failed to parse config at ${p}: ${(err as Error).message}`);
      }
    }
  }

  if (raw === undefined || sourcePath === null) {
    // No config found — return defaults with enabled=false so the plugin
    // loads but does not post.
    return [{ ...DEFAULTS, enabled: false }, null, warnings];
  }

  return validateAndResolve(raw, sourcePath, warnings);
}

/**
 * Load and resolve config from a specific file path.
 *
 * Unlike `loadConfig()` which probes multiple directories, this function
 * reads exactly one file. It bypasses the `getConfig()` cache so that
 * an explicit `configPath` in `createAnalyticsReporter()` is isolated from
 * any previously cached config.
 *
 * @param configPath  Absolute or relative path to the config file.
 * @param cwd         Current working directory for resolving relative paths.
 * @returns Tuple of [resolved config, resolved path, warnings[]].
 *          Returns disabled config and empty warnings if the file does not exist.
 */
export function loadConfigFromPath(
  configPath: string,
  cwd: string,
): [ResolvedConfig, string, string[]] {
  const warnings: string[] = [];

  // Resolve relative paths against cwd; absolute paths are used as-is.
  const resolvedPath = isAbsolute(configPath) ? configPath : join(cwd, configPath);

  if (!existsSync(resolvedPath)) {
    warnings.push(`Config file not found: ${resolvedPath}`);
    return [{ ...DEFAULTS, enabled: false }, resolvedPath, warnings];
  }

  try {
    const content = readFileSync(resolvedPath, "utf-8");
    const raw = JSON.parse(content) as AnalyticsConfig;
    return validateAndResolve(raw, resolvedPath, warnings);
  } catch (err) {
    warnings.push(`Failed to parse config at ${resolvedPath}: ${(err as Error).message}`);
    return [{ ...DEFAULTS, enabled: false }, resolvedPath, warnings];
  }
}

/**
 * Validate a raw config object and resolve with defaults.
 */
export function validateAndResolve(
  raw: AnalyticsConfig,
  source: string,
  warnings: string[],
): [ResolvedConfig, string, string[]] {
  // Deep copy defaults to avoid mutating module-level state.
  const resolved: ResolvedConfig = {
    ...DEFAULTS,
    batch: { ...DEFAULTS.batch },
    request: { ...DEFAULTS.request },
    headers: { ...DEFAULTS.headers },
  };

  // enabled
  if (raw.enabled === false) {
    resolved.enabled = false;
    return [resolved, source, warnings];
  }

  // endpoint — required when enabled is not false
  if (typeof raw.endpoint !== "string" || raw.endpoint.trim().length === 0) {
    warnings.push(`Config at ${source}: "endpoint" is required when enabled. Disabling reporting.`);
    resolved.enabled = false;
    return [resolved, source, warnings];
  }

  // Validate endpoint URL
  const endpoint = raw.endpoint.trim();
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      warnings.push(
        `Config at ${source}: "endpoint" protocol must be http: or https:, got "${url.protocol}". Disabling reporting.`,
      );
      resolved.enabled = false;
      return [resolved, source, warnings];
    }
  } catch {
    warnings.push(`Config at ${source}: "endpoint" is not a valid URL. Disabling reporting.`);
    resolved.enabled = false;
    return [resolved, source, warnings];
  }
  resolved.endpoint = endpoint;

  // headers
  if (raw.headers !== undefined && typeof raw.headers === "object" && !Array.isArray(raw.headers)) {
    const interpolated: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw.headers)) {
      if (typeof value === "string") {
        interpolated[key] = interpolateEnv(value);
      }
    }
    resolved.headers = interpolated;
  }

  // batch
  if (raw.batch !== undefined && typeof raw.batch === "object" && !Array.isArray(raw.batch)) {
    if (typeof raw.batch.enabled === "boolean") resolved.batch.enabled = raw.batch.enabled;
    if (typeof raw.batch.maxRecords === "number" && raw.batch.maxRecords > 0) {
      resolved.batch.maxRecords = raw.batch.maxRecords;
    }
    if (typeof raw.batch.flushIntervalMs === "number" && raw.batch.flushIntervalMs > 0) {
      resolved.batch.flushIntervalMs = raw.batch.flushIntervalMs;
    }
  }

  // request
  if (raw.request !== undefined && typeof raw.request === "object" && !Array.isArray(raw.request)) {
    if (typeof raw.request.timeoutMs === "number" && raw.request.timeoutMs > 0) {
      resolved.request.timeoutMs = raw.request.timeoutMs;
    }
    if (typeof raw.request.maxRetries === "number" && raw.request.maxRetries >= 0) {
      resolved.request.maxRetries = raw.request.maxRetries;
    }
    // retry sub-config
    if (
      raw.request.retry !== undefined &&
      typeof raw.request.retry === "object" &&
      !Array.isArray(raw.request.retry)
    ) {
      if (typeof raw.request.retry.baseDelayMs === "number" && raw.request.retry.baseDelayMs > 0) {
        resolved.request.retry.baseDelayMs = raw.request.retry.baseDelayMs;
      }
      if (typeof raw.request.retry.maxDelayMs === "number" && raw.request.retry.maxDelayMs > 0) {
        resolved.request.retry.maxDelayMs = raw.request.retry.maxDelayMs;
      }
      if (
        typeof raw.request.retry.jitterFactor === "number" &&
        raw.request.retry.jitterFactor >= 0
      ) {
        resolved.request.retry.jitterFactor = raw.request.retry.jitterFactor;
      }
    }
  }

  return [resolved, source, warnings];
}

// ─── Module-level state cache ───────────────────────────────────────────

let cachedConfig: ResolvedConfig | undefined;
let cachedWarnings: string[] = [];
let cachedSourcePath: string | null = null;

/**
 * Get or load the analytics configuration.
 *
 * First call probes config paths and caches the result.
 * Subsequent calls return the cached config (caller must re-load on demand).
 *
 * @param cwd  Override CWD for testing. Defaults to `process.cwd()`.
 * @returns Tuple of [ResolvedConfig, source path or null, warnings[]].
 */
export function getConfig(cwd?: string): [ResolvedConfig, string | null, string[]] {
  if (cachedConfig !== undefined) {
    return [cachedConfig, cachedSourcePath, [...cachedWarnings]];
  }

  const wd = cwd ?? process.cwd();
  const home = homedir();
  const [config, source, warnings] = loadConfig(wd, home);

  cachedConfig = config;
  cachedSourcePath = source;
  cachedWarnings = warnings;

  return [config, source, warnings];
}

/** Clear the cached config (useful for testing). */
export function clearConfigCache(): void {
  cachedConfig = undefined;
  cachedSourcePath = null;
  cachedWarnings = [];
}
