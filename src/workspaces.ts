import { copyFile, link, mkdir, realpath, readdir, rm, stat } from "node:fs/promises";
import { join, dirname, resolve, relative } from "node:path";
import { constants } from "node:fs";
import { z } from "zod";
import type { Row } from "./bigquery.ts";
import { Catalog } from "./catalog.ts";
import { ReadQueries } from "./queries.ts";
import { ToolError, queryInput } from "./contracts.ts";
import { resultInput, listResultsInput, extractInput, saveRunInput, localInput, exportInput, resultOutput, localOutput, savedRunOutput, listResultsOutput } from "./local-contracts.ts";
import type { ResultMetadata } from "./local-contracts.ts";
import { WorkspaceStore, hashFile, readJson, runResultId, savedRun, writeFileDurable } from "./workspace-store.ts";
import { withEngine, importRows, evaluate, readOutput, writeParquet, preview, MEMORY_BYTES, literal, normalizeParquetTypes } from "./local-engine.ts";

export class Workspaces {
  constructor(private readonly queries = new ReadQueries(), private readonly catalog = new Catalog()) {}
  open = WorkspaceStore.open;

  async describeResult(raw: z.input<typeof resultInput>) {
    const input = resultInput.parse(raw);
    const store = await WorkspaceStore.load(input.workspace);
    const saved = await store.get(input.resultId);
    let small = { rows: [] as z.infer<typeof localOutput>["preview"]["rows"], complete: false };
    if (!saved.deleted) {
      await store.verified(input.resultId);
      small = await withEngine([saved.parquet], 30_000, async (connection) => {
        await connection.run(`CREATE TABLE output AS SELECT * FROM read_parquet(${literal(saved.parquet)}) LIMIT 10`);
        const data = await readOutput(connection, 10, 104_857_600);
        const value = preview(data.rows);
        return { ...value, complete: value.rows.length === saved.metadata.rowCount };
      });
    }
    const directory = store.resultPath(input.resultId);
    return resultOutput.parse({ ...saved.metadata, workspace: store.root, parquetPath: saved.parquet, sqlPath: join(directory, "query.sql"), receiptPath: join(directory, "receipt.json"), deleted: saved.deleted, preview: small });
  }

  async listResults(raw: z.input<typeof listResultsInput>) {
    const input = listResultsInput.parse(raw);
    const store = await WorkspaceStore.load(input.workspace);
    const ids = (await readdir(join(store.root, "results"))).filter((name) => /^r_[a-f0-9]{32}$/.test(name)).sort().filter((name) => !input.after || name > input.after);
    const selected = ids.slice(0, input.limit);
    const results = [];
    for (const id of selected) { const value = await store.get(id); results.push({ ...value.metadata, deleted: value.deleted }); }
    return listResultsOutput.parse({ results, nextAfter: ids.length > selected.length ? selected.at(-1) : null });
  }

  async extract(raw: z.input<typeof extractInput>) {
    const input = extractInput.parse(raw);
    const store = await WorkspaceStore.load(input.workspace);
    return store.mutate(async () => {
      await store.checkQuota(2 * input.maxResultBytes + 262_144);
      if ((await readdir(join(store.root, "runs"))).length >= 1000) throw new ToolError("WORKSPACE_RUN_LIMIT", "Use a new workspace after 1000 extraction runs");
      const { workspace: _, ...query } = input;
      const ref = await this.queries.submit(queryInput.parse(query));
      const record = { run: ref, resultId: runResultId(ref), query: queryInput.parse(query), createdAt: new Date().toISOString() };
      // Write the run reference before polling or retrieving any result pages.
      try { await writeFileDurable(join(store.root, "runs", `${record.resultId}.json`), JSON.stringify(record)); }
      catch (error) { throw new ToolError("RUN_SAVE", `Job submitted as ${JSON.stringify(ref)} but its reference could not be saved: ${String(error)}`); }
      return this.materialize(store, { workspace: store.root, run: ref, waitMs: input.waitMs });
    });
  }

  async saveRun(raw: z.input<typeof saveRunInput>) {
    const input = saveRunInput.parse(raw);
    const store = await WorkspaceStore.load(input.workspace);
    return store.mutate(() => this.materialize(store, input));
  }

  private async materialize(store: WorkspaceStore, input: z.infer<typeof saveRunInput>) {
    const id = runResultId(input.run);
    const record = savedRun.parse(await readJson(join(store.root, "runs", `${id}.json`)));
    if (JSON.stringify(record.run) !== JSON.stringify(input.run)) throw new ToolError("RUN_REFERENCE", "Run reference does not match the workspace record");
    if (await Bun.file(join(store.resultPath(id), "receipt.json")).exists()) {
      const result = await this.describeResult({ workspace: store.root, resultId: id });
      if (result.deleted) throw new ToolError("RESULT_DELETED", "This snapshot was deleted; run a new extraction to refresh it");
      return savedRunOutput.parse({ state: "SUCCEEDED", run: input.run, result });
    }
    const run = await this.queries.get({ ...input.run, waitMs: input.waitMs });
    if (run.state !== "SUCCEEDED" || !run.result) return savedRunOutput.parse({ state: run.state, run: run.run, error: run.error });
    const sourceMetadata: Extract<ResultMetadata["origin"], { kind: "bigquery" }>["sourceMetadata"] = [];
    for (const source of run.receipt.sources) {
      try { sourceMetadata.push({ source: `${source.project}.${source.dataset}.${source.table}`, metadata: await this.catalog.describeTable(source), error: null }); }
      catch (error) { sourceMetadata.push({ source: `${source.project}.${source.dataset}.${source.table}`, metadata: null, error: String(error) }); }
    }
    await store.checkQuota(2 * run.receipt.limits.maxResultBytes + 262_144);
    const data = run.result;
    await store.publish(id, async (directory) => {
      const parquet = join(directory, "data.parquet");
      const schema = await withEngine([parquet], 30_000, async (connection) => {
        await importRows(connection, data.schema, data.rows as Row[]);
        await normalizeParquetTypes(connection);
        const output = await readOutput(connection, run.receipt.limits.maxRows, run.receipt.limits.maxResultBytes);
        await writeParquet(connection, parquet);
        return output.schema;
      });
      return {
        version: 1, resultId: id, createdAt: new Date().toISOString(), complete: true, rowCount: data.rows.length,
        schema, bigquerySchema: data.schema, parquetBytes: (await stat(parquet)).size, sha256: await hashFile(parquet), sql: run.receipt.sql,
        origin: { kind: "bigquery", run: run.run, receipt: run.receipt, sourceMetadata },
      };
    });
    return savedRunOutput.parse({ state: "SUCCEEDED", run: input.run, result: await this.describeResult({ workspace: store.root, resultId: id }) });
  }

