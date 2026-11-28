import { writeFileSync } from "node:fs";
import { join } from "node:path";

export function writeFixtureRuntime(directory: string): string {
  const script = join(directory, "node");
  const interpreter = process.execPath.replaceAll("'", "'\\''");
  writeFileSync(script, `#!/bin/sh\nexec '${interpreter}' "$@"\n`, {mode: 0o700});
  return script;
}
