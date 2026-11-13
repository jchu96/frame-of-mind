import { PassThrough } from "node:stream";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setKey } from "../src/commands/key.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(previous = "") {
  const root = await mkdtemp(join(tmpdir(), "fom-key-")); roots.push(root);
  const path = join(root, ".env"); await writeFile(path, previous);
  let captured = "";
  const output = new PassThrough(); output.on("data", data => { captured += data.toString(); });
  class Terminal extends PassThrough {
    isTTY = true;
    isRaw = false;
    setRawMode(enabled: boolean) { this.isRaw = enabled; return this; }
    send(text: string) {
      // Model the terminal's refusal to hide input unless echo was disabled.
      for (const character of text) {
        if (!this.isRaw) output.write(character);
        this.emit("data", Buffer.from(character));
      }
    }
  }
  const input = new Terminal();
  const run = () => setKey(path, input as unknown as NodeJS.ReadStream, output as unknown as NodeJS.WriteStream);
  return { path, input, run, captured: () => captured };
}

describe("hidden", () => {
  it("no byte of the sentinel key reaches stdout or stderr", async () => {
    const f = await fixture(); const run = f.run(); f.input.send("AIza-TEST-SENTINEL\r"); await run;
    expect(f.captured()).not.toContain("AIza-TEST-SENTINEL");
    expect(f.captured()).toBe(`Gemini API key: \nsaved to ${f.path} (0600)\n`);
    expect(await readFile(f.path, "utf8")).toContain("AIza-TEST-SENTINEL");
    expect((await stat(f.path)).mode & 0o777).toBe(0o600);
    expect(f.input.isRaw).toBe(false);
  });
  it.each(["", "contains space"])("rejects invalid input without printing it: %s", async (value) => {
    const f = await fixture("OTHER=preserved\n"); const run = f.run(); f.input.send(value + "\r");
    await expect(run).rejects.toThrow("non-empty"); expect(await readFile(f.path, "utf8")).toBe("OTHER=preserved\n");
  });
  it("restores raw mode on cancellation and writes no key", async () => {
    const f = await fixture(); const run = f.run(); f.input.send("partial\u0003");
    await expect(run).rejects.toThrow("canceled"); expect(f.input.isRaw).toBe(false);
    expect(await readFile(f.path, "utf8")).toBe("");
  });
});
describe("tty", () => {
  it("non-TTY stdin is refused and .env is unchanged", async () => {
    const f = await fixture("OTHER=preserved\n"); f.input.isTTY = false;
    const run = f.run(); f.input.send("AIza-TEST-SENTINEL\r");
    await expect(run).rejects.toThrow("interactive TTY");
    expect(await readFile(f.path, "utf8")).toBe("OTHER=preserved\n");
  });
});
describe("env", () => {
  it("existing lines other than GEMINI_API_KEY are preserved byte for byte", async () => {
    const f = await fixture("# comment\r\nOTHER='keep # this'\r\nGEMINI_API_KEY=old\r\nLAST=ok\r\nGEMINI_API_KEY=duplicate\r\n");
    const run = f.run(); f.input.send("AIza-TEST-SENTINEL\r"); await run;
    expect(await readFile(f.path, "utf8")).toBe("# comment\r\nOTHER='keep # this'\r\nGEMINI_API_KEY=\"AIza-TEST-SENTINEL\"\r\nLAST=ok\r\n");
  });
});
