import { performance } from "node:perf_hooks";
import { ContractError } from "./domain/contract-error.js";
import { keyCommandEnvironment, spawn } from "./lib/child-env.js";

export const KEY_COMMAND_TIMEOUT_MS = 30_000;
export const KEY_COMMAND_MAX_BYTES = 4096;
export class KeyCommandRefused extends ContractError {
  // The fixed word lets a JSON caller tell this from a key the provider refused.
  // Nothing from the command, its arguments or its output is ever added.
  constructor(engine?: "gemini" | "twelvelabs") { super("KEY_REFUSED", "Key command unavailable.", {reason: "key-command", ...(engine && {engine})}); }
}

export function runKeyCommand([executable, ...args]: [string, ...string[]], home: string,
  environment: Readonly<NodeJS.ProcessEnv>, timeout = KEY_COMMAND_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const deadline = performance.now() + timeout;
    let child;
    try {
      child = spawn(executable, args, {cwd: home, env: keyCommandEnvironment(environment),
        shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"]});
    } catch { reject(new KeyCommandRefused()); return; }
    const proc = child;
    let settled = false;
    let bytes = 0;
    const chunks: Buffer[] = [];
    const timer = setTimeout(refuse, Math.max(0, deadline - performance.now()));
    function cleanup() {
      settled = true;
      clearTimeout(timer);
      process.off("SIGINT", refuse);
      process.off("SIGTERM", refuse);
    }
    function refuse() {
      if (settled) return;
      cleanup();
      if (proc.pid) {
        try { process.kill(-proc.pid, "SIGKILL"); } catch { /* Group already ended. */ }
      }
      proc.stdout.destroy();
      proc.stderr.destroy();
      reject(new KeyCommandRefused());
    }
    process.once("SIGINT", refuse);
    process.once("SIGTERM", refuse);
    proc.stdout.on("error", refuse);
    proc.stderr.on("error", refuse);
    proc.on("error", refuse);
    function receive(chunk: Buffer, diagnostic: boolean) {
      bytes += chunk.length;
      if (diagnostic || bytes > KEY_COMMAND_MAX_BYTES || performance.now() >= deadline) return refuse();
      if (!settled) chunks.push(chunk);
    }
    proc.stderr.on("data", (chunk: Buffer) => receive(chunk, true));
    proc.stdout.on("data", (chunk: Buffer) => receive(chunk, false));
    proc.on("exit", (code) => { if (code !== 0) refuse(); });
    proc.once("close", code => {
      if (settled) return;
      if (code !== 0 || performance.now() >= deadline || !proc.stdout.readableEnded || !proc.stderr.readableEnded) return refuse();
      const token = Buffer.concat(chunks).toString("latin1").replace(/\r?\n$/, "");
      if (!token || /[^!-~]/.test(token)) return refuse();
      cleanup();
      resolve(token);
    });
  });
}
