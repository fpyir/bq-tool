import type { JobMetadata, Query } from "@google-cloud/bigquery";
import { z } from "zod";
import { createClient } from "./connection.ts";
import type { ClientFactory } from "./connection.ts";
import { decodeRow, fieldSchema } from "./bigquery.ts";
import type { Row } from "./bigquery.ts";
import { dryRunOutput, getRunInput, limitsSchema, parameterSchema, queryInput, runOutput, runRef, ToolError } from "./contracts.ts";
import type { QueryInput, RunRef } from "./contracts.ts";
import { inspectReadQuery } from "./sql-policy.ts";
import { auditSources, validateDryRun } from "./source-policy.ts";

function options(input: QueryInput): Query {
  return {
    query: input.sql, location: input.location, useLegacySql: false,
    maximumBytesBilled: input.maximumBytesBilled, jobTimeoutMs: input.timeoutMs,
    parameterMode: "NAMED",
    queryParameters: input.parameters.map((parameter) => ({
      name: parameter.name, parameterType: { type: parameter.type }, parameterValue: parameter.value === null ? {} : { value: parameter.value },
    })),
    labels: {
      application: "bq-tool", operation: "read-query",
      bq_max_rows: String(input.maxRows), bq_max_result_bytes: String(input.maxResultBytes),
    },
  };
}

function context(metadata: JobMetadata, ref: RunRef) {
  if (metadata.configuration?.labels?.application !== "bq-tool" || metadata.configuration.labels.operation !== "read-query" || !metadata.configuration.query) {
    throw new ToolError("RUN_REFERENCE", "Job is not a BQ Tool read-query run");
  }
  const config = metadata.configuration.query;
  if (config.useLegacySql !== false || !config.query || !config.maximumBytesBilled || !metadata.configuration.jobTimeoutMs) {
    throw new ToolError("RUN_REFERENCE", "Job is missing required read-query configuration");
  }
  inspectReadQuery(config.query, ref.project);
  const limits = limitsSchema.parse({
    maximumBytesBilled: config.maximumBytesBilled,
    maxRows: Number(metadata.configuration.labels.bq_max_rows),
    maxResultBytes: Number(metadata.configuration.labels.bq_max_result_bytes),
    timeoutMs: Number(metadata.configuration.jobTimeoutMs),
  });
  const parameters = z.array(parameterSchema).parse((config.queryParameters ?? []).map((parameter) => ({
    name: parameter.name, type: parameter.parameterType?.type, value: parameter.parameterValue?.value ?? null,
  })));
  const stats = metadata.statistics;
  const iso = (value: string | undefined) => value ? new Date(Number(value)).toISOString() : null;
  return {
    run: ref,
    receipt: {
      sql: config.query, parameters, limits,
      sources: [...stats?.query?.referencedTables ?? [], ...stats?.query?.referencedLogicalViews ?? []].map((source) => ({ project: source.projectId, dataset: source.datasetId, table: source.tableId })),
      createdAt: iso(stats?.creationTime), startedAt: iso(stats?.startTime), endedAt: iso(stats?.endTime),
      bytesProcessed: stats?.query?.totalBytesProcessed ?? null,
      bytesBilled: stats?.query?.totalBytesBilled ?? null, cacheHit: stats?.query?.cacheHit ?? null,
    },
  };
}

export class ReadQueries {
  constructor(private readonly client: ClientFactory = createClient) {}

  async dryRun(raw: z.input<typeof queryInput>) {
    const input = queryInput.parse(raw);
    if (new Set(input.parameters.map((parameter) => parameter.name)).size !== input.parameters.length) {
      throw new ToolError("QUERY_PARAMETERS", "Named query parameters must be unique");
    }
    const direct = inspectReadQuery(input.sql, input.project);
    const [job] = await this.client(input.project, input.location).createQueryJob({ ...options(input), dryRun: true });
    const discovered = validateDryRun(job.metadata);
    const sources = await auditSources(this.client, input.location, [...direct, ...discovered]);
    const estimatedBytes = z.string().regex(/^\d+$/).parse(job.metadata.statistics?.query?.totalBytesProcessed);
    if (BigInt(estimatedBytes) > BigInt(input.maximumBytesBilled)) {
      throw new ToolError("SCAN_LIMIT", `Estimated ${estimatedBytes} bytes exceeds maximumBytesBilled=${input.maximumBytesBilled}`);
    }
    return dryRunOutput.parse({
      sql: input.sql, parameters: input.parameters, estimatedBytes, statementType: "SELECT",
      schema: job.metadata.statistics?.query?.schema?.fields ?? [], sources, limits: limitsSchema.parse(input),
    });
  }

