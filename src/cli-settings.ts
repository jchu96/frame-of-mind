import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "dotenv";
import { inheritedValue, type CliLaunch } from "./cli-launch.js";
import { useApplicationSettings, type ApplicationSetting } from "./lib/application-settings.js";

interface KeyReport {
  source: "environment" | "dotenv" | "none" | "unknown";
  present: boolean;
  path?: string;
  state?: "unavailable";
  lowerSourcesSkipped?: true;
}

function readSettingsFile(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("Unavailable settings file.");
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}

export function createCliSettings(launch: CliLaunch, read = readSettingsFile) {
  const path = join(launch.cwd, ".env");
  let settings: Record<string, string> | null | undefined;
  function file() {
    if (settings === undefined) {
      try { settings = parse(read(path)); }
      catch (error) { settings = (error as NodeJS.ErrnoException)?.code === "ENOENT" ? {} : null; }
    }
    return settings;
  }
  function select(): {report: KeyReport; value?: string} {
    let value = inheritedValue(launch.environment, "GEMINI_API_KEY");
    const bare = launch.mode === "bare";
    let source: KeyReport["source"] = bare ? "unknown" : "environment";
    if (!bare && value === undefined) {
      const data = file();
      value = data?.GEMINI_API_KEY;
      source = data && value === undefined ? "none" : "dotenv";
    }
    const present = value !== undefined && value.length > 0 && !/\s/.test(value);
    return {
      value: present ? value : undefined,
      report: {source, present, ...(source === "dotenv" && {path}),
        ...(source === "environment" && {lowerSourcesSkipped: true}),
        ...(!present && (source === "dotenv" || source === "environment") && {state: "unavailable"})},
    };
  }
  let selected: ReturnType<typeof select> | undefined;
  const selectedKey = () => selected ??= select();
  return {
    setting(name: ApplicationSetting) { return inheritedValue(launch.environment, name) ?? file()?.[name]; },
    keyReport() { return selectedKey().report; },
    providerKey() { return selectedKey().value; },
  };
}

let current: ReturnType<typeof createCliSettings> | undefined;
export function configureOrdinaryCli(launch: CliLaunch) {
  current = createCliSettings(launch);
  useApplicationSettings(current.setting);
}
export function cliSettings() {
  // Library consumers have no CLI launch and do not discover a project file.
  return current ?? createCliSettings({mode: "clean", environment: process.env, cwd: process.cwd()}, () => "");
}

export function keyLabel(key: KeyReport) {
  if (key.source === "unknown") {
    return process.versions.bun ? "unknown: started under Bun without --no-env-file" : "unknown: started with --env-file";
  }
  const label = key.source === "dotenv" ? JSON.stringify(key.path)
    : key.source === "environment" ? "process environment" : "none";
  return key.state ? label + ", unavailable" : label;
}
export function keyNextStep(key: KeyReport) {
  if (key.source === "unknown") return "Next step: Run the installed Node command to identify the key source.";
  if (key.present) return;
  if (key.source === "environment") return "Next step: Set GEMINI_API_KEY to a nonempty value without whitespace in your environment.";
  if (key.state === "unavailable") return "Next step: Check the named file is readable and contains a valid GEMINI_API_KEY assignment.";
  return "Next step: Run frameofmind key set to configure a key in this folder.";
}
