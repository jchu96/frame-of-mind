# ADR 0030. Grant local MCP access to one reviewed snapshot at launch

Accepted on 2026-11-24.

## Invariant

The operator decides which runs one local agent may read. The launch grant covers
one reviewed database file. A tool argument can only narrow the returned data.

## Decision

Review the public values, including rejected records, and import the cleared
bundles into a dedicated database. Close the writer and launch Bun with dotenv
loading disabled and the canonical absolute database path on argv. The host sets
`BUN_RUNTIME_TRANSPILER_CACHE_PATH=0` so the runtime creates no on-disk code cache. The stdio
server reads a bounded image, validates it through a read-only in-memory SQLite
connection, then closes that connection. The four versioned tools operate on the
validated local principal's projection. The operator grants the scope at launch.
Future action tools will require explicit launch flags.

The schemas allow selected provenance, record fields and original base times.
Each time-bearing result states the scope of schema 3 speech-edge proposals.
Every success labels both representations as untrusted data. Launch and tool
failures use fixed diagnostics. See the [tool contract](../MCP_TOOLS.md) and
[operator runbook](../RUNBOOK.md#local-mcp-snapshot).

## Consequences and alternatives

A live projection could change after review and require journal recovery.
Reading run bundles on demand would grant access to additional paths and
sidecars. The in-memory snapshot keeps the grant stable when the original
files move. Its 64 MiB cap limits memory use. Select fewer runs into the
reviewed database when it exceeds the cap. A new snapshot requires a restart.

The existing Node CLI remains available for ordinary commands. The server uses
Bun's built-in SQLite deserializer in the checkout and in the single-file release.