  async run(raw: z.input<typeof queryInput>) {
    const input = queryInput.parse(raw);
    await this.dryRun(input);
    const [job] = await this.client(input.project, input.location).createQueryJob(options(input));
    const ref = runRef.parse({ project: input.project, location: input.location, jobId: job.id });
    try { return await this.get({ ...ref, waitMs: input.waitMs }); }
    catch (error) {
      throw new ToolError("RUN_READ", `Query submitted as ${JSON.stringify(ref)}. Retry get_run; ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async get(raw: z.input<typeof getRunInput>) {
    const input = getRunInput.parse(raw);
    const ref: RunRef = { project: input.project, location: input.location, jobId: input.jobId };
    const job = this.client(input.project, input.location).job(input.jobId, { location: input.location });
    const deadline = Date.now() + input.waitMs;
    let [metadata] = await job.getMetadata();
    let base = context(metadata, ref);
    while (metadata.status?.state !== "DONE" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(200, Math.max(0, deadline - Date.now()))));
      [metadata] = await job.getMetadata();
      base = context(metadata, ref);
    }
    if (metadata.status?.state !== "DONE") return runOutput.parse({ ...base, state: "RUNNING" });
    if (metadata.status.errorResult) {
      return runOutput.parse({ ...base, state: "FAILED", error: { code: metadata.status.errorResult.reason ?? "QUERY_FAILED", message: metadata.status.errorResult.message ?? "BigQuery job failed" } });
    }
    if (metadata.statistics?.query?.statementType !== "SELECT" || metadata.statistics.query.referencedRoutines?.length) {
      throw new ToolError("RUN_REFERENCE", "Completed job is not a supported SELECT");
    }
    const limits = base.receipt.limits;
    const rows: Row[] = [];
    const seen = new Set<string>();
    let pageToken: string | undefined;
    let fields: z.infer<typeof fieldSchema>[] = [];
    let totalRows = "0";
    let bytes = 0;
    do {
      const [wireRows, , response] = await job.getQueryResults({
        autoPaginate: false, skipParsing: true, maxResults: Math.min(500, limits.maxRows - rows.length + 1),
        timeoutMs: 1000, "formatOptions.useInt64Timestamp": true, ...(pageToken ? { pageToken } : {}),
      });
      if (!response?.jobComplete) throw new ToolError("RESULT_READ", "BigQuery results are not complete; retry get_run");
      totalRows = z.string().regex(/^\d+$/).parse(response.totalRows);
      if (BigInt(totalRows) > BigInt(limits.maxRows)) {
        return runOutput.parse({ ...base, state: "LIMIT_EXCEEDED", error: { code: "ROW_LIMIT", message: `Result has ${totalRows} rows; limit is ${limits.maxRows}. No partial result returned.` } });
      }
      if (!pageToken) {
        fields = z.array(fieldSchema).parse(response.schema?.fields);
        bytes = Buffer.byteLength(JSON.stringify({ schema: fields, rows: [] }));
      }
      for (const wireRow of wireRows as unknown[]) {
        const row = decodeRow(fields, wireRow);
        bytes += Buffer.byteLength(JSON.stringify(row)) + 1;
        if (rows.length >= limits.maxRows || bytes > limits.maxResultBytes) {
          return runOutput.parse({ ...base, state: "LIMIT_EXCEEDED", error: { code: "RESULT_LIMIT", message: "Decoded result exceeds configured row/byte limits. No partial result returned." } });
        }
        rows.push(row);
      }
      if (bytes > limits.maxResultBytes) return runOutput.parse({ ...base, state: "LIMIT_EXCEEDED", error: { code: "RESULT_LIMIT", message: "Result schema exceeds the byte limit." } });
      pageToken = response.pageToken;
      if (pageToken && seen.has(pageToken)) throw new ToolError("RESULT_READ", "BigQuery repeated a results page token");
      if (pageToken) seen.add(pageToken);
    } while (pageToken);
    if (BigInt(rows.length) !== BigInt(totalRows)) throw new ToolError("RESULT_READ", "Incomplete result pagination; retry get_run");
    return runOutput.parse({ ...base, state: "SUCCEEDED", result: { schema: fields, rows, totalRows, complete: true } });
  }

  async cancel(raw: RunRef) {
    const ref = runRef.parse(raw);
    const job = this.client(ref.project, ref.location).job(ref.jobId, { location: ref.location });
    const [metadata] = await job.getMetadata();
    const base = context(metadata, ref);
    if (metadata.status?.state === "DONE") return this.get(ref);
    await job.cancel();
    return runOutput.parse({ ...base, state: "CANCEL_REQUESTED" });
  }
}
