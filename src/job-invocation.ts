import type { JobOperation } from "./services/cli-job.js";

export const operations = ["start", "status", "result", "cancel", "dry-run"] as const;
export function jobInvocation(args: string[]) {
  const [family, operation] = args;
  if ((family !== "analyze" && family !== "transcribe") || !operations.includes(operation as JobOperation)) return;
  if (operation === "dry-run" && family !== "analyze") return;
  // Without job flags, preserve a human recording or meeting literally named
  // "start", "status", etc. Source-backed human analyzes can also request JSON.
  const hasGrant = args.some(arg => /^--(?:out|request-id|media-root|output-root|roots-file)(?:=|$)/.test(arg));
  if (!hasGrant && !args[2]?.match(/^[^-]/)) return;
  return {family, op: operation as JobOperation} as const;
}
