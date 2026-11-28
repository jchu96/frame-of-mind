import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "dotenv";
import { inheritedValue, type CliLaunch, type LaunchMode } from "./cli-launch.js";
import { useApplicationSettings, type ApplicationSetting } from "./lib/application-settings.js";

import { commandSetting, launchCommandOverride, userSettingsPath, type CommandSetting, keyVariables, type KeyEngine } from "./key-command-settings.js";
import { KeyCommandRefused, runKeyCommand } from "./key-command.js";

interface KeyReport {
  source: "environment" | "dotenv" | "none" | "unknown" | "command";
  present: boolean;
  path?: string;
  state?: "unavailable" | "unverified" | "verified";
  lowerSourcesSkipped?: true;
  commandDisabledByEnvironment?: true;
}

function readSettingsFile(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("Unavailable settings file.");
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}

export function createCliSettings(launch: CliLaunch, read = readSettingsFile, platform = process.platform) {
  const path = join(launch.cwd, ".env");
  let settings: Record<string, string> | null | undefined;
  function file() {
    if (settings === undefined) {
      try { settings = parse(read(path)); }
      catch (error) { settings = (error as NodeJS.ErrnoException)?.code === "ENOENT" ? {} : null; }
    }
    return settings;
  }
  function engineKey(engine: KeyEngine) {
    let command: CommandSetting = {kind: "absent"};
    let nextStep: string | undefined;
    let acquisition: Promise<string> | undefined;
    function select(): {report: KeyReport; value?: string} {
      let value = inheritedValue(launch.environment, keyVariables[engine]);
      const bare = launch.mode === "bare";
      let source: KeyReport["source"] = bare ? "unknown" : "environment";
      // Only an ordinary CLI bootstrap supplies an account context.
      const override = "accountHome" in launch ? launchCommandOverride(launch, platform, engine) : undefined;
      if (value === undefined) {
        if (override) command = commandSetting(launch, platform, override, engine);
        if (command.kind === "command" || command.kind === "unavailable") {
          if (command.kind === "unavailable") nextStep = command.fix;
          return {report: {source: "command", lowerSourcesSkipped: true, present: command.kind === "command",
            state: command.kind === "command" ? "unverified" : "unavailable"}};
        }
        if (!bare) {
          const data = file();
          value = data?.[keyVariables[engine]];
          source = data && value === undefined ? "none" : "dotenv";
        } else if (command.kind === "none") source = "none";
      }
      const present = value !== undefined && value.length > 0 && !/\s/.test(value);
      return {
        value: present ? value : undefined,
        report: {source, present, ...(source === "dotenv" && {path}),
          ...(override?.kind === "none" && {commandDisabledByEnvironment: true}),
          ...(source === "environment" && {lowerSourcesSkipped: true}),
          ...(!present && (source === "dotenv" || source === "environment") && {state: "unavailable"})},
      };
    }
    let selected: ReturnType<typeof select> | undefined;
    const selectedKey = () => selected ??= select();
    return {
      suppressFolder: () => selected?.report.source === "command" && !selected.report.present,
      keyReport() { return selectedKey().report; },
      keyLabel() { return keyLabel(selectedKey().report, launch.mode); },
      commandNextStep() { return nextStep; },
      providerKey() {
        const selection = selectedKey();
        if (selection.report.source !== "command") return selection.value;
        if (command.kind !== "command") throw new KeyCommandRefused(engine === "twelvelabs" ? engine : undefined);
        return acquisition ??= runKeyCommand(command.argv, command.home, launch.environment).then(value => {
          selection.report.state = "verified";
          return value;
        }, () => {
          selection.report.present = false;
          selection.report.state = "unavailable";
          throw new KeyCommandRefused(engine === "twelvelabs" ? engine : undefined);
        });
      },
    };
  }
  const keys = {gemini:engineKey("gemini"), twelvelabs:engineKey("twelvelabs")};
  return {
    setting(name: ApplicationSetting) {
      const inherited = inheritedValue(launch.environment, name);
      if (launch.mode === "bare" || inherited !== undefined || keys.gemini.suppressFolder()) return inherited;
      return file()?.[name];
    },
    keyReport(engine: KeyEngine = "gemini") { return keys[engine].keyReport(); },
    keyLabel(engine: KeyEngine = "gemini") { return keys[engine].keyLabel(); },
    providerKey(engine: KeyEngine = "gemini") { return keys[engine].providerKey(); },
    settingsPath() { return userSettingsPath(launch.accountHome, platform); },
    commandNextStep(engine: KeyEngine = "gemini") { return keys[engine].commandNextStep(); },
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

export function keyLabel(key: KeyReport, mode: LaunchMode = "clean") {
  if (key.source === "unknown") {
    return process.versions.bun ? "unknown: started under Bun without --no-env-file" : "unknown: started with --env-file";
  }
  if (key.source === "command") {
    if (mode === "bare") return "key command, not run under this launcher";
    return key.state === "unverified" ? "key command, not run by doctor" : "key command, " + key.state;
  }
  const label = key.source === "dotenv" ? JSON.stringify(key.path)
    : key.source === "environment" ? "process environment" : "none";
  return key.state ? label + ", unavailable" : label;
}
export function keyNextStep(key: KeyReport, commandFix?: string) {
  if (key.present) return;
  if (key.source === "unknown") return "Next step: Run the installed Node command.";
  if (commandFix) return "Next step: " + commandFix;
  if (key.source === "environment") return "Next step: Set GEMINI_API_KEY to a nonempty value without whitespace in your environment.";
  if (key.state === "unavailable") return "Next step: Check the named file is readable and contains a valid GEMINI_API_KEY assignment.";
  return "Next step: Run frameofmind key set to configure a key in this folder.";
}
