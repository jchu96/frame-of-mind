import type { GenerateContentParameters } from "@google/genai";
import { expect } from "vitest";

export function requestText(request: GenerateContentParameters): string {
  const contents = request.contents;
  if (!Array.isArray(contents) || contents.length !== 1) throw new Error("Expected one request message");
  const message = contents[0];
  if (!message || typeof message !== "object" || !("parts" in message)) throw new Error("Expected message parts");
  return (message.parts ?? []).flatMap(part => part.text ?? []).join("\n");
}

export function expectOriginalLanguage(request: GenerateContentParameters): void {
  const text = requestText(request);
  expect.soft(text).toContain("Use the language or languages actually spoken.");
  expect.soft(text).toContain("Preserve language switches within a sentence.");
  expect.soft(text).toContain("Do not translate.");
  expect.soft(text).not.toMatch(/(?:write|translate) (?:the (?:speech|transcript) )?(?:in|into|to) English/i);
}
