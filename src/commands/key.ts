import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { Command } from "commander";

export function registerKey(program: Command): void {
  program.command("key").description("Manage the local Gemini API key.")
    .command("set").description("Enter a key privately on this terminal.")
    .option("--env-file <path>", "Existing dotenv path", ".env")
    .action(async (flags: { envFile: string }) => {
      await setKey(flags.envFile);
    });
}

export async function setKey(
  path: string,
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
): Promise<void> {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("key set requires an interactive TTY; do not pipe or paste keys through chat.");
  }
  const key = await readHiddenKey(input, output);
  if (!key || /\s/.test(key)) throw new Error("The key must be non-empty and contain no whitespace.");
  const destination = resolve(path);
  let previous = "";
  try { previous = await readFile(destination, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const eol = previous.includes("\r\n") ? "\r\n" : "\n";
  let replaced = false;
  // Quoting preserves #, quotes and backslashes without evaluating the value.
  const assignment = `GEMINI_API_KEY=${JSON.stringify(key)}`;
  let next = previous.replace(/^(?:export[ \t]+)?GEMINI_API_KEY[ \t]*=[^\r\n]*(\r?\n|$)/gm, (_line, newline: string) => {
    if (replaced) return "";
    replaced = true;
    return assignment + newline;
  });
  if (!replaced) next += (next && !next.endsWith("\n") ? eol : "") + assignment + eol;
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, next, { mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    await rename(temporary, destination);
  } finally { await rm(temporary, { force: true }); }
  output.write(`saved to ${destination} (0600)\n`);
}

async function readHiddenKey(input: NodeJS.ReadStream, output: NodeJS.WriteStream): Promise<string> {
  const wasRaw = input.isRaw;
  const wasPaused = input.isPaused();
  return new Promise((resolveKey, reject) => {
    let value = "";
    const finish = (error?: Error) => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
      input.setRawMode(wasRaw);
      if (wasPaused) input.pause();
      output.write("\n");
      if (error) reject(error); else resolveKey(value);
    };
    const onEnd = () => finish(new Error("Key entry ended before submission."));
    const onError = () => finish(new Error("Key entry failed."));
    const onData = (chunk: Buffer | string) => {
      for (const character of chunk.toString()) {
        if (character === "\u0003" || character === "\u0004") { finish(new Error("Key entry canceled.")); return; }
        if (character === "\r" || character === "\n") { finish(); return; }
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else value += character;
      }
    };
    input.setRawMode(true);
    input.on("data", onData);
    input.once("end", onEnd);
    input.once("error", onError);
    output.write("Gemini API key: ");
    input.resume();
  });
}
