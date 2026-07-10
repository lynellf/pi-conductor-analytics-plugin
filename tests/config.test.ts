import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearConfigCache, interpolateEnv, loadConfig, validateAndResolve } from "../src/config.js";

describe("config", () => {
  describe("interpolateEnv", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: test intentionally uses ${...} literal
    it("replaces ${ENV_VAR} with env value", () => {
      process.env.TEST_VAR = "hello";
      // biome-ignore lint/suspicious/noTemplateCurlyInString: test intentionally uses ${...} literal
      expect(interpolateEnv("${TEST_VAR}")).toBe("hello");
    });

    it("leaves unrecognized patterns as-is", () => {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: test intentionally uses ${...} literal
      expect(interpolateEnv("${UNKNOWN_VAR}")).toBe("${UNKNOWN_VAR}");
    });

    it("handles no env references", () => {
      expect(interpolateEnv("plain string")).toBe("plain string");
    });
  });

  describe("validateAndResolve", () => {
    it("returns disabled config when enabled is false", () => {
      const [config, _source, warnings] = validateAndResolve(
        { enabled: false },
        "/fake/path.json",
        [],
      );
      expect(config.enabled).toBe(false);
      expect(warnings).toHaveLength(0);
    });

    it("returns disabled config when endpoint is missing", () => {
      const [config, _source, warnings] = validateAndResolve({}, "/fake/path.json", []);
      expect(config.enabled).toBe(false);
      expect(warnings.length).toBeGreaterThanOrEqual(1);
      expect(warnings[0]).toContain("endpoint");
    });

    it("rejects non-http/https endpoints", () => {
      const [config, _source, warnings] = validateAndResolve(
        { endpoint: "file:///tmp/foo" },
        "/fake/path.json",
        [],
      );
      expect(config.enabled).toBe(false);
      expect(warnings.length).toBeGreaterThanOrEqual(1);
      expect(warnings[0]).toContain("protocol");
    });

    it("rejects invalid URLs", () => {
      const [config, _source, warnings] = validateAndResolve(
        { endpoint: "not a url" },
        "/fake/path.json",
        [],
      );
      expect(config.enabled).toBe(false);
      expect(warnings.length).toBeGreaterThanOrEqual(1);
    });

    it("accepts valid https endpoint", () => {
      const [config, _source, warnings] = validateAndResolve(
        { endpoint: "https://analytics.example.com/events" },
        "/fake/path.json",
        [],
      );
      expect(config.enabled).toBe(true);
      expect(config.endpoint).toBe("https://analytics.example.com/events");
      expect(warnings).toHaveLength(0);
    });

    it("accepts valid http endpoint", () => {
      const [config, _source, warnings] = validateAndResolve(
        { endpoint: "http://localhost:8080/events" },
        "/fake/path.json",
        [],
      );
      expect(config.enabled).toBe(true);
      expect(config.endpoint).toBe("http://localhost:8080/events");
      expect(warnings).toHaveLength(0);
    });

    it("interpolates env vars in headers", () => {
      process.env.TOKEN = "secret-token";
      const [config, _source, _warnings] = validateAndResolve(
        {
          endpoint: "https://example.com/events",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: test intentionally uses ${...} literal in config
          headers: { Authorization: "Bearer ${TOKEN}" },
        },
        "/fake/path.json",
        [],
      );
      expect(config.headers.Authorization).toBe("Bearer secret-token");
    });

    it("applies batch config defaults", () => {
      const [config] = validateAndResolve(
        { endpoint: "https://example.com/events" },
        "/fake/path.json",
        [],
      );
      expect(config.batch.enabled).toBe(true);
      expect(config.batch.maxRecords).toBe(25);
      expect(config.batch.flushIntervalMs).toBe(1000);
    });

    it("applies custom batch config", () => {
      const [config] = validateAndResolve(
        {
          endpoint: "https://example.com/events",
          batch: { enabled: false, maxRecords: 10, flushIntervalMs: 500 },
        },
        "/fake/path.json",
        [],
      );
      expect(config.batch.enabled).toBe(false);
      expect(config.batch.maxRecords).toBe(10);
      expect(config.batch.flushIntervalMs).toBe(500);
    });

    it("applies request config", () => {
      const [config] = validateAndResolve(
        {
          endpoint: "https://example.com/events",
          request: { timeoutMs: 10000, maxRetries: 5 },
        },
        "/fake/path.json",
        [],
      );
      expect(config.request.timeoutMs).toBe(10000);
      expect(config.request.maxRetries).toBe(5);
    });
  });

  describe("loadConfig (file lookup)", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "pi-analytics-test-"));
      clearConfigCache();
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
      clearConfigCache();
    });

    it("loads config from cwd/.pi-conductor-analytics.json", () => {
      const cfg = { endpoint: "https://example.com/events" };
      writeFileSync(join(tmpDir, ".pi-conductor-analytics.json"), JSON.stringify(cfg));
      const [config, source] = loadConfig(tmpDir);
      expect(config.enabled).toBe(true);
      expect(config.endpoint).toBe("https://example.com/events");
      expect(source).toBe(join(tmpDir, ".pi-conductor-analytics.json"));
    });

    it("loads config from cwd/.pi/conductor-analytics.json (second priority)", () => {
      // Write the first-priority file with invalid data to simulate missing
      // Actually we don't write it, so it falls through
      mkdirSync(join(tmpDir, ".pi"), { recursive: true });
      writeFileSync(
        join(tmpDir, ".pi", "conductor-analytics.json"),
        JSON.stringify({ endpoint: "https://example.com/events-pi" }),
      );
      const [config, source] = loadConfig(tmpDir);
      expect(config.endpoint).toBe("https://example.com/events-pi");
      expect(source).toBe(join(tmpDir, ".pi", "conductor-analytics.json"));
    });

    it("returns disabled config when no config file exists", () => {
      // Use an isolated fake home dir so loadConfig doesn't pick up the
      // user's real ~/.pi-conductor-analytics.json
      const fakeHome = mkdtempSync(join(tmpdir(), "pi-analytics-fake-home-"));
      try {
        const [config, source, _warnings] = loadConfig(tmpDir, fakeHome);
        expect(config.enabled).toBe(false);
        expect(source).toBeNull();
      } finally {
        rmSync(fakeHome, { recursive: true, force: true });
      }
    });

    it("cwd config overrides home config", () => {
      // Write both a CWD config and a home config
      const homeDir = mkdtempSync(join(tmpdir(), "pi-analytics-home-"));
      writeFileSync(
        join(tmpDir, ".pi-conductor-analytics.json"),
        JSON.stringify({ endpoint: "https://cwd.example.com/events" }),
      );
      writeFileSync(
        join(homeDir, ".pi-conductor-analytics.json"),
        JSON.stringify({ endpoint: "https://home.example.com/events" }),
      );
      const [config, source] = loadConfig(tmpDir, homeDir);
      expect(config.endpoint).toBe("https://cwd.example.com/events");
      expect(source).toContain(tmpDir);
      rmSync(homeDir, { recursive: true, force: true });
    });
  });
});
