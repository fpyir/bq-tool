import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync } from "node:fs";

const require = createRequire(import.meta.url);
const platform = `${process.platform}-${process.arch}`;
// Build on the target host so the installed native package matches the runtime.
const addon = require.resolve(`@duckdb/node-bindings-${platform}/duckdb.node`);
const directory = dirname(addon);
const libraries = readdirSync(directory).filter((name) => /\.(dylib|so(?:\.\d+)*|dll)$/.test(name));
if (libraries.length === 0) throw new Error(`No DuckDB shared library found for ${platform}`);

const assets = [addon, ...libraries.map((name) => join(directory, name))];
const imports = assets.map((path, index) => `import asset${index} from ${JSON.stringify(path)} with { type: "file" };`).join("\n");
const files = assets.map((path, index) => `[${JSON.stringify(basename(path))}, asset${index}]`).join(",");

const result = await Bun.build({
  entrypoints: [fileURLToPath(new URL("../src/cli.ts", import.meta.url))],
  compile: {
    outfile: "./dist/bq-tool",
    autoloadDotenv: false,
    autoloadBunfig: false,
  },
  target: "bun",
  minify: true,
  plugins: [{
    name: "embed-duckdb-native",
    setup(build) {
      // Select only the host binding rather than resolving every optional platform package.
      build.onResolve({ filter: /^@duckdb\/node-bindings$/ }, () => ({ path: "duckdb", namespace: "embedded-native" }));
      build.onLoad({ filter: /.*/, namespace: "embedded-native" }, () => ({
        loader: "js",
        contents: `${imports}
          import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
          import { tmpdir } from "node:os";
          import { join } from "node:path";
          const directory = mkdtempSync(join(tmpdir(), "bq-tool-native-"));
          const clean = () => { try { rmSync(directory, { recursive: true, force: true }); } catch {} };
          const binding = { exports: {} };
          try {
            for (const [name, asset] of [${files}]) writeFileSync(join(directory, name), readFileSync(asset));
            process.dlopen(binding, join(directory, "duckdb.node"));
          } catch (error) { clean(); throw error; }
          process.once("exit", clean);
          export default binding.exports;
        `,
      }));
    },
  }],
});
if (!result.success) throw new AggregateError(result.logs, "Standalone build failed");
console.log(`Built dist/bq-tool for ${platform}`);
