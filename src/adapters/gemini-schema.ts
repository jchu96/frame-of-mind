import { z } from "zod";

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
    throw new Error(`${label} is missing.`);
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new Error(`${label} was not valid JSON.`);
  }

  const result = schema.safeParse(decoded);
  if (!result.success) {
    const issues = result.error.issues.slice(0, 3).map((issue) => {
      const path = issue.path.length > 0
        ? issue.path.map(String).join(".")
        : "<root>";
      return `${path} (${issue.code})`;
    });
    throw new Error(
      `${label} failed strict local validation at ${issues.join(", ")}.`,
    );
  }
  return result.data;
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
