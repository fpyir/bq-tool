import { chmod, copyFile, lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createDemoWorkspace, demoInputs, demoQuery } from "./demo-workspace.ts";

const repo = fileURLToPath(new URL("../", import.meta.url));
const target = `${process.platform}-${process.arch}`;
const manifest = await Bun.file(join(repo, "plugin.json")).json();
const pkg = await Bun.file(join(repo, "package.json")).json();
if (manifest.name !== pkg.name || manifest.version !== pkg.version) throw new Error("Plugin/package identity differs");
const output = join(repo, "dist", "plugin");
const staging = join(repo, "dist", `.plugin-${crypto.randomUUID()}`);
const plugin = join(staging, "plugins", "bq-tool");
const archive = join(repo, "dist", `bq-tool-${pkg.version}-${target}.tar.gz`);
const marketplace = {
  name: "bq-tool-local", interface: { displayName: "BQ Tool (local)" },
  plugins: [{ name: "bq-tool", source: { source: "local", path: "./plugins/bq-tool" }, policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Productivity" }],
};
async function json(path: string, value: unknown) { await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`); }
async function files(directory: string, prefix = ""): Promise<string[]> {
  const found: string[] = [];
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`Refusing to package a symlink: ${path}`);
    if (info.isDirectory()) found.push(...await files(path, `${prefix}${name}/`));
    else if (info.isFile()) found.push(`${prefix}${name}`);
    else throw new Error(`Refusing a non-file package entry: ${path}`);
  }
  return found;
}
try {
  await mkdir(join(plugin, "dist"), { recursive: true });
  // Explicit allowlist: never package the checkout, credentials, or arbitrary workspaces.
  for (const name of [
    "plugin.json", "mcp.json", "skills/bq-analysis/SKILL.md", "skills/bq-analysis/agents/openai.yaml",
    "skills/bq-analysis/references/tools.md", "examples/README.md", "examples/warehouse-context.md",
    "docs/INSTALL.md", "docs/ACCEPTANCE.md",
  ]) {
    await mkdir(dirname(join(plugin, name)), { recursive: true });
    await copyFile(join(repo, name), join(plugin, name));
  }
  await copyFile(join(repo, "dist", "bq-tool"), join(plugin, "dist", "bq-tool"));
  await chmod(join(plugin, "dist", "bq-tool"), 0o755);
  await createDemoWorkspace(join(plugin, "examples", "workspace"));
  await json(join(plugin, "examples", "inputs.json"), demoInputs);
  await Bun.write(join(plugin, "examples", "query.sql"), `${demoQuery};\n`);
  await json(join(staging, ".agents", "plugins", "marketplace.json"), marketplace);
  const revision = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const status = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  await json(join(staging, "build.json"), {
    name: pkg.name, version: pkg.version, target, bun: Bun.version, builtAt: new Date().toISOString(),
    source: { revision: revision.exitCode === 0 ? revision.stdout.toString().trim() : null, dirty: status.exitCode === 0 ? status.stdout.length > 0 : null },
  });
  await Bun.write(join(staging, "README.md"), `# BQ Tool ${pkg.version} (${target})\n\nInstall from this marketplace root. See [installation instructions](plugins/bq-tool/docs/INSTALL.md) and [host acceptance checks](plugins/bq-tool/docs/ACCEPTANCE.md).\n\nThe executable includes Bun and DuckDB. Keep your analysis workspaces outside this folder.\n`);
  const checksums: Record<string, string> = {};
  for (const name of await files(staging)) {
    const hash = createHash("sha256");
    for await (const chunk of Bun.file(join(staging, name)).stream()) hash.update(chunk);
    checksums[name] = hash.digest("hex");
  }
  await json(join(staging, "checksums.json"), checksums);
  await rm(output, { recursive: true, force: true });
  await rename(staging, output);
  // tar preserves executable modes and includes the hidden marketplace catalog.
  const packed = Bun.spawn(["tar", "-czf", archive, "-C", output, "."], { stdout: "pipe", stderr: "pipe" });
  const [code, error] = await Promise.all([packed.exited, new Response(packed.stderr).text()]);
  if (code !== 0) throw new Error(`Package archive failed: ${error}`);
  const hash = createHash("sha256");
  for await (const chunk of Bun.file(archive).stream()) hash.update(chunk);
  await Bun.write(`${archive}.sha256`, `${hash.digest("hex")}  ${archive.slice(archive.lastIndexOf("/") + 1)}\n`);
  console.log(JSON.stringify({ marketplaceRoot: output, pluginRoot: join(output, "plugins", "bq-tool"), archive, checksum: `${archive}.sha256`, target }, null, 2));
} finally { await rm(staging, { recursive: true, force: true }); }
