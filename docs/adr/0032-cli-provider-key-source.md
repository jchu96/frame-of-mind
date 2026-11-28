# ADR 0032 — Identify the local CLI provider key source at launch

Accepted 2026-11-26. Amended 2026-11-28 for launchers that merge a folder file.

## Invariant

Doctor reports what the launcher lets the CLI know about a key without revealing
its value. A folder can supply a literal key. It cannot choose a key reader or
control the environment in which that reader runs.

## Decision

Capture the runtime, startup options, physical working directory and environment
before dispatch. Node preloads (`--require`, `-r`, `--import`) and loaders are
operator input, whether passed on the command line or via `NODE_OPTIONS`. A
working folder cannot set these launch options. Accept them as clean. Node’s
`--env-file` and `--env-file-if-exists` can merge file values before capture.
All commands, including job start, use a valid key in the captured environment.
Jobs acquire keys only from that environment. On a clean launch ordinary commands
then try the selected key command and finally the literal folder file. A selected invalid source stops the lookup.
After a runtime merge the CLI uses the captured settings without reopening the
working folder’s `.env`. Keep the allowlists for child processes.

Doctor describes the selected source and any unavailable state. Its existing
presence boolean and the `configured` and `missing` check details remain stable.
Private terminal entry still writes the user-selected dotenv path with mode 0600.

## Measured launch behavior

A first-statement probe on Bun 1.4.4 and Node 22.22.2 used an isolated home and
one synthetic marker. The shell-only control ran with no folder file.

| Launch | Marker supplied by | Present at first statement | Runtime arguments |
| --- | --- | --- | --- |
| Bare Bun | shell | yes | `[]` |
| Bare Bun | folder | yes | `[]` |
| Original dev script, bare inner Bun | folder | yes | `[]` |
| Package script with flagged inner Bun | folder | no | `["--no-env-file"]` |
| Direct Bun with the flag | folder | no | `["--no-env-file"]` |
| Direct Node | folder | no | `[]` |

After a merge the CLI cannot distinguish a shell export from an equal-valued
folder assignment. Doctor labels a present key `unknown`, exits 0 and prints no
next step. With no key it exits 1 and prints one next step in text mode.

The clean-input guarantee for helper processes applies to clean launches. A
Bun 1.4.4 probe used different, empty operator and folder directories as search
paths. Bare Bun preserved an inherited `PATH`, including an explicitly empty
one. When the launcher omitted `PATH`, Bun took the folder assignment and
both media and browser helpers received it. Bun also filled an unset locale
variable from the folder. With `--no-env-file`, the folder supplied neither.
Bare Bun keeps its existing helper environment allowlists and custom media paths.
The provider key variable is excluded from helpers in every launch class.

Under Bun, a folder that supplies a preload runs its own code before the tool.
It can change the startup options or set variables before the CLI sees them.
In a folder you do not trust, run the installed Node command or the release file,
which read no such preload file.

## Per-user key command

At clean launch, capture the home returned by `os.userInfo()`. Bun can derive this
from an inherited HOME. The operator supplies that value before any folder
settings are parsed. On demand, resolve the fixed account settings path, ignoring
XDG_CONFIG_HOME. Use the inherited selector first, then the settings file’s optional
`keyCommand`. The account must own the 0700 tool directory and its regular 0600 file.
Open the file without following links and check the open handle before reading.

On a merged launch, a folder file can set variables that any reader would inherit.
If the launch lacks a key, the presence of the selector is sufficient to report
`Key command unavailable.` Without a selector, the CLI uses the same home lookup
on demand to inspect the protected settings file. Bun's home may reflect the
merged `HOME`. That location is used only for diagnosis. The CLI neither resolves
nor starts an executable from it. A configured reader gives `KEY_REFUSED`, and
an absent reader gives `KEY_MISSING`. Doctor directs the operator to the installed
Node command.

On a clean launch, resolve element zero to an absolute executable owned by the effective user or root.
Group and other write bits disqualify it. Start the resolved path in the account home
with literal arguments, closed input, private pipes and its own process group.
A script’s interpreter is found through the operator’s own launch environment.
Only this child receives the launch snapshot less the two provider keys and the selector.
Trust the chosen reader with the remaining session environment.

A consumer shares one acquisition, including a refusal. Allow 30 seconds and 4,096
bytes across both pipes. Accept one printable ASCII token after an optional final
LF or CRLF, with zero exit and empty stderr. Refusal ends selection. On a clean launch doctor reports a
configured reader as unverified and only inspects its setup. Bare launches and jobs
never start the reader. Native Windows skips the account file and refuses an explicit
selector. WSL uses the Linux account path.

## Limits

When the operator enables `NODE_DEBUG=child_process`, Node prints the key command’s arguments and environment to the parent process’s stderr, never the key the reader returns.
