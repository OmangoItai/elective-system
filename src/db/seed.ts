import bcryptjs from "bcryptjs";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";
import { users, courses, access, accessUsers, config } from "./schema";

export async function seed(d: ReturnType<typeof drizzle>) {
  const existingUser = await d.select({ id: users.id }).from(users).limit(1);
  if (existingUser.length > 0) {
    console.log("Seed skipped: existing data preserved");
    return;
  }

  await d.delete(accessUsers);
  await d.delete(access);
  await d.delete(schema.selections);
  await d.delete(courses);
  await d.delete(users);
  await d.delete(config);

  const adminHash = bcryptjs.hashSync("123", 10);
  const studentHash = bcryptjs.hashSync("123", 10);

  await d.insert(users).values([
    { username: "admin", nickname: "管理员", password: adminHash, isAdmin: 1 },
    { username: "student", nickname: "示例学生", password: studentHash, isAdmin: 0, grade: 2024 },
  ]);

  await d.insert(courses).values([
    {
      name: "Python入门",
      teacher: "张老师",
      description: "零基础Python教学",
      courseTime: "周二第3-5节",
      location: "教学楼A-301",
      totalSeats: 60,
      availableSeats: 60,
      openTime: "2026-08-01T00:00:00",
      allowedGrades: "2024,2025,2026",
    },
    {
      name: "Go语言",
      teacher: "李老师",
      description: "Go并发编程实践",
      courseTime: "周三第6-8节",
      location: "教学楼B-205",
      totalSeats: 40,
      availableSeats: 40,
      openTime: "2026-08-30T00:00:00",
      allowedGrades: "2025,2026",
    },
  ]);

  await d.insert(access).values({
    courseId: 1,
    openTime: "2026-08-09T00:00:00",
  });

  await d.insert(accessUsers).values([
    { accessId: 1, userId: 2 },
  ]);

  await d.insert(config).values([
    { key: "end_time", value: "2026-09-30T23:59:59" },
    { key: "start_time", value: "2026-09-05T00:00:00" },
    { key: "site_title", value: "选课系统" },
    { key: "max_selections", value: "1" },
  ]);

  console.log("Seed done");
}

async function main() {
  const connectionString = process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/elective";
  const pool = new Pool({ connectionString });
  const d = drizzle(pool, { schema });
  try {
    await seed(d);
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
