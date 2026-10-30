# Install BQ Tool locally

BQ Tool is a local stdio MCP plugin with one focused analysis skill. Warehouse calls use Google Application Default Credentials (ADC) on your computer; local DuckDB work needs no Google connection. The executable includes Bun and DuckDB. No OpenAI API key is needed.

The automated target is macOS arm64. Build on the recipient's OS/architecture; other targets are unverified. Downloaded executables may be subject to your OS's signing/quarantine rules; this prototype has no signing or notarization workflow.

## Assemble the package

From the repository, with Bun 1.4.3+ and the system `tar` command available:

```sh
bun install --frozen-lockfile
bun run package
bun run test:plugin
```

The package command produces:

```text
dist/plugin/                         local marketplace root
  .agents/plugins/marketplace.json
  plugins/bq-tool/
    plugin.json
    mcp.json
    dist/bq-tool
    skills/bq-analysis/
    examples/                        synthetic workspace, inputs and SQL
    docs/
  build.json
  checksums.json
dist/bq-tool-0.0.1-darwin-arm64.tar.gz
dist/bq-tool-0.0.1-darwin-arm64.tar.gz.sha256
```

The archive name follows the version and build target. It contains the same marketplace folder, including the hidden catalog and executable permissions. Unpack into a stable directory, not an existing analysis workspace:

```sh
mkdir -p /absolute/path/bq-tool-package
tar -xzf dist/bq-tool-0.0.1-darwin-arm64.tar.gz -C /absolute/path/bq-tool-package
```

Keep that source directory available for refreshes. The package uses an explicit file allowlist and freshly generated synthetic examples; it includes no credentials, private warehouse definitions or extracted warehouse results. `build.json` records the target, runtime, source revision and whether the checkout was dirty; `checksums.json` covers package files. The archive checksum is beside the archive.

## Register and install

With Codex CLI available, register the assembled marketplace root:

```sh
codex plugin marketplace add /absolute/path/bq-tool-package
codex plugin marketplace list
```

For a development checkout you can instead register its absolute `dist/plugin` path. The repo also has a marketplace entry pointing to that built plugin. Choose one source, build before installation, and avoid installing duplicate copies from different marketplaces. A Git checkout alone does not contain the executable; this prototype does not fetch release binaries or build itself during host installation.

In Codex CLI, install with:

```sh
codex plugin add bq-tool@bq-tool-local
```

