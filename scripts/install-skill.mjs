#!/usr/bin/env node
import { cp, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(repositoryRoot, ".agents", "skills", "frame-of-mind");
const markerName = ".frame-of-mind-managed.json";
const skillHome = process.env.FRAME_OF_MIND_SKILL_HOME || homedir();
const targets = {
  agents: join(skillHome, ".agents", "skills", "frame-of-mind"),
  codex: join(skillHome, ".codex", "skills", "frame-of-mind"),
  claude: join(skillHome, ".claude", "skills", "frame-of-mind"),
};

const options = parseArguments(process.argv.slice(2));
const selected = options.target === "all"
  ? Object.entries(targets)
  : [[options.target, targets[options.target]]];

for (const [name, destination] of selected) {
  await install(name, destination, options.force);
}

async function install(name, destination, force) {
  const existing = await pathKind(destination);
  if (existing) {
    const managed = await isManaged(destination);
    if (!managed && !force) {
      throw new Error(
        `${destination} already exists and is not marked as a Frame of Mind installation. ` +
        "Move it aside or rerun with --force after reviewing the target.",
      );
    }
    await rm(destination, { recursive: true, force: true });
  }
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, dereference: true });
  await writeFile(
    join(destination, markerName),
    `${JSON.stringify({
      package: "frameofmind",
      source: "jchu96/frame-of-mind",
      installedAt: new Date().toISOString(),
      target: name,
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
  process.stdout.write(`Installed Frame of Mind skill for ${name}: ${destination}\n`);
}

async function pathKind(path) {
  try {
    const stat = await lstat(path);
    return stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : "file";
  } catch (error) {
    if (error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function isManaged(destination) {
  try {
    const content = JSON.parse(await readFile(join(destination, markerName), "utf8"));
    return content?.package === "frameofmind" && content?.source === "jchu96/frame-of-mind";
  } catch {
    return false;
  }
}

function parseArguments(args) {
  let target = "all";
  let force = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--force") {
      force = true;
      continue;
    }
    if (argument === "--target") {
      target = args[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument '${argument}'. Use --target agents|codex|claude|all and optional --force.`);
  }
  if (!["agents", "codex", "claude", "all"].includes(target)) {
    throw new Error(`Unknown target '${target}'. Use agents, codex, claude, or all.`);
  }
  return { target, force };
}
