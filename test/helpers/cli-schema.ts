import { readFileSync } from "node:fs";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { expect } from "vitest";

export function validateCliDocument(name: string, stdout: string) {
  const document = JSON.parse(stdout);
  const schema = JSON.parse(readFileSync(new URL(`../../schemas/cli/${name}.schema.json`, import.meta.url), "utf8"));
  const result = new AjvJsonSchemaValidator().getValidator(schema)(document);
  expect(result.valid, result.errorMessage).toBe(true);
  return document;
}

export function resolves(value: unknown, parts: string[]): boolean {
  if (!parts.length) return true;
  const [key, ...rest] = parts;
  if (key === "*") return Array.isArray(value) && value.length > 0 && value.every(item => resolves(item, rest));
  return typeof value === "object" && value !== null && Object.hasOwn(value, key!)
    && resolves((value as Record<string, unknown>)[key!], rest);
}
