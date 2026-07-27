import { describe, expect, it } from "vitest";
import { createE2EEnvironment } from "../scripts/e2e-environment";

describe("createE2EEnvironment", () => {
  it("passes only operational variables and explicit synthetic additions", () => {
    expect(
      createE2EEnvironment(
        {
          HOME: "/synthetic/home",
          PATH: "/synthetic/bin",
          GEMINI_API_KEY: "must-not-cross",
          GRANOLA_API_KEY: "must-not-cross",
          ASANA_PAT: "must-not-cross",
        },
        {
          FRAME_OF_MIND_E2E_TEMP_ROOT: "/synthetic/temp",
        },
      ),
    ).toEqual({
      FRAME_OF_MIND_E2E_TEMP_ROOT: "/synthetic/temp",
      PATH: "/synthetic/bin",
      HOME: "/synthetic/home",
    });
  });
});
