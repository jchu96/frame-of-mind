import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { DEFAULT_GEMINI_MODEL } from "../src/adapters/gemini-model.js";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// The pinned default must be a provider-documented id, verified in
// DECISION-gemini-4-hydrogen.md against https://ai.google.dev/gemini-api/docs/models/gemini-4-hydrogen.
it("pins the default Gemini model", () => {
  expect(DEFAULT_GEMINI_MODEL).toBe("gemini-4-hydrogen");
});

// A stale GEMINI_MODEL in a copied .env silently overrides the default
// (2026-08-17), and .env.example had drifted to an older id by 2026-11-12.
it("keeps the example env and operator docs on the pinned default", () => {
  expect(read(".env.example")).toMatch(new RegExp(`^GEMINI_MODEL=${DEFAULT_GEMINI_MODEL}$`, "m"));
  expect(read("README.md")).toContain(`defaults to \`${DEFAULT_GEMINI_MODEL}\``);
  expect(read("docs/RUNBOOK.md")).toMatch(new RegExp(`^\\| Default model +\\| \`${DEFAULT_GEMINI_MODEL}\` +\\|$`, "m"));
  expect(read("docs/VIDEO_UNDERSTANDING.md")).toContain(`default model \`${DEFAULT_GEMINI_MODEL}\``);
});