  async queryLocal(raw: z.input<typeof localInput>) {
    const input = localInput.parse(raw);
    const store = await WorkspaceStore.load(input.workspace);
    const execute = async () => {
      const parents: Extract<ResultMetadata["origin"], { kind: "local" }>["parents"] = [];
      const sources: { alias: string; path: string }[] = [];
      for (const selected of input.inputs) {
        const saved = await store.verified(selected.resultId);
        sources.push({ alias: selected.alias, path: saved.parquet });
        parents.push({ ...selected, sha256: saved.metadata.sha256, sql: saved.metadata.sql });
      }
      const id = `r_${crypto.randomUUID().replaceAll("-", "")}`;
      let output: Awaited<ReturnType<typeof readOutput>> | undefined;
      const compute = async (parquet?: string) => withEngine([...sources.map((source) => source.path), ...parquet ? [parquet] : []], input.timeoutMs, async (connection) => {
        await evaluate(connection, input.sql, sources, input.maxRows);
        if (parquet) await normalizeParquetTypes(connection);
        output = await readOutput(connection, input.maxRows, input.maxResultBytes);
        if (parquet) await writeParquet(connection, parquet);
      });
      if (input.save) {
        await store.checkQuota(2 * input.maxResultBytes + 262_144);
        await store.publish(id, async (directory): Promise<ResultMetadata> => {
          const parquet = join(directory, "data.parquet");
          await compute(parquet);
          return {
            version: 1, resultId: id, createdAt: new Date().toISOString(), complete: true, rowCount: output!.rows.length,
            schema: output!.schema, bigquerySchema: null, parquetBytes: (await stat(parquet)).size, sha256: await hashFile(parquet), sql: input.sql,
            origin: { kind: "local", parents, limits: { maxRows: input.maxRows, maxResultBytes: input.maxResultBytes, timeoutMs: input.timeoutMs, memoryBytes: MEMORY_BYTES } },
          };
        });
      } else { await compute(); }
      return localOutput.parse({ schema: output!.schema, rowCount: output!.rows.length, complete: true, preview: preview(output!.rows),
        ...input.save ? { result: await this.describeResult({ workspace: store.root, resultId: id }) } : { rows: output!.rows },
      });
    };
    return input.save ? store.mutate(execute) : execute();
  }

  async deleteResult(raw: z.input<typeof resultInput>) {
    const input = resultInput.parse(raw);
    const store = await WorkspaceStore.load(input.workspace);
    return store.mutate(async () => {
      const saved = await store.get(input.resultId);
      if (!saved.deleted) await writeFileDurable(join(store.resultPath(input.resultId), "deleted.json"), JSON.stringify({ deletedAt: new Date().toISOString() }));
      await rm(saved.parquet, { force: true });
      return { resultId: input.resultId, deleted: true as const };
    });
  }

  async exportResult(raw: z.input<typeof exportInput>) {
    const input = exportInput.parse(raw);
    const store = await WorkspaceStore.load(input.workspace);
    const saved = await store.verified(input.resultId);
    const requested = resolve(input.destination);
    await mkdir(dirname(requested), { recursive: true, mode: 0o700 });
    const destination = join(await realpath(dirname(requested)), requested.slice(requested.lastIndexOf("/") + 1));
    // Exports are explicit new files outside managed storage, never overwrites.
    const relation = relative(store.root, destination);
    if (relation !== ".." && !relation.startsWith("../")) throw new ToolError("EXPORT_PATH", "Export outside the managed workspace");
    const temporary = join(dirname(destination), `.bq-tool-export-${crypto.randomUUID()}`);
    try {
      if (input.format === "parquet") await copyFile(saved.parquet, temporary, constants.COPYFILE_EXCL);
      else if (input.format === "sql") await writeFileDurable(temporary, saved.metadata.sql);
      else await withEngine([saved.parquet, temporary], 30_000, async (connection) => {
        await connection.run(`COPY (SELECT * FROM read_parquet(${literal(saved.parquet)})) TO ${literal(temporary)} (FORMAT ${input.format === "csv" ? "CSV, HEADER true" : "JSON, ARRAY true"})`);
      });
      await link(temporary, destination);
      return { resultId: input.resultId, destination, format: input.format, bytes: (await stat(destination)).size };
    } finally { await rm(temporary, { force: true }); }
  }
}
