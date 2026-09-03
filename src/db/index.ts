import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/elective";

export const pool = new Pool({ connectionString });
export const db = drizzle(pool, { schema });

export async function closeDb(): Promise<void> {
  await pool.end();
}
