import Database from "better-sqlite3";
import { Pool } from "pg";

const sourcePath = process.env.SQLITE_SOURCE_PATH;
const connectionString = process.env.DATABASE_URL;

if (!sourcePath || !connectionString) throw new Error("SQLITE_SOURCE_PATH and DATABASE_URL are required");

const source = new Database(sourcePath, { readonly: true });
const target = new Pool({ connectionString });
const tables = ["users", "courses", "access", "access_users", "selections", "config"] as const;

async function main() {
  const client = await target.connect();
  try {
    const existing = await client.query("SELECT (SELECT count(*) FROM users) + (SELECT count(*) FROM courses) + (SELECT count(*) FROM selections) AS total");
    if (Number(existing.rows[0].total) !== 0) throw new Error("target PostgreSQL database is not empty; refusing to overwrite data");
    await client.query("BEGIN");
    for (const table of tables) {
      const rows = source.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
      if (rows.length === 0) continue;
      const columns = Object.keys(rows[0]);
      const values = rows.map((row, rowIndex) => `(${columns.map((_column, columnIndex) => `$${rowIndex * columns.length + columnIndex + 1}`).join(",")})`).join(",");
      await client.query(`INSERT INTO ${table} (${columns.join(",")}) VALUES ${values}`, rows.flatMap((row) => columns.map((column) => row[column])));
    }
    for (const table of ["users", "courses", "access", "selections"]) {
      await client.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 1), (SELECT COUNT(*) > 0 FROM ${table}))`);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    source.close();
    await target.end();
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
