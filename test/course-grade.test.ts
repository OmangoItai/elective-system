import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { execSync } from "node:child_process";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { courses, selections, users } from "../src/db/schema";
import { removeIneligibleSelections } from "../src/services/course-grade";

const databaseUrl = process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/elective_test";

let pool: Pool;
let db: ReturnType<typeof drizzle>;

before(async () => {
  pool = new Pool({ connectionString: databaseUrl });
  db = drizzle(pool, { schema: { users, courses, selections } });
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
  execSync("npx drizzle-kit push", {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "ignore",
  });
});

after(async () => {
  await pool.end();
});

async function createFixture() {
  await db.delete(selections);
  await db.delete(courses);
  await db.delete(users);

  await db.insert(users).values([
    { username: "allowed", nickname: "Allowed", password: "x", grade: 2026 },
    { username: "removed", nickname: "Removed", password: "x", grade: 2025 },
    { username: "missing", nickname: "Missing", password: "x", grade: null },
  ]);
  await db.insert(courses).values({
    name: "Test",
    teacher: "Teacher",
    totalSeats: 3,
    availableSeats: 0,
    openTime: "2026-09-05T00:00:00",
  });
  await db.insert(selections).values([
    { userId: 1, courseId: 1, createdAt: "2026-09-05T00:00:00" },
    { userId: 2, courseId: 1, createdAt: "2026-09-05T00:00:00" },
    { userId: 3, courseId: 1, createdAt: "2026-09-05T00:00:00" },
  ]);
}

describe("course grade reconciliation", () => {
  it("removes every selected student outside the new grade restriction", async () => {
    await createFixture();
    const result = await db.transaction(async (tx) => removeIneligibleSelections(tx, 1, "2026"));
    const remaining = await db.select().from(selections).where(eq(selections.courseId, 1));

    assert.deepEqual(result, { removedCount: 2, selectedCount: 1 });
    assert.deepEqual(remaining.map((selection) => selection.userId), [1]);
  });

  it("keeps graded students when unrestricted and removes accounts without a grade", async () => {
    await createFixture();
    const result = await db.transaction(async (tx) => removeIneligibleSelections(tx, 1, null));
    const remaining = await db.select().from(selections).where(eq(selections.courseId, 1));

    assert.deepEqual(result, { removedCount: 1, selectedCount: 2 });
    assert.deepEqual(remaining.map((selection) => selection.userId), [1, 2]);
  });
});
