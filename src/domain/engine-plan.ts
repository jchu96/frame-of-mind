import { z } from "zod";
import { actorSchema } from "./candidates.js";
import { ContractError, UsageError } from "./contract-error.js";

export const recipeRolesSchema = z.strictObject({proposer:z.string().optional(),grader:z.string().optional()});
type Roles = z.infer<typeof recipeRolesSchema>;
const role = actorSchema.extend({source:z.enum(["flag","recipe","default","file"])});
const route = z.strictObject({proposer:role,grader:role});
export const engineNames = ["gemini","twelvelabs"] as const;
export type EngineName = typeof engineNames[number];
export const engineReason = z.enum(["index-timeout","quota","media-limit","rate-limit","network","request-timeout",
  "key-refused","invalid-reply","local-media-unavailable","receipts-unreadable"]);
export type EngineReason = z.infer<typeof engineReason>;
export const PEGASUS_MODEL = "pegasus1.6";
export const DIRECT_UPLOAD_BYTES = 200_000_000;
export const pictureLimitHint = "Twelve Labs requires a verified picture from 360×360 to 5184×2160 with an aspect ratio between 1:2.4 and 2.4:1.";
export const durationLimitHint = "Twelve Labs accepts analysis windows from one second through two hours, in a source of up to four hours.";
export const soundOnlyHint = "Twelve Labs requires a picture. Use Gemini for a sound-only recording.";
export const directUploadHint = "Twelve Labs accepts direct uploads up to 200 MB. A shorter time range can bring the upload under the limit.";

export const enginePlanSchema = z.strictObject({
  planned:route.nullable(),used:route.nullable(),expected:route.nullable(),reason:engineReason.nullable(),
  graderToldClaim:z.boolean().optional(), receiptIds:z.array(z.string()).optional(),
  retention:z.strictObject({gemini:z.enum(["provider","run"]).nullable(),twelvelabs:z.literal("run").nullable()}),
});
export type EnginePlan = z.infer<typeof enginePlanSchema>;
const state = z.enum(["cut","snapped","claim","skipped","failed"]);
export const engineItemsSchema = z.array(z.strictObject({candidateId:z.string(), proposedBy:actorSchema,gradedBy:actorSchema.nullable(),
  edges:z.strictObject({start:state,end:state})}));
export type EngineItems = z.infer<typeof engineItemsSchema>;

export function checkRoles(flags: Roles, file: boolean, recipe: Roles = {}) {
  if (file && flags.proposer !== undefined) throw new UsageError("conflicting-options", "Conflicting proposer options.");
  const proposer = file ? undefined : flags.proposer ?? recipe.proposer;
  const grader = flags.grader ?? recipe.grader;
  if ([proposer,grader].some(engine => engine !== undefined && engine !== "gemini" && engine !== "twelvelabs")) {
    throw new UsageError("unsupported-engine", "Unsupported engine.");
  }
}

export function enginePlan(options: Roles & {file:boolean; recipe?:Roles; model:string; retention:"provider"|"run";
  available:boolean; twelveAvailable?:boolean; preview:boolean; withholdGraderClaim?:boolean; preflight?:EngineReason}): EnginePlan {
  checkRoles(options,options.file,options.recipe);
  const keys = {gemini:options.available,twelvelabs:Boolean(options.twelveAvailable)};
  for (const name of [options.file ? undefined : options.proposer ?? options.recipe?.proposer,options.grader ?? options.recipe?.grader]) {
    if (name && !keys[name as EngineName]) throw new ContractError("KEY_MISSING","Set the selected engine key before analysis.",{engine:name});
  }
  function select(key: keyof Roles): z.infer<typeof role> {
    if (key === "proposer" && options.file) return {engine:"file",model:null,source:"file"};
    const choice = options[key] ?? options.recipe?.[key];
    const preferred = key === "proposer" ? "twelvelabs" : "gemini";
    const engine = (choice ?? (keys[preferred] ? preferred : preferred === "gemini" ? "twelvelabs" : "gemini")) as EngineName;
    if (!keys[engine]) throw new ContractError("KEY_MISSING", "Set the selected engine key before analysis.", {engine});
    return {engine,model:engine === "gemini" ? options.model : PEGASUS_MODEL,
      source:options[key] !== undefined ? "flag" : choice !== undefined ? "recipe" : "default"};
  }
  const anyChoice = options.grader ?? options.recipe?.grader ?? (!options.file ? options.proposer ?? options.recipe?.proposer : undefined);
  const planned = keys.gemini || keys.twelvelabs || anyChoice ? {proposer:select("proposer"),grader:select("grader")} : null;
  const uses = (engine:EngineName) => planned?.proposer.engine === engine || planned?.grader.engine === engine;
  const plan:EnginePlan = {planned,expected:options.preview ? planned : null,used:options.preview ? null : planned,reason:null,
    retention:{gemini:uses("gemini") ? options.retention : null,twelvelabs:uses("twelvelabs") ? "run" : null},
    graderToldClaim:!options.withholdGraderClaim};
  if (options.preflight && defaultDualRoute(plan)) fallbackPlan(plan,options.preflight);
  return plan;
}

export function defaultDualRoute(plan: EnginePlan) {
  const r = plan.planned;
  return r?.proposer.engine === "twelvelabs" && r.grader.engine === "gemini"
    && r.proposer.source === "default" && r.grader.source === "default";
}
export function fallbackPlan(plan: EnginePlan, reason: EngineReason) {
  const grader = plan.planned!.grader;
  const fallback = {proposer:{...grader},grader:{...grader}};
  plan.reason = reason;
  if (plan.expected) plan.expected = fallback;
  else plan.used = fallback;
}

