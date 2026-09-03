import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, closeDb } from "./index";

async function main() {
  try {
    await migrate(db, { migrationsFolder: "drizzle" });
  } finally {
    await closeDb();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
