import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { StdioServerParameters } from "@modelcontextprotocol/client/stdio";

const pluginRoot = fileURLToPath(new URL("../", import.meta.url));
export const sourceStdioParameters: StdioServerParameters = {
  command: process.execPath,
  args: [fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "mcp"],
  cwd: pluginRoot,
  stderr: "pipe",
};

export async function packagedStdioParameters(root: string): Promise<StdioServerParameters> {
  const config = await Bun.file(new URL("../mcp.json", import.meta.url)).json();
  const server = z.object({
    type: z.literal("stdio"), command: z.string(), args: z.array(z.string()), cwd: z.string(),
  }).parse(config.mcpServers["bq-tool"]);
  return {
    command: server.command.replaceAll("${PLUGIN_ROOT}", root),
    args: server.args.map((arg) => arg.replaceAll("${PLUGIN_ROOT}", root)),
    cwd: server.cwd.replaceAll("${PLUGIN_ROOT}", root),
    stderr: "pipe",
  };
}