export function usesTwelveLabs(plan: EnginePlan) {
  const route = plan.used ?? plan.expected;
  return route?.proposer.engine === "twelvelabs" || route?.grader.engine === "twelvelabs";
}

export function geminiRetry(argv: readonly string[], file: boolean) {
  const retry: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--proposer" || arg === "--grader") i++;
    else if (!arg.startsWith("--proposer=") && !arg.startsWith("--grader=") && arg !== "--dry-run") retry.push(arg);
  }
  if (!file) retry.push("--proposer", "gemini");
  return [...retry, "--grader", "gemini"];
}

/** Doctor previews unavailable routes as well. An analysis or dry-run supplies its retry arguments. */
export function checkReceiptAccess(plan:EnginePlan, scan:{readable:boolean;path:string|null}, argv?:readonly string[]) {
  if (scan.readable) return;
  const message = scan.path
    ? `Twelve Labs scratch receipts are unreadable or unsafe in ${scan.path}. Check the folder, receipt files and their permissions.`
    : "The private account folder for Twelve Labs scratch receipts could not be located.";
  if (!usesTwelveLabs(plan)) return message;
  if (defaultDualRoute(plan)) {
    fallbackPlan(plan,"receipts-unreadable");
    plan.retention.twelvelabs = null;
  } else if (argv) {
    throw new ContractError("CAPABILITY_MISSING",message,{engine:"twelvelabs",phase:"prepare",sent:false,
      reason:"receipts-unreadable",retryWith:geminiRetry(argv,plan.planned!.proposer.engine === "file")});
  } else {
    plan.expected = null;
    plan.reason = "receipts-unreadable";
  }
  return message;
}

/** Inspect only the local selection. The same planner serves execution and preview. */
export function checkDirectUpload(plan: EnginePlan, bytes: number | undefined, argv: readonly string[],
  selection?: {soundOnly:boolean; duration?:number; picture?:{width?:number;height?:number}}) {
  if (!usesTwelveLabs(plan)) return;
  let message: string | undefined;
  if (bytes === undefined) message = "Twelve Labs requires local recording bytes.";
  else if (bytes > DIRECT_UPLOAD_BYTES) message = directUploadHint;
  else if (selection?.soundOnly) message = soundOnlyHint;
  else if (selection) {
    const {width,height} = selection.picture ?? {};
    if (!width || !height || width < 360 || height < 360 || width > 5184 || height > 2160 || Math.max(width,height)*10 > Math.min(width,height)*24)
      message = pictureLimitHint;
    else if (selection.duration !== undefined &&
      (selection.duration < 1 || selection.duration > (plan.planned!.proposer.engine === "twelvelabs" ? 7200 : 14400)))
      message = durationLimitHint;
  }
  if (!message) return;
  const reason = bytes === undefined ? "local-media-unavailable" : "media-limit";
  if (defaultDualRoute(plan)) {
    fallbackPlan(plan, reason);
    plan.retention.twelvelabs = null;
    return message;
  }
  throw new ContractError(bytes === undefined ? "CAPABILITY_MISSING" : "PROVIDER_LIMIT",message,{
    engine:"twelvelabs",phase:"upload",reason,retryWith:geminiRetry(argv,plan.planned!.proposer.engine === "file"),
  });
}

export function fallbackMessage(reason: EngineReason) {
  return `Twelve Labs could not propose (${reason}). Using Gemini to propose and grade.`;
}
export function disclosure(plan: EnginePlan, segments?: import("./segment-definitions.js").SegmentDefinitions): string[] {
  const route = plan.planned;
  if (!route) return ["No engine key is configured."];
  const lines:string[] = [];
  if (route.grader.engine === "gemini" && route.proposer.engine !== "twelvelabs") {
    lines.push(route.proposer.engine === "file" ? "Gemini grades selected video, windows, stills and scoped context. Candidates come from the file."
      : "Gemini proposes on selected video and grades windows, stills and scoped context.");
    lines.push("retention: "+plan.retention.gemini);
    if (!plan.graderToldClaim) lines.push("The proposal claim is withheld from the grader.");
    return lines;
  }
  if (route.proposer.engine === "file") lines.push("Candidates come from the file.");
  for (const [engine,name] of [["gemini","Gemini"],["twelvelabs","Twelve Labs"]] as const) {
    const purposes:string[] = [];
    if (route.proposer.engine === engine) purposes.push("proposes on selected video with the operator’s proposal instruction, focus and segment definitions");
    if (route.grader.engine === engine) purposes.push("grades selected video, windows, stills and scoped context");
    if (engine === "gemini" && defaultDualRoute(plan)) purposes.push("may propose on the selection if Twelve Labs cannot");
    if (!purposes.length) continue;
    lines.push(name+" "+purposes.join(" and ")+". "+(plan.retention[engine] === "provider" ?
      name+" retains its upload until provider expiry." : name+" deletes its scratch copies at run end."));
  }
  if (route.proposer.engine === "twelvelabs" && segments) {
    for (const def of segments) {
      const images = def.media_sources?.map(image=>image.name).join(", ");
      lines.push("Twelve Labs receives recipe definition "+def.id+(images ? " with reference images "+images : "")+".");
    }
  }
  if (route.proposer.engine === route.grader.engine || route.proposer.engine === "file")
    lines.push("Runs use "+(route.grader.engine === "gemini" ? "Gemini" : "Twelve Labs")+" alone.");
  if (!plan.graderToldClaim) lines.push("The proposal claim is withheld from the grader.");
  return lines;
}
