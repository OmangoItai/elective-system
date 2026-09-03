import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./index";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const drizzleDir = path.join(__dirname, "../../drizzle");

async function ensureMigrationsTable(client: any) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS drizzle_migrations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function run() {
  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);

    const files = fs
      .readdirSync(drizzleDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    for (const file of files) {
      const alreadyApplied = await client.query(
        `SELECT 1 FROM drizzle_migrations WHERE name = $1`,
        [file]
      );
      if ((alreadyApplied.rowCount ?? 0) > 0) {
        console.log(`Skipping ${file} (already applied)`);
        continue;
      }

      const sql = fs.readFileSync(path.join(drizzleDir, file), "utf-8");
      const statements = sql
        .split("--> statement-breakpoint")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      await client.query("BEGIN");
      try {
        for (const statement of statements) {
          await client.query(statement);
        }
        await client.query(
          `INSERT INTO drizzle_migrations (name) VALUES ($1)`,
          [file]
        );
        await client.query("COMMIT");
        console.log(`Applied ${file}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }

    console.log("Migrations done");
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
