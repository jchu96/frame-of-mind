import { closeSync, openSync, writeSync } from "node:fs";
import { devNull } from "node:os";
import type { Family } from "../adapters/job-record.js";
import { runCli, writeDocument, writeFailure } from "../cli-contract.js";
import { runJob, type JobDependencies, type JobOperation, type JobOptions } from "../services/cli-job.js";
import { jobCommand, rejectDuplicateJobOptions } from "./job-commands.js";

async function closeOutput(data: object) {
  // Both Node and Bun keep their process.stdout stream alive after end().
  // This single small admission document owns descriptor 1 in job mode.
  const bytes = Buffer.from(JSON.stringify({schemaVersion: 1, ...data}) + "\n");
  for (let offset = 0; offset < bytes.length;) offset += writeSync(1, bytes, offset, bytes.length - offset);
  closeSync(1);
  // Reserve stdout for the process lifetime so future opens cannot reuse 1.
  // A caller may have launched us with descriptor 0 already closed.
  if (openSync(devNull, "w") === 0) openSync(devNull, "w");
}

export async function runJobCommand(family: Family, op: JobOperation, args: string[], deps: JobDependencies = {},
  output = {write: writeDocument, admit: closeOutput}) {
  let admitted = false;
  try {
    rejectDuplicateJobOptions(args);
    const cmd = jobCommand(family, op).action(async (arg: string, flags: JobOptions) => {
      const result = await runJob(family, op, arg, flags, async data => {
        await output.admit(data);
        admitted = true;
      }, deps).catch(error => {
        if (!admitted) throw error;
      });
      if (result) output.write(result);
    });
    await runCli(cmd, args);
  } catch (error) { writeFailure(error); }
}
