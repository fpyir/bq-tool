import { BigQuery } from "@google-cloud/bigquery";
import { z } from "zod";
import { PROBE_SQL } from "./probe-sql.ts";

export const probeInputSchema = z.strictObject({
  project: z.string().regex(/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/, "Use a Google Cloud project ID"),
  location: z.string().regex(/^[a-zA-Z][a-zA-Z0-9-]*$/, "Use a BigQuery location"),
});
export type ProbeInput = z.infer<typeof probeInputSchema>;

export interface Field {
  name: string;
  type: string;
  mode?: string | undefined;
  fields?: Field[] | undefined;
}

export const fieldSchema: z.ZodType<Field> = z.object({
  name: z.string(),
  type: z.string(),
  mode: z.string().optional(),
  fields: z.lazy(() => fieldSchema.array()).optional(),
});
const wireRowSchema = z.object({ f: z.array(z.object({ v: z.unknown() })) });

export type Value = string | boolean | null | Value[] | { [key: string]: Value };
export type Row = Record<string, Value>;

export interface ProbeData {
  fields: Field[];
  rows: Row[];
  job: {
    id: string;
    project: string;
    location: string;
    bytesProcessed: string;
    bytesBilled: string;
    cacheHit: boolean;
  };
}

// Decode the REST representation directly, before any JS number conversion.
export function decodeRow(fields: Field[], wireRow: unknown): Row {
  const { f: cells } = wireRowSchema.parse(wireRow);
  if (cells.length !== fields.length) throw new Error("BigQuery row/schema length mismatch");
  return Object.fromEntries(fields.map((field, index) => [field.name, decodeValue(field, cells[index]!.v)]));
}

function decodeValue(field: Field, value: unknown): Value {
  if (field.mode === "REPEATED") {
    return z.array(z.object({ v: z.unknown() })).parse(value)
      .map((cell) => decodeValue({ ...field, mode: "NULLABLE" }, cell.v));
  }
  if (value === null) return null;
  if (field.type === "RECORD") return decodeRow(field.fields ?? [], value);
  if (field.type === "TIMESTAMP") {
    const micros = BigInt(z.string().regex(/^-?\d+$/).parse(value));
    let seconds = micros / 1_000_000n;
    let fraction = micros % 1_000_000n;
    if (fraction < 0n) {
      seconds -= 1n;
      fraction += 1_000_000n;
    }
    // Whole seconds across BigQuery's date range are safely representable.
    // Format the microsecond fraction separately so Date cannot truncate it.
    return new Date(Number(seconds) * 1000).toISOString()
      .replace(/\.\d{3}Z$/, `.${String(fraction).padStart(6, "0")}Z`);
  }
  if (field.type === "BOOLEAN") {
    return z.enum(["true", "false"]).parse(value) === "true";
  }
  return z.string().parse(value);
}

export async function fetchProbe(input: ProbeInput): Promise<ProbeData> {
  const { project, location } = probeInputSchema.parse(input);
  const client = new BigQuery({ projectId: project, location });
  const query = {
    query: PROBE_SQL,
    location,
    useLegacySql: false,
    maximumBytesBilled: "10485760",
    jobTimeoutMs: 30_000,
    labels: { application: "bq-tool", operation: "prototype-probe" },
  };

  const [dryRun] = await client.createQueryJob({ ...query, dryRun: true });
  if (dryRun.metadata.statistics?.query?.statementType !== "SELECT") {
    throw new Error("Expected the fixed diagnostic query to validate as SELECT");
  }
  const [job] = await client.createQueryJob(query);
  try {
    const [wireRows, nextPage, response] = await job.getQueryResults({
      autoPaginate: false,
      maxResults: 2,
      timeoutMs: 30_000,
      skipParsing: true,
      "formatOptions.useInt64Timestamp": true,
    });
    if (!response?.jobComplete || nextPage || response.totalRows !== "1" || wireRows.length !== 1) {
      throw new Error("Expected exactly one complete diagnostic row");
    }
    const fields = z.array(fieldSchema).parse(response.schema?.fields);
    const [metadata] = await job.getMetadata();
    const statistics = metadata.statistics?.query;
    return {
      fields,
      rows: wireRows.map((row: unknown) => decodeRow(fields, row)),
      job: {
        id: z.string().parse(job.id),
        project,
        location,
        bytesProcessed: z.string().parse(statistics?.totalBytesProcessed),
        bytesBilled: z.string().parse(statistics?.totalBytesBilled),
        cacheHit: z.boolean().parse(statistics?.cacheHit),
      },
    };
  } catch (error) {
    // A failed read must not leave a possibly running diagnostic job unattended.
    await job.cancel().catch(() => undefined);
    throw error;
  }
}
