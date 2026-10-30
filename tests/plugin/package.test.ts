import assert from "node:assert/strict";
import { cp, lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { test } from "bun:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { packagedStdioParameters } from "../stdio.ts";
import { exerciseWarehouse } from "../live/warehouse-check.ts";
import { runtimeSchema } from "../../src/core.ts";
import { workspaceOutput, localOutput, resultOutput } from "../../src/local-contracts.ts";
import { demoAnswer } from "../../scripts/demo-workspace.ts";

const repo = fileURLToPath(new URL("../../", import.meta.url));
async function fileNames(root: string, prefix = ""): Promise<string[]> {
  const all: string[] = [];
  for (const name of await readdir(root)) {
    const info = await lstat(join(root, name));
    assert.equal(info.isSymbolicLink(), false);
    if (info.isDirectory()) all.push(...await fileNames(join(root, name), `${prefix}${name}/`));
    else all.push(`${prefix}${name}`);
  }
  return all.sort();
}
async function verifyPackage(live: boolean) {
  const temporary = await mkdtemp(join(tmpdir(), "bq-plugin-"));
  let client: Client | undefined;
  let transport: StdioClientTransport | undefined;
  try {
    const pkg = await Bun.file(join(repo, "package.json")).json();
    const archive = join(repo, "dist", `bq-tool-${pkg.version}-${process.platform}-${process.arch}.tar.gz`);
    const archiveHash = createHash("sha256");
    for await (const chunk of Bun.file(archive).stream()) archiveHash.update(chunk);
    assert.equal((await Bun.file(`${archive}.sha256`).text()).split(" ")[0], archiveHash.digest("hex"));
    const extracted = join(temporary, "unpacked source");
    await mkdir(extracted);
    const unpack = Bun.spawnSync(["tar", "-xzf", archive, "-C", extracted], { stdout: "pipe", stderr: "pipe" });
    assert.equal(unpack.exitCode, 0, unpack.stderr.toString());
    const checksums = await Bun.file(join(extracted, "checksums.json")).json() as Record<string, string>;
    assert.deepEqual(await fileNames(extracted), [...Object.keys(checksums), "checksums.json"].sort());
    for (const [path, expected] of Object.entries(checksums)) {
      const hash = createHash("sha256");
      for await (const chunk of Bun.file(join(extracted, path)).stream()) hash.update(chunk);
      assert.equal(hash.digest("hex"), expected, path);
    }
    const marketplace = await Bun.file(join(extracted, ".agents/plugins/marketplace.json")).json();
    const sourcePlugin = resolve(extracted, marketplace.plugins[0].source.path);
    const cache = join(temporary, "cache copy", marketplace.name, "bq-tool", "local");
    await cp(sourcePlugin, cache, { recursive: true });
    // Launch only the cache copy after the distribution source is removed.
    await rm(extracted, { recursive: true });
    const manifest = await Bun.file(join(cache, "plugin.json")).json();
    assert.equal(manifest.name, "bq-tool");
    const executable = join(cache, "dist/bq-tool");
    assert.ok((await lstat(executable)).mode & 0o111, "archive must retain executable permissions");
    const files = await fileNames(cache);
    assert.equal(files.some((path) => /(^|\/)(node_modules|src|\.git|\.env)(\/|$)/.test(path)), false);
    assert.deepEqual(files.filter((path) => path.endsWith("/SKILL.md")), ["skills/bq-analysis/SKILL.md"]);
    for (const name of files.filter((path) => path.endsWith(".md"))) {
      const path = join(cache, name);
      const markdown = await Bun.file(path).text();
      for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        const target = match[1]!;
        if (!/^(https?:|#)/.test(target)) assert.ok(await Bun.file(resolve(dirname(path), target.split("#")[0]!)).exists(), `${name} -> ${target}`);
      }
    }
    const workspace = join(temporary, "analysis workspace");
    await cp(join(cache, "examples/workspace"), workspace, { recursive: true });
    const env = {
      ...Object.fromEntries(Object.entries(Bun.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
      PATH: join(cache, "dist"),
      ...live ? {} : { GOOGLE_APPLICATION_CREDENTIALS: join(temporary, "nonexistent-credentials.json") },
    };
    assert.equal(Bun.which("bun", { PATH: env.PATH }), null);
    const run = (...args: string[]) => {
      const child = Bun.spawnSync([executable, ...args], { cwd: temporary, env, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
      assert.equal(child.exitCode, 0, child.stderr.toString());
      return JSON.parse(child.stdout.toString());
    };
    runtimeSchema.parse(run("doctor"));
    const opened = workspaceOutput.parse(run("workspace", "--workspace", workspace));
    const local = localOutput.parse(run("local", "--workspace", workspace, "--inputs-file", join(cache, "examples/inputs.json"), "--sql-file", join(cache, "examples/query.sql"), "--save"));
    assert.deepEqual(local.preview.rows, demoAnswer);
    const parameters = { ...await packagedStdioParameters(cache), env };
    assert.equal(parameters.command, executable);
    transport = new StdioClientTransport(parameters);
    client = new Client({ name: "bq-plugin-package-tests", version: "0.0.1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    assert.equal(tools.length, 15);
    const inspect = await client.callTool({ name: "describe_result", arguments: { workspace, resultId: local.result!.resultId } });
    assert.notEqual(inspect.isError, true, JSON.stringify(inspect.content));
    assert.deepEqual(resultOutput.parse(inspect.structuredContent).preview.rows, demoAnswer);
    const resumed = workspaceOutput.parse(run("workspace", "--workspace", workspace));
    assert.equal(resumed.id, opened.id);
    const followup = await client.callTool({ name: "query_local", arguments: {
      workspace, inputs: [{ alias: "regional", resultId: local.result!.resultId }], sql: "SELECT SUM(revenue) AS revenue FROM regional", save: true,
    } });
    assert.notEqual(followup.isError, true, JSON.stringify(followup.content));
    assert.deepEqual(localOutput.parse(followup.structuredContent).preview.rows, [{ revenue: "170.50" }]);
    if (live) await exerciseWarehouse([executable], parameters);
  } finally { await client?.close(); await transport?.close(); await rm(temporary, { recursive: true, force: true }); }
}

test.skipIf(Bun.env.BQ_TOOL_PLUGIN !== "1")("archive and cached plugin run offline CLI/MCP workflows without source or Bun on PATH", async () => {
  await verifyPackage(false);
}, 60_000);

test.skipIf(Bun.env.BQ_TOOL_PLUGIN !== "1" || Bun.env.BQ_TOOL_LIVE !== "1" || !Bun.env.BQ_TOOL_LIVE_DATASET || !Bun.env.BQ_TOOL_LIVE_TABLE)("cached plugin performs bounded live extraction and local resume through CLI and MCP", async () => {
  await verifyPackage(true);
}, 120_000);
