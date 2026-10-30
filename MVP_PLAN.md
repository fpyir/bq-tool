# BQ Tool prototype plan

Status: proposed scope, 30 October 2026. No implementation has started.

BQ Tool gives agents a repeatable workflow for discovering BigQuery data, running bounded read queries, keeping useful results locally, and answering follow-up questions with traceable evidence. The first delivery is an open-source plugin for local Codex and ChatGPT desktop, backed by a CLI and one shared implementation.

## Product goal

An agent should be able to answer a real warehouse question, explain the definitions and limitations behind the answer, and continue the analysis in a later chat without downloading the same data again. The user should be able to inspect the SQL, source schema, execution details, and saved results independently of the conversation.

The prototype succeeds when a locally installed plugin can discover data, run a bounded BigQuery query, save its result, and answer follow-up questions locally across sessions. Synthetic fixtures make the same capabilities testable without private warehouse access. Use a small query against the owner's warehouse for live validation; the larger h2x acceptance scenario exercises the working prototype afterwards.

Architecture and release gates are defined by these general capabilities. Business definitions, source-data gaps, or expensive queries encountered in an individual analysis do not block building the prototype.

## Positioning

Google already provides [BigQuery MCP tools](https://docs.cloud.google.com/bigquery/docs/use-bigquery-mcp) for discovery, metadata, and SQL execution. Basic SQL access is a baseline to compare against. BQ Tool's proposed value is the local analysis workspace: durable results, local follow-up SQL, warehouse-specific context, and provenance carried through the workflow.

The host agent writes SQL and explains results. BQ Tool does not contain a second LLM, a text-to-SQL service, or a custom chat interface.

## Prototype boundaries

| Include | Defer |
| --- | --- |
| Local plugin, stdio MCP server, CLI | Hosted service and browser/cloud execution |
| Explicit billing project, source datasets, and execution location | Multi-tenant authentication and a hosted OAuth service |
| Metadata discovery, nested schemas, descriptions, and table sizes | Embedding search, inferred relationships, and a semantic-layer service |
| Bounded GoogleSQL read queries | Warehouse writes, scripts, procedures, external queries, remote functions, and AI/ML execution |
| Saved results and DuckDB follow-up queries | Transparent SQL federation between BigQuery and DuckDB |
| Explicit reusable workspace identifiers | Automatic host chat detection, shared mutable databases, tags, and default-table promotion |
| Structured results, small previews, SQL and file exports | Custom plugin UI, charting engine, dashboards, and scheduled analyses |
| One focused skill with optional user-supplied warehouse context | A large library of general data-analysis skills or a required domain integration |
| Repo/local plugin distribution | Public-directory publication as a prototype requirement |

## User workflow

1. Run a diagnostic command to confirm credentials, project, location, dataset access, and local storage.
2. Open or create an explicitly named local workspace.
3. Find relevant tables and inspect their schemas and available descriptions.
4. Establish the grain, candidate join keys, date range, metric definitions, and known coverage gaps.
5. Dry-run a GoogleSQL query, then execute it within configured limits.
6. Save the complete bounded result locally and return a result identifier, schema, small preview, row count, and execution receipt.
7. Use DuckDB SQL to filter, aggregate, or join saved results. Save a derived result when it will be reused.
8. Present findings with definitions, limitations, and references to the supporting result identifiers.
9. Reopen the workspace in a later chat and continue from the saved results, or explicitly refresh from BigQuery.

Saved results are snapshots. Reusing one never silently refreshes it. Refreshing produces a new result with its own execution time and provenance.

## Architecture

Use TypeScript on Node.js, the official BigQuery client, the official MCP SDK, and DuckDB's Node client. Node.js is the proposed runtime; the initial technical spike must verify installation and native DuckDB packaging on the target desktop.

```text
Codex / ChatGPT desktop
  skill instructions + stdio MCP tools
                         |
CLI ---------------- shared application core
                         |             |
                  BigQuery API      local workspace
                                       |
                              DuckDB analysis + files
```

The CLI and MCP server call the same operations. Neither shells out to the other. Credentials, SQL validation, execution limits, result serialization, and provenance have one implementation.

Use [Application Default Credentials](https://docs.cloud.google.com/docs/authentication/provide-credentials-adc) for the client library. An authenticated gcloud CLI does not prove that ADC works. Diagnostics must test actual client-library access and report the effective configuration without exposing tokens or credential files. Do not add an automatic credential fallback or silently change the selected identity.

### Local storage

Use a workspace directory with immutable typed Parquet results, a receipt and SQL file for each result, and workspace metadata. DuckDB opens the selected results for each local query. This avoids requiring several CLI or MCP processes to share a writable DuckDB database.

Publish result files atomically. Failed or interrupted downloads remain incomplete and cannot be queried as successful results. Derived results record their parent result identifiers and local SQL. Deleting a parent must preserve enough lineage to identify the missing input.

Metadata records the source project, location, referenced tables, available source modification metadata, query and parameters, BigQuery job identifier, execution timestamps, processed/billed bytes when available, cache status, schema, row count, completeness, and artifact paths. Source modification timestamps do not establish an ingestion watermark or event coverage.

Keep the stored BigQuery schema alongside the local schema. Test exact integers and decimals, timestamps and timezone semantics, nulls, arrays, structs, and JSON. Never coerce values through JavaScript numbers when that would lose precision. The type-conversion spike determines which nested values are mapped natively and which are retained as explicit JSON; unsupported mappings fail clearly.

### Tool surface

Keep the first interface small and explicit. These are proposed operations, not implemented commands.

| Operation | Purpose |
| --- | --- |
| Open workspace | Create or resume an explicit analysis workspace |
| List datasets | Discover configured source datasets with pagination |
| Search tables | Search table names and available descriptions; return bounded matches |
| Describe table | Return recursive schema, descriptions, size, partitioning, clustering, and modification metadata |
| Dry-run query | Validate GoogleSQL and return estimated bytes and policy outcome |
| Run query | Start a bounded read query and materialize a local result |
| Get run | Inspect progress or retrieve the completed result receipt |
| Cancel run | Request cancellation of a running query and record its outcome |
| List results | Find reusable results and inspect their provenance |
| Query local | Execute DuckDB SQL over selected saved results and optionally save a derived result |

Expose diagnostics, explicit artifact deletion, and exports through the CLI first. Use JSON output for agents, stderr for diagnostics, and documented nonzero exit codes for failures. MCP returns the same result records through structured schemas. A preview must always be distinguishable from the complete saved result.

Every operation takes its workspace or configuration explicitly; the MCP process must not rely on a mutable global current workspace. Long queries return a run identifier and can be polled. Persist job identifiers before lengthy downloads; resuming result retrieval must not resubmit the query.

### Query and resource controls

- Enforce BigQuery read policy in code. Permit one supported query statement, including CTEs; reject writes, scripts, procedures, external execution, and unsupported routine calls. Use dialect-aware validation and BigQuery dry-run information rather than a prefix regex. Test both legitimate queries and bypass attempts.
- Treat IAM as the authority for warehouse access. Prefer dataset-scoped Data Viewer and a billing-project Job User identity. Application configuration and skill instructions do not reduce the permissions of a broadly privileged credential. Do not change IAM as part of installation.
- Always dry-run before execution, and also set `maximumBytesBilled` on the real job. Google documents both in its [cost controls](https://docs.cloud.google.com/bigquery/docs/best-practices-costs). The setting bounds on-demand bytes billed; it is not a universal currency budget or capacity-pricing cap.
- Start with configurable defaults of 1 GiB maximum bytes billed per query, 100,000 downloaded rows, 100 MiB downloaded data, and a 10-row model preview. Enforce download limits during pagination. Exceeding a materialization limit produces an explicit incomplete result, not a usable truncated dataset. Query processing costs may already have occurred.
- Add job timeout and cancellation handling, plus local memory, disk, and execution limits. A client timeout is not proof that the server job stopped.
- Limit local SQL to the workspace's registered results and controlled derived-result creation. Restrict external access, extension loading, filesystem/network table functions, attachment, and arbitrary export destinations. A read-only SQL statement is not by itself a filesystem sandbox.
- Treat warehouse strings, descriptions, and query results as source data rather than executable instructions.

## Skills and optional warehouse context

Ship one focused `bq-analysis` skill. It teaches discovery, grain and join checks, cost-aware extraction, result reuse, validation of analytical claims, and evidence references. Reuse the host's existing reporting and charting capabilities.

The skill can use ordinary user-supplied Markdown containing definitions, known join relationships, freshness caveats, and example queries. This context is optional: an agent can start with discovery and SQL using only a configured BigQuery project. A custom context schema, domain adapter, or context-management service is not required for the prototype. Warehouse contents cannot write or promote instructions automatically.

The public repository contains generic configuration examples and synthetic data. Credentials, company-specific definitions, warehouse inventories, SQL containing private identifiers, and extracted results stay outside the distributable plugin. Users supply their own project, datasets, location, and optional context. BQ Tool contains no hardcoded h2x entities, metrics, production routes, or operation semantics.

## Plugin packaging and distribution

Use root `plugin.json`, `mcp.json`, `skills/`, and optional assets following the [portable plugin packaging guide](https://developers.openai.com/plugins/build/plugins). Package a local stdio server and its dependencies, with a repo marketplace entry for development installation. Verify that the installed copy runs independently of the source checkout; the host loads a cached plugin copy.

No custom UI or lifecycle hooks are needed for this prototype. Test a fresh local installation in both target hosts. Manual host and UI testing belongs to the user unless explicitly delegated.

Public-directory publication is a separate milestone: [local MCP submissions currently require approved-partner allowlisting](https://developers.openai.com/plugins/deploy/desktop-only). Repo/local distribution remains the prototype route. A later browser/cloud prototype could use [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) or a hosted server, with separate authentication, availability, and artifact-delivery work.

## Delivery sequence

| Milestone | Deliverable | Acceptance gate |
| --- | --- | --- |
| 0. Prove the technical path | Minimal CLI and stdio MCP entry points, ADC client access, one tiny query, DuckDB type round-trip spike | A small result can be read from BigQuery and queried locally through the chosen runtime; MCP initialization and one tool call work |
| 1. Discover and query | Shared core, CLI/MCP discovery, dry-run, bounded execution, job progress and cancellation, execution receipts | Dataset/table pagination and recursive schemas work; a small query matches reference results; writes and over-budget requests are rejected |
| 2. Continue locally | Complete result materialization, local SQL, derived results, reopen, deletion/export commands | Follow-up analysis and a fresh-process resume issue no BigQuery queries; interrupted extraction cannot masquerade as complete |
| 3. Deliver the plugin | Focused skill, portable plugin package, repo marketplace entry, synthetic fixtures, installation docs | A clean installed copy works independently of the source checkout; the user verifies discovery, query, local follow-up, and resume in both target hosts |

Implement these as vertical slices, introducing plugin packaging early enough to catch host integration problems. Run automated checks independently of the user's manual host testing. Avoid building a generic plugin framework, data catalog, or federation layer before the first query works through an installed plugin.

## General acceptance tests

The prototype is ready when these workflows pass:

1. **Discover and query:** starting from project configuration, find a table, inspect its nested schema, dry-run a query, execute it within limits, and obtain a complete saved result with a small preview and an execution receipt.
2. **Analyse locally:** extract two bounded results, join and aggregate them with DuckDB, and save the derived result with its input references. Verify the output against known fixture values and confirm that local queries issue no BigQuery requests.
3. **Resume:** start a fresh process or chat, reopen the workspace, inspect previous SQL and results, and answer a follow-up without rerunning the original extraction.
4. **Handle failure accurately:** reject unsupported statements and over-budget requests; report permission errors, empty results, interrupted downloads, and materialization limits without presenting partial data as complete. Resuming result retrieval must not submit a second query job.
5. **Use the installed plugin:** the user completes the same discovery, query, follow-up, and resume workflow in local Codex and ChatGPT desktop using the packaged installation.

Automated coverage focuses on read-policy enforcement, limit enforcement, type fidelity, complete pagination, interruption/retry behavior, provenance, workspace isolation, and CLI/MCP parity. Synthetic fixtures run without private credentials. Live warehouse checks use small, bounded queries. Manual frontend/host testing belongs to the user.

Track result agreement, new warehouse jobs per local follow-up, evidence completeness, bytes processed, and installation failures. Record runtime and model cost as observations rather than inventing performance targets before the baseline run.

## Real-world acceptance example

After the general workflow works, use the owner's chosen h2x question to evaluate usefulness on a substantial analysis:

> Find me 5 h2x projects that have completed system designs for heating + plumbing + ventilation, for commercial buildings. Give me their links in the production server, and analyse the edit history of these projects to help me visualise how these projects progressed from start -> current state.

Expected output:

- Five distinct project candidates with production links and supporting evidence for commercial use and all three systems across each project. Clearly labelled evidence-based candidates and substantial-design proxies are accepted; inferred completion must remain distinguishable from verified completion. Report a shortfall if fewer than five have sufficient evidence.
- Timelines of edits, observed system growth, and supported milestones, with history coverage and gaps stated. Actual drawing-layout playback is not requested. The host's existing visualisation tools consume BQ Tool's results.
- Saved candidate and timeline datasets that support local follow-up comparisons and reuse in another chat.

The agent establishes business definitions, joins, regional production URLs, and history interpretation while doing this analysis, using source evidence and optional private context. These do not introduce product-specific commands, a required domain adapter, or a replay engine into BQ Tool.

The warehouse inspection found potentially useful history sources, but eligibility evidence, history coverage, and scan budgets need investigation during the analysis. Those findings affect the example's outcome, not the prototype's architecture or delivery gates. If a query needs a higher explicit limit or the source needs preparation, record that as analysis setup; do not make warehouse changes or raise limits implicitly.

Use the example to identify missing reusable capabilities and distinguish tool defects from agent reasoning errors or source-data limitations. Record its outcome separately from the general prototype checks.

## Decisions remaining

- Confirm the supported type mapping and native dependency packaging during the technical spike.
- Tune configurable byte, row, disk, and runtime defaults using small representative queries; this does not require solving the h2x analysis first.
- Choose an open-source license before public release.

The local desktop target and general-purpose query/save/analyse/resume workflow define the prototype. Public listing, hosted access, transparent federation, tags, promotion, and general local CRUD remain outside its scope. The h2x example's agreed candidate-selection and timeline outputs define that acceptance exercise only.
