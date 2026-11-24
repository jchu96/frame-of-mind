import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { ContractError } from "../domain/contract-error.js";

function denied(): never { throw new ContractError("PATH_OUTSIDE_ROOTS", "Unsafe directory in the job grant."); }

/** Refuse outside writers on POSIX, including ancestors which could be
 * renamed by another account. Sticky system temp directories protect the
 * selected user's own entry. */
export function trustedDirectory(path: string, childOwner?: number) {
  if (resolve(path) !== path || realpathSync(path) !== path) denied();
  for (let dir = path; ; dir = dirname(dir)) {
    const info = lstatSync(dir);
    if (!info.isDirectory()) denied();
    if (process.getuid) {
      const user = process.getuid();
      if (info.uid !== user && info.uid !== 0) denied();
      if ((info.mode & 0o022) && !((info.mode & 0o1000) && childOwner !== undefined && [0, user].includes(childOwner))) denied();
    }
    if (dir === dirname(dir)) break;
    childOwner = info.uid;
  }
}

/** The process cwd pins its directory even if the pathname is exchanged.
 * Keep this section synchronous, as in scratch cleanup. Windows also pins
 * the cwd, without needing a directory FD (which is unavailable there). */
export function inJobDirectory<T>(directory: string, operation: () => T): T {
  trustedDirectory(directory);
  const before = lstatSync(directory, {bigint: true});
  const previous = process.cwd();
  try {
    process.chdir(directory);
    const held = lstatSync(".", {bigint: true});
    if (held.dev !== before.dev || held.ino !== before.ino || realpathSync(".") !== directory) denied();
    return operation();
  } finally { process.chdir(previous); }
}

export function openJobFile(path: string, flags: number, mode?: number) {
  return inJobDirectory(dirname(path), () => {
    const name = basename(path);
    const fd = openSync(name, flags | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0), mode);
    try {
      const held = fstatSync(fd, {bigint: true});
      const entry = lstatSync(name, {bigint: true});
      if (!entry.isFile() || held.dev !== entry.dev || held.ino !== entry.ino || held.nlink !== 1n) denied();
      return fd;
    } catch (error) { closeSync(fd); throw error; }
  });
}
