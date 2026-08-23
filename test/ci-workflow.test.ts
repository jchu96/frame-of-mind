import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

describe("CI workflow coverage", () => {
  it("covers the full serial check without overrunning the short check job", async () => {
    const packageJson = JSON.parse(
      await readFile(resolve(repositoryRoot, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    const workflow = await readFile(
      resolve(repositoryRoot, ".github/workflows/ci.yml"),
      "utf8",
    );

    const serial = bunRunScripts(packageJson.scripts.check);
    const shortCheck = bunRunScripts(jobBody(workflow, "check"));
    const hostedContracts = bunRunScripts(jobBody(workflow, "hosted-contracts"));
    const browser = bunRunScripts(jobBody(workflow, "browser-e2e"));

    expect(shortCheck).toEqual([
      "check:repo-hygiene",
      "typecheck",
      "test",
      "test:web",
      "build:cli",
      "build:web",
      "test:studio-http",
    ]);
    expect(hostedContracts).toEqual([
      "test:hosted-access-http",
      "test:hosted-access-http:better-auth",
      "test:hosted-workflows-http",
      "test:hosted-workflows-http:better-auth",
      "test:hosted-media-http",
      "check:hosted-auth",
      "rehearse:hosted-release",
      "spike:studio-streaming",
    ]);
    expect(browser).toContain("test:e2e:ci");

    const workflowCoverage = new Set([
      ...shortCheck,
      ...hostedContracts,
      ...browser.map((script) => script === "test:e2e:ci" ? "check:e2e" : script),
    ]);
    expect([...new Set(serial)].filter((script) => !workflowCoverage.has(script))).toEqual([]);
  });
});

function bunRunScripts(text: string): string[] {
  return [...text.matchAll(/\bbun run ([a-z0-9:-]+)/g)].map((match) => match[1]!);
}

function jobBody(workflow: string, jobName: string): string {
  const header = `  ${jobName}:\n`;
  const start = workflow.indexOf(header);
  if (start === -1) throw new Error(`CI workflow is missing the ${jobName} job.`);
  const body = workflow.slice(start + header.length);
  const nextJob = body.search(/^  [a-z0-9-]+:\n/m);
  return nextJob === -1 ? body : body.slice(0, nextJob);
}
