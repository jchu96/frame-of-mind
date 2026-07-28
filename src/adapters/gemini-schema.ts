import { z } from "zod";
import {
  CandidateAnalysisError,
  type CandidateValidationIssue,
} from "../domain/analysis-outcome.js";

const jsonObjectSchema = z.record(z.string(), z.unknown());
const schemaType = z.union([z.string(), z.array(z.string())]);
const enumValues = z.array(
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);

export interface GeminiProviderSchema {
  type?: string | string[];
  title?: string;
  description?: string;
  enum?: Array<string | number | boolean | null>;
  properties?: Record<string, GeminiProviderSchema>;
  required?: string[];
  items?: GeminiProviderSchema;
  anyOf?: GeminiProviderSchema[];
  additionalProperties?: boolean | GeminiProviderSchema;
}

export class GeminiResponseValidationError extends CandidateAnalysisError {
  override readonly name: string = "GeminiResponseValidationError";

  constructor(
    label: string,
    code: "response_missing" | "invalid_json" | "schema_validation",
    issues: readonly CandidateValidationIssue[] = [],
    attempts: 1 | 2 = 1,
  ) {
    super({ code, attempts, ...(issues.length ? { issues: [...issues] } : {}) }, label);
  }
}

export function toGeminiProviderSchema(
  schema: z.ZodType,
): GeminiProviderSchema {
  return sanitizeSchemaNode(z.toJSONSchema(schema));
}

export function parseGeminiJson<T>(
  text: string | undefined,
  schema: z.ZodType<T>,
  label: string,
): T {
  if (!text) {
    throw new GeminiResponseValidationError(label, "response_missing");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new GeminiResponseValidationError(label, "invalid_json");
  }

  const result = schema.safeParse(decoded);
  if (!result.success) {
    const issues = result.error.issues.slice(0, 3).map((issue) => ({
      path: sanitizeIssuePath(issue.path),
      code: sanitizeIssueCode(issue.code),
    }));
    throw new GeminiResponseValidationError(
      label,
      "schema_validation",
      issues,
    );
  }
  return result.data;
}

function sanitizeIssueCode(code: string): string {
  return code.slice(0, 64).replace(/[^a-z_]/g, "_") || "custom";
}

function sanitizeIssuePath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return "_root_";
  return path
    .slice(0, 8)
    .map((segment) => {
      const bounded = String(segment).slice(0, 64);
      return bounded.replace(/[^a-zA-Z0-9_-]/g, "_") || "_";
    })
    .join(".");
}

function sanitizeSchemaNode(input: unknown): GeminiProviderSchema {
  const object = jsonObjectSchema.safeParse(input);
  if (!object.success) {
    throw new Error("Zod produced a non-object JSON Schema node.");
  }

  const output: GeminiProviderSchema = {};
  const type = schemaType.safeParse(object.data.type);
  if (type.success) output.type = type.data;

  const title = z.string().safeParse(object.data.title);
  if (title.success) output.title = title.data;

  const description = z.string().safeParse(object.data.description);
  if (description.success) output.description = description.data;

  const enumeration = enumValues.safeParse(object.data.enum);
  if (enumeration.success) output.enum = enumeration.data;

  const required = z.array(z.string()).safeParse(object.data.required);
  if (required.success) output.required = required.data;

  const properties = jsonObjectSchema.safeParse(object.data.properties);
  if (properties.success) {
    output.properties = Object.fromEntries(
      Object.entries(properties.data).map(([key, value]) => [
        key,
        sanitizeSchemaNode(value),
      ]),
    );
  }

  if (object.data.items !== undefined) {
    output.items = sanitizeSchemaNode(object.data.items);
  }

  const anyOf = z.array(z.unknown()).safeParse(object.data.anyOf);
  if (anyOf.success) {
    output.anyOf = anyOf.data.map(sanitizeSchemaNode);
  }

  const additionalProperties = z.boolean().safeParse(
    object.data.additionalProperties,
  );
  if (additionalProperties.success) {
    output.additionalProperties = additionalProperties.data;
  } else if (object.data.additionalProperties !== undefined) {
    output.additionalProperties = sanitizeSchemaNode(
      object.data.additionalProperties,
    );
  }

  if (Object.keys(output).length === 0) {
    throw new Error("Zod produced a JSON Schema node with no Gemini-safe fields.");
  }
  return output;
}
