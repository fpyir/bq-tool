import { z } from "zod";
import { fieldSchema } from "./bigquery.ts";
import { connectionSchema, projectSchema } from "./connection.ts";

const dataset = z.string().regex(/^[A-Za-z0-9_]{1,1024}$/);
const table = z.string().regex(/^[\p{L}\p{M}\p{N}_\- ]{1,1024}$/u);
const pagination = {
  pageSize: z.number().int().min(1).max(1000).default(50),
  pageToken: z.string().min(1).max(8192).optional(),
};
export const datasetsInput = z.strictObject({ project: projectSchema, ...pagination });
export const tablesInput = datasetsInput.extend({ dataset, search: z.string().max(256).optional() });
export const tableInput = z.strictObject({ project: projectSchema, dataset, table });
export const datasetsOutput = z.object({
  datasets: z.array(z.object({ project: z.string(), dataset: z.string(), location: z.string().nullable(), friendlyName: z.string().nullable() })),
  nextPageToken: z.string().nullable(),
});
export const tablesOutput = z.object({
  tables: z.array(z.object({ project: z.string(), dataset: z.string(), table: z.string(), type: z.string(), friendlyName: z.string().nullable() })),
  scanned: z.number().int(), nextPageToken: z.string().nullable(),
});
export const tableOutput = z.object({
  project: z.string(), dataset: z.string(), table: z.string(), type: z.string(), location: z.string().nullable(),
  description: z.string().nullable(), schema: z.array(fieldSchema),
  rows: z.string().nullable(), bytes: z.string().nullable(), modifiedAt: z.string().nullable(),
  partitioning: z.json().nullable(), clustering: z.array(z.string()),
  requirePartitionFilter: z.boolean(), external: z.boolean(), viewSql: z.string().nullable(),
});

export const parameterSchema = z.strictObject({
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  type: z.enum(["STRING", "INT64", "FLOAT64", "BOOL", "NUMERIC", "BIGNUMERIC", "DATE", "DATETIME", "TIME", "TIMESTAMP", "JSON"]),
  value: z.string().max(65_536).nullable(),
});
export const queryInput = connectionSchema.extend({
  sql: z.string().min(1).max(65_536).refine((value) => Buffer.byteLength(value) <= 65_536, "SQL exceeds 64 KiB"),
  parameters: z.array(parameterSchema).max(100).refine((value) => Buffer.byteLength(JSON.stringify(value)) <= 65_536, "Parameters exceed 64 KiB").default([]),
  maximumBytesBilled: z.string().regex(/^[1-9]\d{0,18}$/).refine((value) => BigInt(value) <= 9223372036854775807n).default("1073741824"),
  maxRows: z.number().int().min(1).max(100_000).default(1000),
  maxResultBytes: z.number().int().min(1).max(104_857_600).default(1_048_576),
  timeoutMs: z.number().int().min(1000).max(600_000).default(30_000),
  waitMs: z.number().int().min(0).max(10_000).default(1000),
});
export type QueryInput = z.infer<typeof queryInput>;
export const runRef = connectionSchema.extend({ jobId: z.string().regex(/^[A-Za-z0-9_-]{1,1024}$/) });
export type RunRef = z.infer<typeof runRef>;
export const getRunInput = runRef.extend({ waitMs: z.number().int().min(0).max(10_000).default(0) });
export const limitsSchema = queryInput.pick({ maximumBytesBilled: true, maxRows: true, maxResultBytes: true, timeoutMs: true }).strip();
export const sourceRef = z.object({ project: z.string(), dataset: z.string(), table: z.string() });
export const dryRunOutput = z.object({
  sql: z.string(), parameters: z.array(parameterSchema), estimatedBytes: z.string(),
  statementType: z.literal("SELECT"), schema: z.array(fieldSchema),
  sources: z.array(sourceRef), limits: limitsSchema,
});
export const receiptSchema = z.object({
  sql: z.string(), parameters: z.array(parameterSchema), limits: limitsSchema,
  sources: z.array(sourceRef),
  createdAt: z.string().nullable(), startedAt: z.string().nullable(), endedAt: z.string().nullable(),
  bytesProcessed: z.string().nullable(), bytesBilled: z.string().nullable(), cacheHit: z.boolean().nullable(),
});
export const runOutput = z.object({
  state: z.enum(["RUNNING", "SUCCEEDED", "FAILED", "CANCEL_REQUESTED", "LIMIT_EXCEEDED"]),
  run: runRef,
  receipt: receiptSchema,
  result: z.object({ schema: z.array(fieldSchema), rows: z.array(z.record(z.string(), z.json())), totalRows: z.string(), complete: z.literal(true) }).optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});

export class ToolError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
