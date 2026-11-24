import { readFileSync } from "node:fs";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { expect } from "vitest";

export function validateCliDocument(name: string, stdout: string) {
  const document = JSON.parse(stdout);
  expect(Object.keys(document)[0]).toBe("schemaVersion");
  const schema = JSON.parse(readFileSync(new URL(`../../schemas/cli/${name}.schema.json`, import.meta.url), "utf8"));
  const result = new AjvJsonSchemaValidator().getValidator(schema)(document);
  expect(result.valid, result.errorMessage).toBe(true);
  return document;
}
