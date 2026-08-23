import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "bun:test";

describe("E2E resource isolation", () => {
  test("serializes resource-heavy harnesses across processes", async () => {
    const root = await mkdtemp(join(tmpdir(), "frame-of-mind-e2e-lock-test-"));
    const lockPath = join(root, "frame-of-mind-e2e-runtime.lock");
    const receiptPath = join(root, "receipt.jsonl");
    const helperUrl = pathToFileURL(
      resolve("apps/web/e2e/support/isolation.ts"),
    ).href;
    await mkdir(lockPath);
    await writeFile(join(lockPath, "owner.json"), JSON.stringify({
      pid: 999_999,
      token: "stale-test-owner",
      acquiredAt: "2026-08-22T00:00:00.000Z",
    }));

    const run = (label: string) => Bun.spawn([
      process.execPath,
      "--no-env-file",
      "-e",
      `
        import { appendFile } from "node:fs/promises";
        import { acquireE2EResourceLease } from ${JSON.stringify(helperUrl)};
        const lease = await acquireE2EResourceLease(${JSON.stringify(lockPath)});
        try {
          await appendFile(${JSON.stringify(receiptPath)}, JSON.stringify({
            label: ${JSON.stringify(label)}, event: "start", at: Date.now(),
          }) + "\\n");
          await Bun.sleep(300);
          await appendFile(${JSON.stringify(receiptPath)}, JSON.stringify({
            label: ${JSON.stringify(label)}, event: "end", at: Date.now(),
          }) + "\\n");
        } finally {
          await lease.release();
        }
      `,
    ], {
      cwd: process.cwd(),
      env: process.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      const children = [run("a"), run("b")];
      const results = await Promise.all(children.map(async (child) => ({
        exitCode: await child.exited,
        stderr: await new Response(child.stderr).text(),
      })));
      expect(results).toEqual([
        { exitCode: 0, stderr: "" },
        { exitCode: 0, stderr: "" },
      ]);

      const events = (await readFile(receiptPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as {
          label: string;
          event: "start" | "end";
          at: number;
        });
      const ranges = ["a", "b"].map((label) => ({
        label,
        start: events.find((event) =>
          event.label === label && event.event === "start"
        )?.at,
        end: events.find((event) =>
          event.label === label && event.event === "end"
        )?.at,
      })).sort((left, right) => Number(left.start) - Number(right.start));
      expect(ranges.every((range) =>
        Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end)
      )).toBe(true);
      expect(Number(ranges[1]?.start)).toBeGreaterThanOrEqual(
        Number(ranges[0]?.end),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
