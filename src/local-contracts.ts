import { z } from "zod";
import { fieldSchema } from "./bigquery.ts";
import { queryInput, receiptSchema, runRef, tableOutput } from "./contracts.ts";

export const workspaceInput = z.strictObject({ workspace: z.string().min(1).max(4096) });
export const openWorkspaceInput = workspaceInput.extend({ maxDiskBytes: z.number().int().min(1_048_576).max(10_737_418_240).optional() });
export const workspaceMetadata = z.object({ version: z.literal(1), id: z.string().uuid(), createdAt: z.string(), maxDiskBytes: z.number().int() });
export const workspaceOutput = workspaceMetadata.extend({ workspace: z.string(), runs: z.array(z.object({ run: runRef, resultId: z.string() })) });
export const resultId = z.string().regex(/^r_[a-f0-9]{32}$/);
export const resultInput = workspaceInput.extend({ resultId });
export const listResultsInput = workspaceInput.extend({ after: resultId.optional(), limit: z.number().int().min(1).max(100).default(50) });
export const extractInput = queryInput.extend({ workspace: workspaceInput.shape.workspace, maxRows: queryInput.shape.maxRows.default(100_000), maxResultBytes: queryInput.shape.maxResultBytes.default(104_857_600) });
export const saveRunInput = workspaceInput.extend({ run: runRef, waitMs: queryInput.shape.waitMs.default(0) });
export const localInput = workspaceInput.extend({
  sql: queryInput.shape.sql,
  inputs: z.array(z.strictObject({ alias: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/), resultId })).min(1).max(20),
  save: z.boolean().default(false), maxRows: queryInput.shape.maxRows.default(1000),
  maxResultBytes: queryInput.shape.maxResultBytes.default(1_048_576), timeoutMs: z.number().int().min(10).max(60_000).default(30_000),
});
export const localSchema = z.array(z.object({ name: z.string(), type: z.string() }));
export const rowsSchema = z.array(z.record(z.string(), z.json()));
const parentSchema = z.object({ alias: z.string(), resultId, sha256: z.string(), sql: z.string() });
export const resultMetadata = z.object({
  version: z.literal(1), resultId, createdAt: z.string(), complete: z.literal(true),
  rowCount: z.number().int().nonnegative(), schema: localSchema, bigquerySchema: z.array(fieldSchema).nullable(),
  parquetBytes: z.number().int(), sha256: z.string(), sql: z.string(),
  origin: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("bigquery"), run: runRef, receipt: receiptSchema, sourceMetadata: z.array(z.object({ source: z.string(), metadata: tableOutput.nullable(), error: z.string().nullable() })) }),
    z.object({ kind: z.literal("local"), parents: z.array(parentSchema), limits: z.object({ maxRows: z.number(), maxResultBytes: z.number(), timeoutMs: z.number(), memoryBytes: z.number() }) }),
  ]),
});
export type ResultMetadata = z.infer<typeof resultMetadata>;
export const resultOutput = resultMetadata.extend({ workspace: z.string(), parquetPath: z.string(), sqlPath: z.string(), receiptPath: z.string(), deleted: z.boolean(), preview: z.object({ rows: rowsSchema, complete: z.boolean() }) });
export const listResultsOutput = z.object({ results: z.array(resultMetadata.extend({ deleted: z.boolean() })), nextAfter: resultId.nullable() });
export const savedRunOutput = z.object({ state: z.enum(["RUNNING", "SUCCEEDED", "FAILED", "CANCEL_REQUESTED", "LIMIT_EXCEEDED"]), run: runRef, result: resultOutput.optional(), error: z.object({ code: z.string(), message: z.string() }).optional() });
export const localOutput = z.object({ rows: rowsSchema.optional(), schema: localSchema, rowCount: z.number(), complete: z.literal(true), preview: z.object({ rows: rowsSchema, complete: z.boolean() }), result: resultOutput.optional() });
export const deleteOutput = z.object({ resultId, deleted: z.literal(true) });
export const exportInput = resultInput.extend({ destination: z.string().min(1), format: z.enum(["parquet", "csv", "json", "sql"]).default("parquet") });
export const exportOutput = z.object({ resultId, destination: z.string(), format: z.string(), bytes: z.number() });
