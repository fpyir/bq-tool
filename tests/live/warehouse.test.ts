import { test } from "bun:test";
import { fileURLToPath } from "node:url";
import { sourceStdioParameters } from "../stdio.ts";
import { exerciseWarehouse } from "./warehouse-check.ts";

test.skipIf(Bun.env.BQ_TOOL_LIVE !== "1" || !Bun.env.BQ_TOOL_LIVE_DATASET || !Bun.env.BQ_TOOL_LIVE_TABLE)("CLI and MCP discover real schemas and execute bounded read queries", async () => {
  const env = Object.fromEntries(Object.entries(Bun.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  await exerciseWarehouse([process.execPath, fileURLToPath(new URL("../../src/cli.ts", import.meta.url))], { ...sourceStdioParameters, env });
}, 120_000);
