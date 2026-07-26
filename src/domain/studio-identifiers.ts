import { z } from "zod";

const opaqueResourceIdBrand: unique symbol = Symbol("opaqueResourceId");

export type OpaqueResourceId = string & {
  readonly [opaqueResourceIdBrand]: true;
};

export const opaqueIdSchema = z.string()
  .min(16)
  .max(128)
  .regex(/^[a-zA-Z0-9_-]+$/, "identifier must be opaque and route-safe")
  .transform((value) => value as OpaqueResourceId);

export function parseOpaqueResourceId(value: unknown): OpaqueResourceId {
  return opaqueIdSchema.parse(value);
}
