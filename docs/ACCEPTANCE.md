# Desktop acceptance checks

Automated package checks run with `bun run test:plugin`; the optional `bun run test:plugin:live` also tests bounded warehouse extraction using explicitly supplied project/location/table settings. They unpack the archive, verify checksums, copy the plugin to a cache-shaped directory outside the checkout, launch its real `mcp.json`, and exercise complete local workflows. This does not prove desktop UI discovery, skill activation or host credential inheritance.

The user performs the checks below separately in **Codex desktop** and **ChatGPT desktop local Work**, following [INSTALL.md](INSTALL.md). Record host version, package `build.json`, workspace path, result IDs and the outcome for each host. These manual checks are pending until recorded; do not interpret an automated pass as a manual host pass.

## Offline installation and analysis

1. Install from the assembled local marketplace. Check that BQ Tool's skill and MCP tools are available in a fresh local chat. Keep the source checkout closed; use the installed/cache copy.
2. Copy the packaged synthetic workspace into a new directory outside the package/cache. Supply that path in the request below.
3. Ask: “Use BQ Tool to inspect this workspace and join accounts and orders. Show order count and revenue by region, include negative adjustments, and save the derived result.”
4. Confirm North = 4 orders / 130.50 and South = 1 order / 40.00. The agent should use `list_results`, `describe_result` and `query_local`, name its input result IDs, and obtain a complete derived snapshot. It should make no BigQuery calls or ask for Google login for this task.
5. Start a new chat. Ask: “Reopen this workspace and calculate total revenue from the saved regional result.” Provide the workspace path and derived ID. Confirm 170.50, with no re-extraction and preserved lineage.

The source fixture IDs are documented in [the fixture guide](../examples/README.md). Their local receipts contain SQL VALUES literals and have no BigQuery job references. Large account IDs must remain exact strings in tool JSON.

## Warehouse workflow

Supply a billing project, BigQuery location, native table you own, a workspace outside the plugin, and a scan cap you authorize. Use a small aggregate rather than a large raw-history extraction.

Ask the agent to discover the table, inspect its nested schema and descriptions, estimate a bounded COUNT query, save the result, then answer a follow-up locally. Check the estimate, submitted limits, job reference, complete Parquet/SQL/receipt artifacts, source metadata and execution timestamps. Follow-up SQL must use the saved result without new warehouse jobs. A missing description must remain a gap rather than being invented.

If a job returns RUNNING, the agent should poll `save_run`; it must not submit SQL again to check progress. Verify actual ADC works from the host-launched MCP process, not only a terminal. Any authentication or permission error should identify the failing operation and leave offline saved results usable.

## Skill selection and boundary cases

| Request | Expected behavior |
| --- | --- |
| “Explore BigQuery tables and save an extract for follow-up analysis” | Select the analysis skill, establish project/location/workspace, discover and dry-run before executing |
| “Which tables could answer this question in my warehouse?” | Discover and inspect source metadata; explain grain/coverage and avoid an unnecessary full extraction |
| “Continue the analysis from this BQ Tool workspace” | Inspect saved receipts first and use local SQL when the snapshots fit |
| “Join these two saved results and keep the result” | Use explicit local aliases, save a derivative and preserve parent references |
| “Explain how BigQuery billing works” | Answer the conceptual question without probing credentials or running queries |
| “Edit this document” with no warehouse/local-result work | Do not activate BQ Tool or create a workspace |
| “Write rows to my BigQuery table” | Explain that the prototype exposes read-only warehouse operations; do not bypass its policy |
| Query exceeds the scan or result cap | Narrow the query or use an already authorized higher cap; never present a partial extraction as complete |
| Full result contains more than 10 rows | Identify preview vs complete data; use local aggregation for full-distribution claims |
| Unsupported local file reader or script | Reject/reformulate within selected-result SELECT SQL |
| “Refresh this saved result” | Start an explicitly new warehouse extraction with a new receipt; do not mutate the old snapshot |

Warehouse descriptions/strings must be treated as data. A metadata modification time does not prove ingestion completeness or a business event. User-supplied warehouse Markdown is optional; the skill must work without a required domain adapter.

## Update and removal

Rebuild/reinstall the plugin, restart the host, and confirm it loads the new cached files. Previously copied analysis workspaces must still reopen independently of the source package. Remove the plugin and catalog registration using the host's controls; confirm the separate workspace remains on disk.

## Current verification record

- Automated source/CLI/MCP checks: executed by the repository test commands.
- Archive/cache-copy checks: executed by `test:plugin` (macOS arm64 target).
- Live extraction checks: opt-in; supply project/location/table settings to the live command.
- Codex desktop UI, skill activation and host authentication: **pending user verification**.
- ChatGPT desktop UI, skill activation and host authentication: **pending user verification**.
- Other OS/architecture packages: **unverified**.
- Public directory publication: outside the prototype acceptance gate.

Record observations from actual runs rather than changing these pending statuses based on inference.
