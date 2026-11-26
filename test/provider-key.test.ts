import { expect, it, vi } from "vitest";
import { join } from "node:path";
import { createCliSettings } from "../src/cli-settings.js";
import { classifyLaunch, inheritedValue } from "../src/cli-launch.js";

const cwd = process.cwd();
const launch = (environment: NodeJS.ProcessEnv = {}, mode: "clean" | "bare" = "clean") =>
  ({environment: Object.freeze(environment), cwd, mode});

it("classifies runtime options without using credential bytes or application arguments", () => {
  for (const flag of ["--env-file", "--env-file=.env", "--env-file-if-exists", "--env-file-if-exists=.env"]) {
    expect(classifyLaunch(false, [flag]), flag).toBe("bare");
  }
  for (const flag of ["--require", "-r", "-rfixture", "--import", "--loader", "--experimental_loader", "--enable-source-maps"]) {
    expect(classifyLaunch(false, [flag]), flag).toBe("clean");
  }
  expect(classifyLaunch(true, ["--no-env-file", "--preload", "fixture"])).toBe("clean");
  expect(classifyLaunch(true, [])).toBe("bare");
});

it("reads inherited names with Windows casing while preserving snapshot spelling", () => {
  const environment = Object.freeze({Gemini_Api_Key: "fixture"});
  expect(inheritedValue(environment, "GEMINI_API_KEY", "win32")).toBe("fixture");
  expect(inheritedValue(environment, "GEMINI_API_KEY", "linux")).toBeUndefined();
  expect(Object.keys(environment)).toEqual(["Gemini_Api_Key"]);
});

it("never inspects a lower credential after a higher assignment", () => {
  for (const lower of ["fixture", "different-fixture"]) {
    for (const higher of ["fixture", ""]) {
      const read = vi.fn(() => "GEMINI_API_KEY=" + lower);
      const config = createCliSettings(launch({GEMINI_API_KEY: higher}), read);
      expect(config.keyReport()).toEqual({present: !!higher, source: "environment", lowerSourcesSkipped: true,
        ...(!higher && {state: "unavailable"})});
      expect(config.providerKey()).toBe(higher || undefined);
      expect(read, "lower credential lookup").not.toHaveBeenCalled();
    }
  }
});

it("reads the selected file once across consumers, including on failure", async () => {
  for (const failed of [false, true]) {
    const read = vi.fn(() => {
      if (failed) throw new Error("private fixture failure");
      return 'GEMINI_API_KEY="literal-${HOME}"';
    });
    const config = createCliSettings(launch(), read);
    expect(read, "eager acquisition").not.toHaveBeenCalled();
    const consumers = await Promise.all([0, 1].map(async () => config.providerKey()));
    expect([...consumers, config.providerKey()]).toEqual(Array(3).fill(failed ? undefined : "literal-${HOME}"));
    expect(config.keyReport()).toEqual({source: "dotenv", path: join(cwd, ".env"), present: !failed,
      ...(failed && {state: "unavailable"})});
    expect(read, "file reads per run").toHaveBeenCalledTimes(1);
  }
});

it("provides application settings as literal data without modifying the environment", () => {
  const names = ["GEMINI_MODEL", "FRAME_OF_MIND_DETAIL_CONCURRENCY", "FRAME_OF_MIND_MAX_VIDEO_SECONDS",
    "FRAME_OF_MIND_OUTPUT", "FRAME_OF_MIND_UPLOAD_RETENTION", "BLUEDOT_MCP_URL", "GRANOLA_MCP_URL",
    "GRANOLA_API_KEY", "SENTRY_DSN", "SENTRY_DEBUG", "FRAME_OF_MIND_TRACING", "FRAME_OF_MIND_TRACES_SAMPLE_RATE"] as const;
  const environment = {GEMINI_MODEL: "shell"};
  const config = createCliSettings(launch(environment), () => names.map(name => name + '=literal-${HOME}').join("\n"));
  for (const name of names) expect(config.setting(name), name).toBe(name === "GEMINI_MODEL" ? "shell" : 'literal-${HOME}');
  expect(environment).toEqual({GEMINI_MODEL: "shell"});
});

it("keeps bare provenance unknown and never consults a lower key", () => {
  const read = vi.fn(() => "GEMINI_API_KEY=folder");
  for (const key of ["", "synthetic"]) {
    const config = createCliSettings(launch({GEMINI_API_KEY: key}, "bare"), read);
    expect(config.keyReport()).toEqual({source: "unknown", present: !!key});
    expect(config.providerKey()).toBe(key || undefined);
  }
  expect(read).not.toHaveBeenCalled();
});
