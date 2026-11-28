import type { FrameTiming } from "./frame-timing.js";

export const CLI_SCHEMA_VERSION = 1;

/** Stable categories shared by the CLI and MCP startup. */
export const faultExits = {
  COMMAND_FAILED: 1,
  DECODE_FAILED: 1,
  INVALID_PROJECTION: 1,
  PROVIDER_REFUSED: 1,
  RATE_LIMITED: 1,
  USAGE: 2,
  BAD_ARGUMENTS: 2,
  UNKNOWN_TOOL: 2,
  BAD_CURSOR: 2,
  OUTCOME_UNKNOWN: 3,
  INVALID_INPUT: 4,
  INVALID_RATE: 4,
  INVALID_TIMECODE: 4,
  NOT_ON_FRAME_BOUNDARY: 4,
  UNREPRESENTABLE: 4,
  RECORDING_TOO_LONG: 4,
  SNAPSHOT_TOO_LARGE: 4,
  RESULT_TOO_LARGE: 4,
  USE_LIST_RECORDS: 4,
  KEY_MISSING: 10,
  KEY_REFUSED: 10,
  PERMISSION_DENIED: 11,
  PATH_OUTSIDE_ROOTS: 11,
  UNSAFE_SNAPSHOT: 11,
  UPLOAD_OTHER_KEY: 11,
  ROOTS_MISSING: 11,
  ROOTS_UNREADABLE: 11,
  ROOTS_INVALID: 11,
  ROOTS_EMPTY: 11,
  ACTION_DISABLED: 11,
  MODEL_DENIED: 11,
  CALL_LIMIT: 11,
  MEDIA_LIMIT: 11,
  PROVIDER_LIMIT: 11,
  FILE_LIMIT: 11,
  PROVIDER_UNREACHABLE: 20,
  NOT_FOUND: 20,
  CAPABILITY_MISSING: 20,
  UPLOAD_EXPIRED: 20,
  RUN_NOT_FOUND: 20,
  BUN_REQUIRED: 20,
  JOB_NOT_FOUND: 20,
  UNKNOWN_SCHEMA: 21,
  CONFLICT: 30,
  SNAPSHOT_CHANGED: 30,
  SNAPSHOT_NOT_CLOSED: 30,
  JOB_PENDING: 30,
  REQUEST_CONFLICT: 30,
  UNKNOWN_JOB_REQUIRED: 30,
  CANCELLED: 130,
} as const;
export type FaultCode = keyof typeof faultExits;

export class ContractError extends Error {
  constructor(readonly code: FaultCode, message: string, readonly details?: Record<string, unknown>) {
    super(message);
  }
}

export class FrameGridError extends ContractError {
  constructor(readonly frameTiming: Extract<FrameTiming, {varying: boolean}>) {
    const reason = frameTiming.varying ? "This clip’s frame rate varies."
      : "This clip has uneven frame spacing.";
    super("INVALID_RATE", reason + " Analyze and transcribe still run on the whole recording.", {frameTiming});
  }
}

export class MissingJobArgumentError extends ContractError {
  constructor(argument: "out" | "file") {
    super("NOT_FOUND", argument === "out" ? "The --out folder does not exist." : "The input file does not exist.", {argument});
  }
}

const filesystemCodes: Record<string, FaultCode> = {
  ENOENT: "NOT_FOUND", ENOTDIR: "NOT_FOUND", EPERM: "PERMISSION_DENIED", EACCES: "PERMISSION_DENIED",
  EEXIST: "CONFLICT", ELOOP: "PATH_OUTSIDE_ROOTS",
};

export function faultCode(error: unknown): FaultCode {
  if (error instanceof Error && error.name === "AbortError") return "CANCELLED";
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string") {
    if (Object.hasOwn(faultExits, code)) return code as FaultCode;
    if (Object.hasOwn(filesystemCodes, code)) return filesystemCodes[code]!;
  }
  return "COMMAND_FAILED";
}

export function failureDocument(code: FaultCode, details?: Record<string, unknown>) {
  // Exception messages can include file contents, paths or provider responses.
  const message = code === "USAGE" ? "Invalid command arguments." : code.replaceAll("_", " ").toLowerCase() + ".";
  return { schemaVersion: CLI_SCHEMA_VERSION, error: { code, message, ...(details && { details }) } };
}
