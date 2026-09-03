import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { execSync } from "node:child_process";
import type { Server } from "node:http";
import bcryptjs from "bcryptjs";
import { Pool } from "pg";
import Redis from "ioredis";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { seed } from "../src/db/seed";
import { closeQueue } from "../src/lib/queue";
import { selectionWorker } from "../src/workers/selection";

const originalDirectory = process.cwd();
const databaseUrl = process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/elective_test";
const redisUrl = process.env.REDIS_URL || "redis://localhost:6379/1";

let baseUrl = "";
let server: Server | undefined;
let pool: Pool | undefined;
let rawDb: ReturnType<typeof drizzle> | undefined;
let redis: Redis | undefined;

before(async () => {
  process.env.DATABASE_URL = databaseUrl;
  process.env.REDIS_URL = redisUrl;

  pool = new Pool({ connectionString: databaseUrl });
  rawDb = drizzle(pool, { schema });

  // Recreate schema
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
  execSync("npx drizzle-kit push", {
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "ignore",
  });

  redis = new Redis(redisUrl);
  await redis.flushdb();

  await seed(rawDb);

  const [{ createApp }] = await Promise.all([
    import("../src/app"),
  ]);

  const app = createApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const address = server!.address();
  assert.ok(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server!.close((error) => error ? reject(error) : resolve());
    });
  }
  await selectionWorker.close();
  await closeQueue();
  await redis?.quit();
  await pool?.end();
  process.chdir(originalDirectory);
});

