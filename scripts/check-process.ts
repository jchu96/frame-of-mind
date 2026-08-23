import {
  spawn,
  spawnSync,
  type ChildProcess,
  type StdioOptions,
} from "node:child_process";

export interface TimedProcessResult {
  readonly exitCode: number;
  readonly timedOut: boolean;
}

export async function runTimedProcess(
  command: string[],
  options: {
    readonly cwd: string;
    readonly env: Record<string, string | undefined>;
    readonly timeoutSeconds: number;
    readonly stdin?: "ignore" | "inherit";
    readonly stdout?: "inherit" | "pipe";
    readonly stderr?: "inherit" | "pipe";
    readonly onStart?: (child: ChildProcess) => void;
    readonly onFinish?: () => void;
  },
): Promise<TimedProcessResult> {
  const child = spawn(command[0]!, command.slice(1), {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: [
      options.stdin ?? "ignore",
      options.stdout ?? "inherit",
      options.stderr ?? "inherit",
    ] as StdioOptions,
  });
  options.onStart?.(child);
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    killOwnedProcessGroup(child, "SIGTERM");
    setTimeout(() => {
      killOwnedProcessGroup(child, "SIGKILL", true);
    }, 2_000).unref?.();
  }, options.timeoutSeconds * 1_000);
  timeout.unref?.();

  try {
    const exitCode = await new Promise<number>((resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        resolveExit(code ?? (signal ? 1 : 0));
      });
    });
    return { exitCode: timedOut ? 124 : exitCode, timedOut };
  } finally {
    clearTimeout(timeout);
    options.onFinish?.();
  }
}

export function killOwnedProcessGroup(
  child: ChildProcess,
  signal: NodeJS.Signals,
  includeExitedLeader = false,
): void {
  if (!includeExitedLeader && child.exitCode !== null) return;
  if (process.platform === "win32") {
    if (child.pid) {
      spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
      });
    }
    return;
  }
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
