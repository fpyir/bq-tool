import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

const root = fileURLToPath(new URL("../", import.meta.url));
test("portable plugin, skill and repo marketplace agree on identity and relocatable components", async () => {
  const plugin = await Bun.file(resolve(root, "plugin.json")).json();
  const pkg = await Bun.file(resolve(root, "package.json")).json();
  const mcp = await Bun.file(resolve(root, "mcp.json")).json();
  const marketplace = await Bun.file(resolve(root, ".agents/plugins/marketplace.json")).json();
  assert.equal(plugin.name, pkg.name);
  assert.equal(plugin.version, pkg.version);
  assert.equal(plugin.extensions["com.openai"].requires_local_executor, true);
  assert.equal(mcp.mcpServers[plugin.name].command, "${PLUGIN_ROOT}/dist/bq-tool");
  assert.deepEqual(mcp.mcpServers[plugin.name].args, ["mcp"]);
  assert.equal(marketplace.plugins[0].name, plugin.name);
  assert.equal(resolve(root, marketplace.plugins[0].source.path), resolve(root, "dist/plugin/plugins/bq-tool"));
  const skill = await Bun.file(resolve(root, "skills/bq-analysis/SKILL.md")).text();
  const metadata = Bun.YAML.parse(skill.split("---")[1]!) as { name: string; description: string };
  assert.equal(metadata.name, "bq-analysis");
  assert.ok(metadata.description.length > 0 && metadata.description.length <= 1024);
  const ui = Bun.YAML.parse(await Bun.file(resolve(root, "skills/bq-analysis/agents/openai.yaml")).text()) as { interface: { short_description: string }; policy?: { allow_implicit_invocation?: boolean } };
  assert.ok(ui.interface.short_description.length >= 25 && ui.interface.short_description.length <= 64);
  assert.notEqual(ui.policy?.allow_implicit_invocation, false);
});

test("skill and installation references resolve within the source layout", async () => {
  for (const name of ["skills/bq-analysis/SKILL.md", "skills/bq-analysis/references/tools.md", "docs/INSTALL.md", "docs/ACCEPTANCE.md", "examples/README.md"]) {
    const path = resolve(root, name);
    const markdown = await Bun.file(path).text();
    for (const link of markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = link[1]!;
      if (/^(https?:|#)/.test(target)) continue;
      await access(resolve(dirname(path), target.split("#")[0]!));
    }
  }
});
