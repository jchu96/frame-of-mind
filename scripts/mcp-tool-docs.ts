import { writeFile } from "node:fs/promises";
import { describeReadTools } from "../src/commands/mcp.js";

const header = `# Local MCP tool contract

Each name identifies a versioned input and output schema. A shape changes only
under a new tool name or a major version. Release notes list every change.
The server publishes these schemas through \`tools/list\`. Every success includes
the same untrusted object as structured content and as JSON in its text block.

Regenerate with \`bun --no-env-file scripts/mcp-tool-docs.ts\`.

`;
const sections = describeReadTools().map(({ name, description, inputSchema, outputSchema }) => {
  const schemas = JSON.stringify({ inputSchema, outputSchema }, null, 2);
  return `## ${name}\n\n${description}\n\n\`\`\`json\n${schemas}\n\`\`\`\n`;
});
await writeFile(new URL("../docs/MCP_TOOLS.md", import.meta.url), header + sections.join("\n"));
