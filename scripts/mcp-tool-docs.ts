import { readFile, writeFile } from "node:fs/promises";
import { describeReadTools } from "../src/commands/mcp.js";

const path = new URL("../docs/MCP_TOOLS.md", import.meta.url);
const marker = "<!-- Generated MCP tool schemas -->";
const document = await readFile(path, "utf8");
const start = document.indexOf(marker);
if (start < 0) throw new Error("Missing generated MCP schema section");
const header = document.slice(0, start) + marker + "\n\n";
const sections = describeReadTools().map(({ name, description, inputSchema, outputSchema }) => {
  const schemas = JSON.stringify({ inputSchema, outputSchema }, null, 2);
  return `## ${name}\n\n${description}\n\n\`\`\`json\n${schemas}\n\`\`\`\n`;
});
await writeFile(path, header + sections.join("\n"));
