import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const overrides = new Map([
  ["@sentry/server-utils@10.73.0", {
    file: new URL("./overrides/sentry-server-utils-10.73.0.LICENSE", import.meta.url),
    source: "https://github.com/getsentry/sentry-javascript/blob/f109d922f5971e2ade549b6c755524168b101818/LICENSE",
    sha256: "497d5a7036220d5763088d161612f9f7f2e499fe3ce186826f4369b465769312",
  }],
]);

const ownLicence = /^(?:licen[cs]e|copying)(?:[-.](?:mit|apache(?:-2\.0)?|bsd|isc))?(?:\.(?:md|txt|rst))?$/i;
const attribution = /^(?:notice|attributions?|copyright)(?:[.-].*)?$|^(?:third-party-licen[cs]es?|licen[cs]e-3rdparty)(?:\..*)?$/i;

async function licenceFiles(root, dir = "") {
  const files = [];
  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    const path = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== ".git") files.push(...await licenceFiles(root, path));
    } else if (ownLicence.test(entry.name) || attribution.test(entry.name)) {
      files.push(path);
    }
  }
  return files;
}

// Some MIT packages publish their complete grant in a README licence section.
async function readmeLicence(root, license) {
  if (license !== "MIT") return;
  const name = (await readdir(root)).find(file => /^readme\.md$/i.test(file));
  if (!name) return;
  const readme = await readFile(join(root, name), "utf8");
  const heading = /^(?:#{1,6}\s+licen[cs]e\s*$|licen[cs]e\r?\n[-=]+\s*$)/im.exec(readme);
  if (!heading) return;
  const section = readme.slice(heading.index + heading[0].length).trimStart();
  const grant = section.match(/^[^#]*?copyright\b[^#]*?(permission is hereby granted,[^#]*?other dealings in the software\.)/i);
  if (!grant) return;
  // Compare the full terms, allowing line wrapping and typographical differences.
  const projectMIT = await readFile("LICENSE", "utf8");
  const normalize = terms => terms.replace(/['"]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
  if (normalize(grant[1]) === normalize(projectMIT.slice(projectMIT.indexOf("Permission is hereby granted")))) {
    return { label: name, text: grant[0] };
  }
}

async function packageNotices(root, locked) {
  // The release job installs bun.lock with --frozen-lockfile. Read the manifest
  // beside the contributing module, including for nested versions and tarballs.
  const { name, version, license } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const key = `${name}@${version}`;
  if (![name, version, license].every(value => typeof value === "string" && value.trim())) {
    throw new Error(`Missing package identity or licence identifier for ${key}`);
  }
  if (!locked.has(key)) {
    // URL tarballs have no version in the lock resolution. Match the installed
    // tarball's integrity marker and use the version in its own manifest.
    const integrity = await readFile(join(root, ".bun-tag"), "utf8").catch(() => "");
    if (!integrity || !locked.has(`${name}@${integrity.trim()}`)) throw new Error(`Missing lock resolution for ${key}`);
  }
  const own = [];
  const other = [];
  for (const file of (await licenceFiles(root)).sort()) {
    const text = await readFile(join(root, file), "utf8");
    if (!text.trim()) throw new Error(`Empty licence or notice for ${key}: ${file}`);
    const group = ownLicence.test(file) ? own : other;
    group.push({ label: file, text });
  }
  if (!own.length) {
    const readme = await readmeLicence(root, license);
    if (readme) own.push(readme);
  }
  const override = overrides.get(key);
  if (override) {
    if (own.length) throw new Error(`Stale licence override for ${key}`);
    const bytes = await readFile(override.file).catch(cause => {
      throw new Error(`Missing upstream licence for ${key}`, { cause });
    });
    if (createHash("sha256").update(bytes).digest("hex") !== override.sha256) {
      throw new Error(`Licence digest mismatch for ${key}`);
    }
    own.push({ label: `Licence from upstream source: ${override.source}\nSHA-256: ${override.sha256}`, text: bytes.toString("utf8") });
  }
  if (!own.length) throw new Error(`Missing licence text for ${key}`);
  const parts = [...own, ...other].map(({ label, text }) => `${label}\n\n${text}`);
  return { row: [name, version, license].join("\t"), section: `----- ${key} -----\n\n${parts.join("\n\n")}` };
}

async function releaseNotices(metafile, locked) {
  const outputs = Object.entries(metafile.outputs).filter(([path]) => basename(path) === "frameofmind.mjs");
  if (outputs.length !== 1) throw new Error("Missing single-file bundle output in Bun metafile");
  const roots = new Set();
  // Include only installed packages with positive bytes attributed to this output.
  for (const [path, { bytesInOutput }] of Object.entries(outputs[0][1].inputs)) {
    if (bytesInOutput === 0) continue;
    if (!Number.isSafeInteger(bytesInOutput) || bytesInOutput < 0) throw new Error(`Invalid byte count for ${path}`);
    const parts = resolve(path).split(/[\\/]/);
    const i = parts.lastIndexOf("node_modules");
    if (i !== -1) {
      const length = i + (parts[i + 1].startsWith("@") ? 3 : 2);
      roots.add(parts.slice(0, length).join("/"));
    }
  }
  if (!roots.size) throw new Error("Bun reported no contributing packages for the release");
  const sections = new Map();
  for (const root of roots) {
    const { row, section } = await packageNotices(root, locked);
    if (sections.has(row) && sections.get(row) !== section) throw new Error(`Conflicting notices for ${row}`);
    sections.set(row, section);
  }
  const rows = [...sections.keys()].sort();
  return [
    "Third-party notices for frameofmind.mjs",
    "Includes installed packages with positive bytes attributed to the bundle by Bun.",
    "", "Package   Version   Licence (tab-separated)", ...rows, "",
    ...rows.map(row => sections.get(row) + "\n"),
  ].join("\n");
}

const [metaPath, destination] = process.argv.slice(2);
const lock = Bun.JSONC.parse(await readFile("bun.lock", "utf8"));
const locked = new Set();
for (const [resolution, ...details] of Object.values(lock.packages)) {
  const tarball = resolution.match(/^(.+?)@https?:\/\//);
  locked.add(tarball ? `${tarball[1]}@${details.at(-1)}` : resolution);
}
await writeFile(destination, await releaseNotices(JSON.parse(await readFile(metaPath, "utf8")), locked));
