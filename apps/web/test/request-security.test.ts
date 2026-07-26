import { describe, expect, test } from "bun:test";
import { mutationRejection } from "../server/utils/request-security";

describe("run import request security", () => {
  test("requires JSON and rejects cross-site browser mutations", () => {
    expect(mutationRejection(
      "text/plain",
      "same-origin",
      "https://workspace.example",
      "https://workspace.example",
    )?.statusCode).toBe(415);
    expect(mutationRejection(
      "application/json",
      "cross-site",
      "https://attacker.example",
      "https://workspace.example",
    )?.statusCode).toBe(403);
    expect(mutationRejection(
      "application/json; charset=utf-8",
      "same-origin",
      "https://workspace.example",
      "https://workspace.example",
    )).toBeUndefined();
  });
});