describe("grade and selection routes", () => {
  it("returns only courses allowed for the logged-in student's grade", async () => {
    const student = await login("student", "123");
    const response = await fetch(`${baseUrl}/courses`, { headers: { cookie: student.cookie } });
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /Allowed course/);
    assert.doesNotMatch(html, /Restricted course/);
    assert.match(html, /Student Nickname/);
    assert.match(html, /id="course-selection-state" data-max-selections="3"/);
  });

  it("uses the earliest matching priority batch", async () => {
    const student = await login("student", "123");
    const response = await fetch(`${baseUrl}/courses`, { headers: { cookie: student.cookie } });
    const html = await response.text();

    assert.match(html, /data-opentime="2090-01-01T00:00:00"/);
    assert.doesNotMatch(html, /data-opentime="2099-01-01T00:00:00"/);
  });

  it("rejects an administrator assigning an ineligible student", async () => {
    await rawDb!.insert(schema.selections).values({ userId: 2, courseId: 1, createdAt: "2026-08-27T00:00:00" });
    await rawDb!.update(schema.courses).set({ availableSeats: 9 }).where(eq(schema.courses.id, 1));

    const admin = await login("admin", "123");
    const response = await fetch(`${baseUrl}/api/admin/class/courses/2/students`, {
      method: "PUT",
      headers: {
        cookie: admin.cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ _csrf: admin.csrf, user_ids: "2" }),
    });

    assert.equal(response.status, 400);
    assert.match(await response.text(), /不允许年级/);
    const countResult = await pool!.query("SELECT count(*) FROM selections WHERE user_id = 2 AND course_id = 2");
    assert.equal(Number(countResult.rows[0].count), 0);
  });

  it("renders second-precision selection window inputs without a minimum date", async () => {
    const admin = await login("admin", "123");
    const response = await fetch(`${baseUrl}/admin/courses`, {
      headers: { cookie: admin.cookie },
    });
    const html = await response.text();
    const startInput = html.match(/<input type="datetime-local" name="startTime"[\s\S]*?\/>/)?.[0] || "";
    const deadlineInput = html.match(/<input type="datetime-local" name="endTime"[\s\S]*?\/>/)?.[0] || "";

    assert.equal(response.status, 200);
    assert.match(html, /action="\/api\/admin\/selection-window\?_method=PUT"/);
    assert.match(startInput, /step="1"/);
    assert.match(startInput, /value="2000-01-01T00:00:00"/);
    assert.match(deadlineInput, /name="endTime"/);
    assert.match(deadlineInput, /step="1"/);
    assert.match(deadlineInput, /value="2999-12-31T23:59:59"/);
    assert.doesNotMatch(deadlineInput, /\smin=/);
  });

  it("stores an exact same-second selection window", async () => {
    const admin = await login("admin", "123");
    const response = await fetch(`${baseUrl}/api/admin/selection-window`, {
      method: "PUT",
      redirect: "manual",
      headers: {
        cookie: admin.cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        _csrf: admin.csrf,
        startTime: "2026-08-31T12:34:56",
        endTime: "2026-08-31T12:34:56",
      }),
    });

    assert.equal(response.status, 302);
    const startResult = await pool!.query("SELECT value FROM config WHERE key = 'start_time'");
    const endResult = await pool!.query("SELECT value FROM config WHERE key = 'end_time'");
    assert.equal(startResult.rows[0].value, "2026-08-31T12:34:56");
    assert.equal(endResult.rows[0].value, "2026-08-31T12:34:56");
  });

  it("rejects a global start time after the deadline on the same day", async () => {
    const admin = await login("admin", "123");
    const response = await fetch(`${baseUrl}/api/admin/selection-window`, {
      method: "PUT",
      headers: {
        cookie: admin.cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        _csrf: admin.csrf,
        startTime: "2026-09-01T08:00:01",
        endTime: "2026-09-01T08:00:00",
      }),
    });

    assert.equal(response.status, 400);
    assert.match(await response.text(), /开始时间不得晚于截止时间/);
  });

  it("rejects date-only values instead of silently adding day boundaries", async () => {
    const admin = await login("admin", "123");
    const response = await fetch(`${baseUrl}/api/admin/selection-window`, {
      method: "PUT",
      headers: {
        cookie: admin.cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        _csrf: admin.csrf,
        startTime: "2026-09-01",
        endTime: "2026-09-01",
      }),
    });

    assert.equal(response.status, 400);
    assert.match(await response.text(), /时间格式不正确/);
  });

  it("removes selections that become ineligible after a student grade change", async () => {
    await pool!.query("INSERT INTO selections (user_id, course_id, created_at) VALUES ($1, $2, $3)", [2, 1, "2026-08-27T00:00:00"]);
    await pool!.query("UPDATE courses SET available_seats = 9 WHERE id = 1");

    const admin = await login("admin", "123");
    const response = await fetch(`${baseUrl}/api/admin/users/2`, {
      method: "PUT",
      redirect: "manual",
      headers: {
        cookie: admin.cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        _csrf: admin.csrf,
        username: "student",
        nickname: "Student Nickname",
        password: "",
        isAdmin: "0",
        grade: "2025",
      }),
    });

    assert.equal(response.status, 302);
    const gradeResult = await pool!.query("SELECT grade FROM users WHERE id = 2");
    assert.equal(gradeResult.rows[0].grade, 2025);
    const selectionCount = await pool!.query("SELECT count(*) FROM selections WHERE user_id = 2");
    assert.equal(Number(selectionCount.rows[0].count), 0);
    const seatResult = await pool!.query("SELECT available_seats FROM courses WHERE id = 1");
    assert.equal(seatResult.rows[0].available_seats, 10);
  });

  it("creates accounts with duplicate nicknames but unique usernames and required grades", async () => {
    const admin = await login("admin", "123");
    for (const username of ["student-a", "student-b"]) {
      const response = await fetch(`${baseUrl}/api/admin/users`, {
        method: "POST",
        redirect: "manual",
        headers: {
          cookie: admin.cookie,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          _csrf: admin.csrf,
          username,
          nickname: "同名学生",
          password: "123",
          isAdmin: "0",
          grade: "2026",
        }),
      });
      assert.equal(response.status, 302);
    }

    const result = await pool!.query("SELECT username, nickname, grade FROM users WHERE username LIKE 'student-%' ORDER BY username");
    assert.deepEqual(
      result.rows,
      [
        { username: "student-a", nickname: "同名学生", grade: 2026 },
        { username: "student-b", nickname: "同名学生", grade: 2026 },
      ],
    );
  });

  it("forces a student without a phone to complete the profile before accessing the system", async () => {
    const originalResult = await pool!.query("SELECT nickname, password, grade, class_name, phone FROM users WHERE id = 2");
    const original = originalResult.rows[0] as {
      nickname: string;
      password: string;
      grade: number;
      class_name: string | null;
      phone: string | null;
    };
    await pool!.query("UPDATE users SET phone = NULL, class_name = NULL WHERE id = 2");
    await pool!.query("INSERT INTO config (key, value) VALUES ('student_notice', $1) ON CONFLICT(key) DO UPDATE SET value = excluded.value", ["请查看 https://example.com/notice。<script>alert('xss')</script>"]);

    try {
      const student = await login("student", "123");
      assert.equal(student.redirect, "/profile");

      const blockedPage = await fetch(`${baseUrl}/courses`, {
        redirect: "manual",
        headers: { cookie: student.cookie },
      });
      assert.equal(blockedPage.status, 302);
      assert.equal(blockedPage.headers.get("location"), "/profile");

      const profilePage = await fetch(`${baseUrl}/profile`, { headers: { cookie: student.cookie } });
      const profileHtml = await profilePage.text();
      assert.equal(profilePage.status, 200);
      assert.match(profileHtml, /必须填写后访问/);
      assert.match(profileHtml, /pattern="1\[3-9\]\[0-9\]\{9\}"/);
      assert.match(profileHtml, /name="nickname" value="Student Nickname"/);
      assert.match(profileHtml, /name="className"[\s\S]*?pattern="\[0-9\]\+"[\s\S]*?inputmode="numeric"/);
      assert.match(
        profileHtml,
        /type="text"[^>]*name="grade"[^>]*pattern="\[0-9\]\{4\}"[^>]*inputmode="numeric"[^>]*maxlength="4"/,
      );
      assert.doesNotMatch(profileHtml, /高三（1）班/);
      assert.doesNotMatch(profileHtml, /id="student-notice"/);

      const blockedSelection = await fetch(`${baseUrl}/api/courses/1/select`, {
        method: "POST",
        redirect: "manual",
        headers: {
          cookie: student.cookie,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ _csrf: student.csrf }),
      });
      assert.equal(blockedSelection.status, 302);
      assert.equal(blockedSelection.headers.get("location"), "/profile");

      const invalid = await fetch(`${baseUrl}/api/profile`, {
        method: "POST",
        headers: {
          cookie: student.cookie,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          _csrf: student.csrf,
          nickname: "Student Nickname",
          phone: "123",
          className: "1",
          grade: "2026",
          password: "",
        }),
      });
      assert.equal(invalid.status, 400);
      assert.match(await invalid.text(), /手机号格式不正确/);

      const invalidClass = await fetch(`${baseUrl}/api/profile`, {
        method: "POST",
        headers: {
          cookie: student.cookie,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          _csrf: student.csrf,
          nickname: "Student Nickname",
          phone: "13800138000",
          className: "高三1班",
          grade: "2026",
          password: "",
        }),
      });
      assert.equal(invalidClass.status, 400);
      assert.match(await invalidClass.text(), /班级必须是数字/);

      const saved = await fetch(`${baseUrl}/api/profile`, {
        method: "POST",
        redirect: "manual",
        headers: {
          cookie: student.cookie,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          _csrf: student.csrf,
          nickname: "Updated Student",
          phone: "13800138000",
          className: "2",
          grade: "2027",
          password: "new-password",
        }),
      });
      assert.equal(saved.status, 302);
      assert.equal(saved.headers.get("location"), "/courses");

      const updatedResult = await pool!.query("SELECT nickname, password, grade, class_name, phone FROM users WHERE id = 2");
      const updated = updatedResult.rows[0] as {
        nickname: string;
        password: string;
        grade: number;
        class_name: string;
        phone: string;
      };
      assert.equal(updated.nickname, "Updated Student");
      assert.equal(updated.grade, 2027);
      assert.equal(updated.class_name, "2");
      assert.equal(updated.phone, "13800138000");
      assert.equal(bcryptjs.compareSync("new-password", updated.password), true);
      assert.equal(bcryptjs.compareSync("123", updated.password), false);

      const restoredAccess = await fetch(`${baseUrl}/courses`, { headers: { cookie: student.cookie } });
      const restoredHtml = await restoredAccess.text();
      assert.equal(restoredAccess.status, 200);
      assert.match(restoredHtml, /id="student-notice"/);
      const noticeTag = restoredHtml.match(/<div id="student-notice"[^>]*>/)?.[0] || "";
      assert.match(noticeTag, /class="[^"]*\bfixed\b/);
      assert.match(noticeTag, /\bleft-1\/2\b/);
      assert.match(noticeTag, /\btop-\[4\.5rem\]/);
      assert.doesNotMatch(noticeTag, /\bsticky\b/);
      assert.match(restoredHtml, /href="https:\/\/example\.com\/notice"/);
      assert.match(restoredHtml, /&lt;script&gt;alert\(&#39;xss&#39;\)&lt;\/script&gt;/);
      assert.doesNotMatch(restoredHtml, /href="https:\/\/example\.com\/notice。/);
    } finally {
      await pool!.query("UPDATE users SET nickname = $1, password = $2, grade = $3, class_name = $4, phone = $5 WHERE id = 2", [original.nickname, original.password, original.grade, original.class_name, original.phone]);
      await pool!.query("DELETE FROM config WHERE key = 'student_notice'");
    }
  });

  it("lets administrators edit student phone and class and rejects invalid phones", async () => {
    const admin = await login("admin", "123");
    const usersPage = await fetch(`${baseUrl}/admin/users`, { headers: { cookie: admin.cookie } });
    const usersHtml = await usersPage.text();
    assert.match(
      usersHtml,
      /name="phone"[\s\S]*?pattern="1\[3-9\]\[0-9\]\{9\}"[\s\S]*?inputmode="numeric"[\s\S]*?maxlength="11"/,
    );
    assert.doesNotMatch(usersHtml, /(?:pattern|inputmode|maxlength)=&#34;/);
    assert.match(usersHtml, /name="className"[\s\S]*?pattern="\[0-9\]\+"[\s\S]*?inputmode="numeric"/);
    const gradeFields = usersHtml.match(/<input[^>]*name="grade"[^>]*>/g) || [];
    assert.ok(gradeFields.length >= 2);
    for (const gradeField of gradeFields) {
      assert.match(gradeField, /type="text"/);
      assert.match(gradeField, /pattern="\[0-9\]\{4\}"/);
      assert.match(gradeField, /inputmode="numeric"/);
      assert.match(gradeField, /maxlength="4"/);
    }
    const adminRow = usersHtml.match(/id="user-row-1"([\s\S]*?)id="edit-user-1"/)?.[1] || "";
    assert.match(adminRow, /lg:grid-cols-8/);
    assert.doesNotMatch(adminRow, /md:(?:block|hidden|justify-center|pt-0)/);

    const invalidClass = await fetch(`${baseUrl}/api/admin/users/2`, {
      method: "PUT",
      headers: {
        cookie: admin.cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        _csrf: admin.csrf,
        username: "student",
        nickname: "Student Nickname",
        isAdmin: "0",
        grade: "2026",
        className: "高三1班",
        phone: "13900139000",
      }),
    });
    assert.equal(invalidClass.status, 400);
    assert.match(await invalidClass.text(), /班级必须是数字/);

    const invalid = await fetch(`${baseUrl}/api/admin/users/2`, {
      method: "PUT",
      headers: {
        cookie: admin.cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        _csrf: admin.csrf,
        username: "student",
        nickname: "Student Nickname",
        isAdmin: "0",
        grade: "2026",
        className: "2",
        phone: "123",
      }),
    });
    assert.equal(invalid.status, 400);
    assert.match(await invalid.text(), /手机号格式不正确/);

    const saved = await fetch(`${baseUrl}/api/admin/users/2`, {
      method: "PUT",
      redirect: "manual",
      headers: {
        cookie: admin.cookie,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        _csrf: admin.csrf,
        username: "student",
        nickname: "Student Nickname",
        isAdmin: "0",
        grade: "2026",
        className: "2",
        phone: "13900139000",
      }),
    });
    assert.equal(saved.status, 302);
    const result = await pool!.query("SELECT class_name, phone FROM users WHERE id = 2");
    assert.deepEqual(
      result.rows[0],
      { class_name: "2", phone: "13900139000" },
    );

    for (const path of ["/admin/access", "/admin/class"]) {
      const page = await fetch(`${baseUrl}${path}`, { headers: { cookie: admin.cookie } });
      const html = await page.text();
      assert.equal(page.status, 200);
      assert.match(html, /(?:>2<|"className":"2")/);
      assert.match(html, /13900139000/);
    }
  });

  it("finds every student sharing an exact nickname and shows profile fields", async () => {
    const password = bcryptjs.hashSync("123", 4);
    await pool!.query("INSERT INTO users (username, nickname, password, is_admin, grade, class_name, phone) VALUES ($1, $2, $3, 0, $4, $5, $6)", ["same-nick-a", "同名<&查询", password, 2026, "1", "13700137000"]);
    await pool!.query("INSERT INTO users (username, nickname, password, is_admin, grade, class_name, phone) VALUES ($1, $2, $3, 0, $4, $5, $6)", ["same-nick-b", "同名<&查询", password, 2027, "2", "13600136000"]);

    const admin = await login("admin", "123");
    const response = await fetch(`${baseUrl}/api/admin/users/search?keyword=${encodeURIComponent("同名<&查询")}`, {
      headers: { cookie: admin.cookie },
    });
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /same-nick-a/);
    assert.match(html, /same-nick-b/);
    assert.match(html, /同名&lt;&amp;查询/);
    assert.match(html, />1</);
    assert.match(html, /13700137000/);
  });

  it("limits course description previews to 100 characters on student and admin cards", async () => {
    const description = "A".repeat(100) + "TAIL";
    await pool!.query("UPDATE courses SET description = $1 WHERE id = 1", [description]);

    const student = await login("student", "123");
    const studentPage = await fetch(`${baseUrl}/courses`, { headers: { cookie: student.cookie } });
    const studentPreview = extractDescriptionPreview(await studentPage.text());
    assert.equal(studentPreview, "A".repeat(100));

    const admin = await login("admin", "123");
    const adminPage = await fetch(`${baseUrl}/admin/courses`, { headers: { cookie: admin.cookie } });
    const adminPreview = extractDescriptionPreview(await adminPage.text());
    assert.equal(adminPreview, "A".repeat(100));
  });

  it("lets administrators configure or clear the student notice", async () => {
    const admin = await login("admin", "123");
    const adminPage = await fetch(`${baseUrl}/admin/courses`, { headers: { cookie: admin.cookie } });
    const adminHtml = await adminPage.text();
    assert.match(adminHtml, /name="key" value="student_notice"/);
    assert.match(adminHtml, /<textarea name="value" maxlength="2000"/);

    try {
      const saved = await fetch(`${baseUrl}/api/admin/config`, {
        method: "PUT",
        redirect: "manual",
        headers: {
          cookie: admin.cookie,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          _csrf: admin.csrf,
          key: "student_notice",
          value: "  新通知 https://example.com/help  ",
        }),
      });
      assert.equal(saved.status, 302);
      const noticeResult = await pool!.query("SELECT value FROM config WHERE key = 'student_notice'");
      assert.equal(noticeResult.rows[0].value, "新通知 https://example.com/help");

      const student = await login("student", "123");
      const courses = await fetch(`${baseUrl}/courses`, { headers: { cookie: student.cookie } });
      const coursesHtml = await courses.text();
      assert.match(coursesHtml, /id="student-notice"/);
      assert.match(coursesHtml, /href="https:\/\/example\.com\/help"/);

      const cleared = await fetch(`${baseUrl}/api/admin/config`, {
        method: "PUT",
        redirect: "manual",
        headers: {
          cookie: admin.cookie,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          _csrf: admin.csrf,
          key: "student_notice",
          value: "",
        }),
      });
      assert.equal(cleared.status, 302);
      const clearedResult = await pool!.query("SELECT value FROM config WHERE key = 'student_notice'");
      assert.equal(clearedResult.rows[0].value, "");
    } finally {
      await pool!.query("DELETE FROM config WHERE key = 'student_notice'");
    }
  });

  it("lets administrators configure plain course instructions for the student course page", async () => {
    const admin = await login("admin", "123");
    const adminPage = await fetch(`${baseUrl}/admin/courses`, { headers: { cookie: admin.cookie } });
    const adminHtml = await adminPage.text();
    assert.match(adminHtml, /name="key" value="course_instructions"/);
    assert.match(adminHtml, /保存课程说明/);

    try {
      const saved = await fetch(`${baseUrl}/api/admin/config`, {
        method: "PUT",
        redirect: "manual",
        headers: {
          cookie: admin.cookie,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          _csrf: admin.csrf,
          key: "course_instructions",
          value: "  第一行\n<script>第二行</script>  ",
        }),
      });
      assert.equal(saved.status, 302);
      const instructionsResult = await pool!.query("SELECT value FROM config WHERE key = 'course_instructions'");
      assert.equal(instructionsResult.rows[0].value, "第一行\n<script>第二行</script>");

      const student = await login("student", "123");
      const courses = await fetch(`${baseUrl}/courses`, { headers: { cookie: student.cookie } });
      const coursesHtml = await courses.text();
      const instructionsIndex = coursesHtml.indexOf('id="course-instructions"');
      const headingIndex = coursesHtml.indexOf(">课程列表</h2>", instructionsIndex);
      assert.ok(instructionsIndex >= 0 && instructionsIndex < headingIndex);
      assert.match(coursesHtml, /第一行\s*&lt;script&gt;第二行&lt;\/script&gt;/);
      assert.doesNotMatch(coursesHtml, /<script>第二行<\/script>/);
    } finally {
      await pool!.query("DELETE FROM config WHERE key = 'course_instructions'");
    }
  });
});

async function login(username: string, password: string): Promise<{ cookie: string; csrf: string; redirect: string | null }> {
  const page = await fetch(`${baseUrl}/login`);
  const initialCookie = cookieValue(page.headers.get("set-cookie"));
  const csrf = extractCsrf(await page.text());
  const response = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    redirect: "manual",
    headers: {
      cookie: initialCookie,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ _csrf: csrf, username, password }),
  });
  assert.equal(response.status, 302);
  const authenticatedCookie = cookieValue(response.headers.get("set-cookie")) || initialCookie;
  const authenticatedPage = await fetch(`${baseUrl}/`, {
    headers: { cookie: authenticatedCookie },
  });
  return {
    cookie: authenticatedCookie,
    csrf: extractCsrf(await authenticatedPage.text()),
    redirect: response.headers.get("location"),
  };
}

function extractDescriptionPreview(html: string): string {
  const match = html.match(/class="course-description-preview[^"]*">([^<]*)<\/[^>]+>/);
  assert.ok(match);
  return match[1];
}

function cookieValue(header: string | null): string {
  return header?.split(";", 1)[0] || "";
}

function extractCsrf(html: string): string {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  assert.ok(match);
  return match[1];
}
