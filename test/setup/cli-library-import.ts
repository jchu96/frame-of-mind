// Tests import src/cli.ts for its program and helpers; mark those imports as
// library imports so loading the module does not parse Vitest's own argv.
// A global, not an environment variable, so spawned CLI processes still run.
// The key matches CLI_LIBRARY_IMPORT in src/cli.ts; importing it would run the CLI.
(globalThis as Record<symbol, unknown>)[Symbol.for("frameofmind.cli.libraryImport")] = true;