Alternatively open `/plugins`, find **BQ Tool (local)** and install **BQ Tool**. Start a fresh session after installation. The commands above are supported by the local Codex CLI used for development (0.159.2); see [OpenAI's packaging guide](https://developers.openai.com/plugins/build/plugins) for current marketplace behavior.

For **Codex desktop**, restart the app after registering the local marketplace, open a local project, then open Plugins and find BQ Tool under the local marketplace. Install/enable it if needed and start a new local chat.

For **ChatGPT desktop**, use a local Work chat. Open Plugins, find BQ Tool in the local marketplace, install/enable it, then start a new local chat. Availability can depend on the host version and workspace policy; if the local catalog is absent, check `codex plugin marketplace list` and the [official plugin surface guide](https://learn.chatgpt.com/docs/plugins). This package requires a local executor and does not provide a cloud/web endpoint.

Use the `installedPath` returned by `codex plugin add --json` to locate the cached plugin. The CLI installation verified here uses `~/.codex/plugins/cache/bq-tool-local/bq-tool/0.0.1/`; the cache suffix is chosen by the host. Its `mcp.json` launches the executable relative to that installed copy via `${PLUGIN_ROOT}`. Do not point the manifest at this repository or a global Bun installation. The cache behavior and local catalog layout follow the [official packaging guide](https://developers.openai.com/plugins/build/plugins).

These instructions prepare the installation; the desktop UI checks in [ACCEPTANCE.md](ACCEPTANCE.md) are performed by the user. Automated tests verify unpacking, cache-copy launch, stdio tools and local workflows without using desktop UI automation.

## First use without credentials

Copy the synthetic workspace out of the package/cache. Assuming `BQ_TOOL_PACKAGE` names the absolute extracted marketplace root:

```sh
export BQ_TOOL_PACKAGE=/absolute/path/bq-tool-package
export BQ_TOOL_BIN="$BQ_TOOL_PACKAGE/plugins/bq-tool/dist/bq-tool"
cp -R "$BQ_TOOL_PACKAGE/plugins/bq-tool/examples/workspace" /absolute/path/bq-demo
"$BQ_TOOL_BIN" doctor
"$BQ_TOOL_BIN" local --workspace /absolute/path/bq-demo \
  --inputs-file "$BQ_TOOL_PACKAGE/plugins/bq-tool/examples/inputs.json" \
  --sql-file "$BQ_TOOL_PACKAGE/plugins/bq-tool/examples/query.sql" --save
```

Use a new destination for the copy. The expected result is North: four orders / 130.50, South: one order / 40.00. See [the fixture explanation](../examples/README.md). In a desktop chat, provide the copied workspace path and ask BQ Tool to join its accounts and orders snapshots and save revenue by region. All data is synthetic, and its IDs deliberately exceed JavaScript's exact integer range.

Keep workspaces outside plugin source, build output and cache. Package rebuilds and plugin refreshes can replace those directories.

## Connect your warehouse

Use your organization's supported ADC setup. For an interactive local Google account, the usual setup is:

```sh
gcloud auth application-default login
"$BQ_TOOL_BIN" probe --project YOUR_BILLING_PROJECT --location YOUR_BIGQUERY_LOCATION
```

The probe creates a fixed table-free query job with a 10 MiB scan cap and verifies exact local type transfer. Authenticated gcloud CLI credentials alone do not establish ADC. BQ Tool does not log in, switch projects, fall back to another credential source, or modify IAM. Consult [Google's ADC setup](https://docs.cloud.google.com/docs/authentication/provide-credentials-adc).

The credential needs BigQuery job creation in the chosen billing project and read/metadata permissions on relevant datasets, tables and verifiable views. Pass project/location explicitly to MCP tools. CLI flags can default from `BQ_TOOL_PROJECT` and `BQ_TOOL_LOCATION`, but desktop applications may not inherit terminal exports. If using `GOOGLE_APPLICATION_CREDENTIALS` or a custom ADC arrangement, ensure it reaches the host-launched MCP process; do not put credential material in the plugin package.

Then give the agent a billing project, execution location, a new absolute workspace path outside the plugin, and an analysis question. Supply optional private warehouse Markdown explicitly; a [context template](../examples/warehouse-context.md) is included. The `bq-analysis` skill guides discovery, grain/join checks, bounded extraction, local reuse and evidence references.

## Refresh and remove

Rebuild or unpack the new package into the marketplace's source directory. Reinstall/refresh BQ Tool from Plugins and restart the desktop app or CLI session so the installed cache picks up the executable and skill. For local sources, `codex plugin marketplace upgrade` is not a binary build step. Verify that the cached executable runs `doctor` if a source edit appears to have no effect.

Remove using Plugins or `codex plugin remove bq-tool@bq-tool-local`; remove the catalog registration with `codex plugin marketplace remove bq-tool-local` if no longer needed. Neither command should be used to delete your separate analysis workspaces. For requested data deletion, use `bq-tool delete-result` explicitly.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Plugin absent | Build first; register the marketplace root, not `.agents/plugins` or `plugins/bq-tool`; restart and check host/workspace policy |
| Executable missing in cache | Repackage/reinstall; check `dist/bq-tool` inside the installed plugin, not only the source checkout |
| Wrong executable architecture | Use a package built for the recipient's native OS/architecture |
| ADC error in desktop only | Check credentials available to the host process, independently of terminal gcloud login |
| Query pending | Poll `save_run` with the workspace's registered job reference; do not re-execute SQL |
| `WORKSPACE_BUSY` | Wait for the other writer; readers can continue |
| Unsupported SQL/type or exceeded limit | Reformulate/narrow the query; inspect its receipt and use already authorized limits |

Public-directory submission is separate from this local prototype. OpenAI currently requires approved-partner allowlisting for local MCP submissions; see [desktop-only submission requirements](https://developers.openai.com/plugins/deploy/desktop-only). The project's open-source license still needs to be chosen before a public release.
