import { BigQuery } from "@google-cloud/bigquery";
import { z } from "zod";

export const projectSchema = z.string().regex(/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/, "Use a Google Cloud project ID");
export const locationSchema = z.string().regex(/^[a-zA-Z][a-zA-Z0-9-]*$/, "Use a BigQuery location");
export const connectionSchema = z.strictObject({ project: projectSchema, location: locationSchema });
export type ClientFactory = (project: string, location?: string) => BigQuery;
export const createClient: ClientFactory = (project, location) => new BigQuery({ projectId: project, ...(location ? { location } : {}) });
