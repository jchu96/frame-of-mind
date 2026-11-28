import { z } from "zod";
import { actorSchema } from "./candidates.js";
import { ContractError } from "./contract-error.js";

export const recipeRolesSchema = z.strictObject({proposer:z.string().optional(),grader:z.string().optional()});
type Roles = z.infer<typeof recipeRolesSchema>;
const role = actorSchema.extend({source:z.enum(["flag","recipe","default","file"])});
const route = z.strictObject({proposer:role,grader:role});
export const enginePlanSchema = z.strictObject({
  planned:route.nullable(),used:route.nullable(),expected:route.nullable(),reason:z.null(),
  retention:z.strictObject({gemini:z.enum(["provider","run"]).nullable(),twelvelabs:z.null()}),
});
export type EnginePlan = z.infer<typeof enginePlanSchema>;
const state = z.enum(["cut","snapped","claim","skipped","failed"]);
export const engineItemsSchema = z.array(z.strictObject({candidateId:z.string(), proposedBy:actorSchema,gradedBy:actorSchema.nullable(),
  edges:z.strictObject({start:state,end:state})}));
export type EngineItems = z.infer<typeof engineItemsSchema>;

export function checkRoles(flags: Roles, file: boolean, recipe: Roles = {}) {
  if (file && flags.proposer !== undefined) throw new ContractError("USAGE","Conflicting proposer options.",{reason:"conflicting-options"});
  const proposer = file ? undefined : flags.proposer ?? recipe.proposer;
  const grader = flags.grader ?? recipe.grader;
  if ([proposer,grader].some(engine => engine !== undefined && engine !== "gemini")) {
    throw new ContractError("USAGE","Unsupported engine.",{reason:"unsupported-engine"});
  }
}

export function enginePlan(options: Roles & {file:boolean; recipe?:Roles; model:string; retention:"provider"|"run"; available:boolean; preview:boolean}): EnginePlan {
  checkRoles(options,options.file,options.recipe);
  const selected = (key: keyof Roles): z.infer<typeof role> => ({engine:"gemini",model:options.model,
    source:options[key] !== undefined ? "flag" : options.recipe?.[key] !== undefined ? "recipe" : "default"});
  const planned = options.available ? {proposer:options.file ? {engine:"file",model:null,source:"file" as const} : selected("proposer"), grader:selected("grader")} : null;
  return {planned,expected:options.preview ? planned : null,used:options.preview ? null : planned,reason:null,
    retention:{gemini:planned ? options.retention : null,twelvelabs:null}};
}
