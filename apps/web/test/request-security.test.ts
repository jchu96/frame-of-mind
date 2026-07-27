import { describe, expect, test } from "bun:test";
import {
  mutationRejection,
  trustedMutationRejection,
} from "../server/utils/request-security";

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

  test("applies the same origin policy to streamed binary mutations", () => {
    expect(trustedMutationRejection(
      "cross-site",
      "https://attacker.example",
      "https://workspace.example",
    )?.statusCode).toBe(403);
    expect(trustedMutationRejection(
      "same-origin",
      "https://workspace.example",
      "https://workspace.example",
    )).toBeUndefined();
  });
});
