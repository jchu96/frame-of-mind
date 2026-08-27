const allowedTypes = [
  "build",
  "chore",
  "ci",
  "docs",
  "feat",
  "fix",
  "perf",
  "refactor",
  "revert",
  "style",
  "test",
] as const;

const conventionalSubject = new RegExp(
  `^(?:${allowedTypes.join("|")})(?:\\([a-z0-9][a-z0-9._/-]*\\))?!?: [a-z].*$`,
);
const emoji = /[\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Regional_Indicator}\u200d\ufe0f\u20e3]/u;
const gitGeneratedSubject = /^(?:Merge |Revert ")/;

export type CommitSubjectFailure = {
  readonly commit: string;
  readonly errors: readonly string[];
};

export function validateCommitSubject(subject: string): string[] {
  // Git runs commit-msg for merge and revert commits, whose generated subjects
  // do not use Conventional Commit syntax. Exempt only those generated forms:
  // historical emoji subjects remain invalid, and the hook validates only new commits.
  if (gitGeneratedSubject.test(subject)) return [];

  const errors: string[] = [];
  if (!conventionalSubject.test(subject)) {
    errors.push(
      "use type(scope): lowercase-start description with an optional scope and a supported Conventional Commit type",
    );
  }
  if (emoji.test(subject)) errors.push("remove emoji from the subject");
  if (/\.\s*$/.test(subject)) errors.push("remove the trailing period");
  return errors;
}

export function commitSubjectFailures(
  repositoryRoot: string,
  baseRef = process.env.FRAME_OF_MIND_GATE_BASE_REF?.trim() || "origin/main",
): CommitSubjectFailure[] {
  const commits = commitsForValidation(repositoryRoot, baseRef);
  return commits.flatMap(({ commit, subject }) => {
    const errors = validateCommitSubject(subject);
    return errors.length === 0 ? [] : [{ commit, errors }];
  });
}

export function runCommitMessageSelfTest(): void {
  const fixtures = [
    { subject: "feat: add contribution checks", valid: true },
    { subject: "chore: x", valid: true },
    { subject: "fix(web): prevent stale results", valid: true },
    { subject: "chore!: remove obsolete workflow", valid: true },
    { subject: "Merge branch 'main' into feature", valid: true },
    { subject: 'Revert "feat: add contribution checks"', valid: true },
    { subject: "Fixed stuff", valid: false },
    { subject: "feat: Added thing.", valid: false },
    { subject: "✨ feat: add a thing", valid: false },
    { subject: "feat: add a thing.", valid: false },
    { subject: "feature: add a thing", valid: false },
    { subject: "fix: 2 broken paths", valid: false },
  ];
  for (const fixture of fixtures) {
    const valid = validateCommitSubject(fixture.subject).length === 0;
    if (valid !== fixture.valid) {
      throw new Error(`Commit-message self-test failed for ${JSON.stringify(fixture.subject)}.`);
    }
  }
  console.log(`Commit-message self-test: passed (${fixtures.length} fixtures).`);
}

function commitsForValidation(
  repositoryRoot: string,
  baseRef: string,
): Array<{ readonly commit: string; readonly subject: string }> {
  const baseAvailable = git(repositoryRoot, [
    "rev-parse",
    "--verify",
    "--quiet",
    `${baseRef}^{commit}`,
  ]).exitCode === 0;
  let revisions = ["--no-merges", "-n1", "HEAD"];
  if (baseAvailable) {
    const mergeBase = git(repositoryRoot, ["merge-base", baseRef, "HEAD"]);
    if (mergeBase.exitCode !== 0) {
      throw new Error(`Could not resolve the commit-message gate base ${baseRef}.`);
    }
    const range = `${mergeBase.stdout.trim()}..HEAD`;
    const count = git(repositoryRoot, ["rev-list", "--count", range]);
    if (count.exitCode !== 0) {
      throw new Error(`Could not enumerate commits since ${baseRef}.`);
    }
    if (count.stdout.trim() !== "0") revisions = ["--no-merges", range];
  }
  return gitSubjects(repositoryRoot, revisions);
}

function recentSubjects(repositoryRoot: string, count: number): CommitSubjectFailure[] {
  return gitSubjects(repositoryRoot, ["--no-merges", `-n${count}`, "HEAD"]).flatMap(
    ({ commit, subject }) => {
      const errors = validateCommitSubject(subject);
      return errors.length === 0 ? [] : [{ commit, errors }];
    },
  );
}

function gitSubjects(
  repositoryRoot: string,
  revisions: string[],
): Array<{ readonly commit: string; readonly subject: string }> {
  const result = git(repositoryRoot, ["log", "-z", "--format=%H%x00%s", ...revisions]);
  if (result.exitCode !== 0) throw new Error("Could not read commit subjects for validation.");
  const fields = result.stdout.split("\0").filter(Boolean);
  if (fields.length % 2 !== 0) throw new Error("Git returned an invalid commit-subject stream.");
  const commits: Array<{ commit: string; subject: string }> = [];
  for (let index = 0; index < fields.length; index += 2) {
    commits.push({ commit: fields[index]!, subject: fields[index + 1]! });
  }
  return commits;
}

function git(
  repositoryRoot: string,
  args: string[],
): { readonly exitCode: number; readonly stdout: string } {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: repositoryRoot,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: result.exitCode, stdout: result.stdout.toString() };
}

function printFailures(failures: readonly CommitSubjectFailure[]): never {
  console.error(`Commit message validation failed (${failures.length} commit(s)).`);
  for (const failure of failures) {
    for (const error of failure.errors) {
      console.error(`- ${failure.commit.slice(0, 12)}: ${error}`);
    }
  }
  process.exit(1);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args[0] === "--self-test") {
    runCommitMessageSelfTest();
  } else if (args[0] === "--recent") {
    const count = Number(args[1]);
    if (!Number.isSafeInteger(count) || count < 1) {
      throw new Error("--recent requires a positive integer.");
    }
    const failures = recentSubjects(process.cwd(), count);
    if (failures.length > 0) printFailures(failures);
    console.log(`Commit message validation: passed (${count} recent non-merge subjects).`);
  } else if (args.length === 1) {
    const message = await Bun.file(args[0]!).text();
    const subject = message.split(/\r?\n/, 1)[0] ?? "";
    const errors = validateCommitSubject(subject);
    if (errors.length > 0) printFailures([{ commit: "commit-msg", errors }]);
  } else {
    throw new Error("Usage: validate-commit-message.ts <message-file> | --self-test | --recent <count>");
  }
}
