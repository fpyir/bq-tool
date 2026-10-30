import { z } from "zod";
import { fetchProbe, fieldSchema, probeInputSchema } from "./bigquery.ts";
import type { ProbeInput } from "./bigquery.ts";
import { checkRuntime, checkTransfer } from "./duckdb.ts";

export { checkRuntime };

export const runtimeSchema = z.object({ bun: z.string(), duckdb: z.string(), platform: z.string(), arch: z.string() });
export const probeResultSchema = z.object({
  ok: z.literal(true),
  runtime: runtimeSchema,
  source: z.object({
    job: z.object({
      id: z.string(), project: z.string(), location: z.string(),
      bytesProcessed: z.string(), bytesBilled: z.string(), cacheHit: z.boolean(),
    }),
    schema: z.array(fieldSchema),
    rows: z.array(z.record(z.string(), z.json())),
  }),
  local: z.object({
    columns: z.array(z.object({ name: z.string(), bigquery: z.string(), duckdb: z.string() })),
    checks: z.record(z.string(), z.boolean()),
  }),
});

export async function probeBigQuery(input: ProbeInput) {
  const parsed = probeInputSchema.parse(input);
  const runtime = await checkRuntime();
  const source = await fetchProbe(parsed);
  const local = await checkTransfer(source.fields, source.rows);
  return probeResultSchema.parse({
    ok: true as const,
    runtime,
    source: { job: source.job, schema: source.fields, rows: source.rows },
    local,
  });
}
