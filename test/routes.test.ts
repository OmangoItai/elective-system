import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import bcryptjs from "bcryptjs";
import Database from "better-sqlite3";

const originalDirectory = process.cwd();
const fixtureDirectory = mkdtempSync(join(tmpdir(), "elective-routes-"));
let baseUrl = "";
let server: Server | undefined;
let sessionDb: Database.Database | undefined;
let rawDb: Database.Database | undefined;

before(async () => {
  process.chdir(fixtureDirectory);
  mkdirSync("data");
  createSchema();

  const [{ createApp }, database] = await Promise.all([
    import("../src/app"),
    import("../src/db/index"),
  ]);
  rawDb = database.rawDb;
  seedFixture(rawDb);

  const app = createApp();
  sessionDb = app.locals.sessionDb;
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server!.close((error) => error ? reject(error) : resolve());
    });
  }
  sessionDb?.close();
  rawDb?.close();
  process.chdir(originalDirectory);
  rmSync(fixtureDirectory, { recursive: true, force: true });
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

  it("lets a priority batch open earlier than the global start", async () => {
    rawDb!.prepare("UPDATE config SET value = ? WHERE key = 'start_time'").run("2095-01-01T00:00:00");
    try {
      const student = await login("student", "123");
      const response = await fetch(`${baseUrl}/courses`, { headers: { cookie: student.cookie } });
      const html = await response.text();

      assert.match(html, /data-opentime="2090-01-01T00:00:00"/);
      assert.doesNotMatch(html, /data-opentime="2099-01-01T00:00:00"/);
    } finally {
      rawDb!.prepare("UPDATE config SET value = ? WHERE key = 'start_time'").run("2000-01-01T00:00:00");
    }
  });

  it("hides seat counts for courses that have not opened", async () => {
    rawDb!.prepare("UPDATE config SET value = ? WHERE key = 'start_time'").run("2100-01-01T00:00:00");
    try {
      const student = await login("student", "123");
      const html = await (await fetch(`${baseUrl}/courses`, { headers: { cookie: student.cookie } })).text();

      assert.match(html, /等待开放/);
      assert.doesNotMatch(html, /名额/);
      assert.doesNotMatch(html, />10\s*\/\s*10</);
    } finally {
      rawDb!.prepare("UPDATE config SET value = ? WHERE key = 'start_time'").run("2000-01-01T00:00:00");
    }
  });

  it("never opens later than the global start, even with a later batch", async () => {
    rawDb!.prepare("UPDATE config SET value = ? WHERE key = 'start_time'").run("2085-01-01T00:00:00");
    try {
      const student = await login("student", "123");
      const html = await (await fetch(`${baseUrl}/courses`, { headers: { cookie: student.cookie } })).text();

      assert.match(html, /data-opentime="2085-01-01T00:00:00"/);
    } finally {
      rawDb!.prepare("UPDATE config SET value = ? WHERE key = 'start_time'").run("2000-01-01T00:00:00");
    }
  });

  it("rejects selecting before the effective open time", async () => {
    rawDb!.prepare("UPDATE config SET value = ? WHERE key = 'start_time'").run("2095-01-01T00:00:00");
    try {
      const student = await login("student", "123");
      const response = await fetch(`${baseUrl}/api/courses/1/select`, {
        method: "POST",
        headers: {
          cookie: student.cookie,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ _csrf: student.csrf }),
      });

      assert.equal(response.status, 400);
      assert.match(await response.text(), /尚未到开放时间/);
    } finally {
      rawDb!.prepare("UPDATE config SET value = ? WHERE key = 'start_time'").run("2000-01-01T00:00:00");
    }
  });

  it("rejects an administrator assigning an ineligible student", async () => {
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
    assert.equal(rawDb!.prepare("SELECT count(*) FROM selections WHERE user_id = 2 AND course_id = 2").pluck().get(), 0);
  });

  it("returns every course sharing the searched name in the class search", async () => {
    rawDb!.prepare("INSERT INTO courses (name, teacher, total_seats, available_seats, allowed_grades) VALUES (?, ?, ?, ?, ?)")
      .run("Allowed course", "Other Teacher", 5, 5, "2026");

    const admin = await login("admin", "123");
    const response = await fetch(
      `${baseUrl}/api/admin/class/courses/search?name=${encodeURIComponent("Allowed course")}`,
      { headers: { cookie: admin.cookie } },
    );
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /id="class-result-1"/);
    assert.match(html, /id="class-result-3"/);
    assert.match(html, /Other Teacher/);
  });

  it("reports when no course matches the class search", async () => {
    const admin = await login("admin", "123");
    const response = await fetch(
      `${baseUrl}/api/admin/class/courses/search?name=${encodeURIComponent("不存在的课")}`,
      { headers: { cookie: admin.cookie } },
    );

    assert.match(await response.text(), /未找到课程/);
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
    assert.equal(rawDb!.prepare("SELECT value FROM config WHERE key = 'start_time'").pluck().get(), "2026-08-31T12:34:56");
    assert.equal(rawDb!.prepare("SELECT value FROM config WHERE key = 'end_time'").pluck().get(), "2026-08-31T12:34:56");
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
    rawDb!.prepare("INSERT INTO selections (user_id, course_id, created_at) VALUES (?, ?, ?)")
      .run(2, 1, "2026-08-27T00:00:00");
    rawDb!.prepare("UPDATE courses SET available_seats = 9 WHERE id = 1").run();

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
    assert.equal(rawDb!.prepare("SELECT grade FROM users WHERE id = 2").pluck().get(), 2025);
    assert.equal(rawDb!.prepare("SELECT count(*) FROM selections WHERE user_id = 2").pluck().get(), 0);
    assert.equal(rawDb!.prepare("SELECT available_seats FROM courses WHERE id = 1").pluck().get(), 10);
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

    assert.deepEqual(
      rawDb!.prepare("SELECT username, nickname, grade FROM users WHERE username LIKE 'student-%' ORDER BY username").all(),
      [
        { username: "student-a", nickname: "同名学生", grade: 2026 },
        { username: "student-b", nickname: "同名学生", grade: 2026 },
      ],
    );
  });

  it("forces a student without a phone to complete the profile before accessing the system", async () => {
    const original = rawDb!.prepare("SELECT nickname, password, grade, class_name, phone FROM users WHERE id = 2").get() as {
      nickname: string;
      password: string;
      grade: number;
      class_name: string | null;
      phone: string | null;
    };
    rawDb!.prepare("UPDATE users SET phone = NULL, class_name = NULL WHERE id = 2").run();
    rawDb!.prepare("INSERT INTO config (key, value) VALUES ('student_notice', ?)")
      .run("请查看 https://example.com/notice。<script>alert('xss')</script>");

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

      const updated = rawDb!.prepare("SELECT nickname, password, grade, class_name, phone FROM users WHERE id = 2").get() as {
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
      rawDb!.prepare("UPDATE users SET nickname = ?, password = ?, grade = ?, class_name = ?, phone = ? WHERE id = 2")
        .run(original.nickname, original.password, original.grade, original.class_name, original.phone);
      rawDb!.prepare("DELETE FROM config WHERE key = 'student_notice'").run();
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
    assert.deepEqual(
      rawDb!.prepare("SELECT class_name, phone FROM users WHERE id = 2").get(),
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
    rawDb!.prepare("INSERT INTO users (username, nickname, password, is_admin, grade, class_name, phone) VALUES (?, ?, ?, 0, ?, ?, ?)")
      .run("same-nick-a", "同名<&查询", password, 2026, "1", "13700137000");
    rawDb!.prepare("INSERT INTO users (username, nickname, password, is_admin, grade, class_name, phone) VALUES (?, ?, ?, 0, ?, ?, ?)")
      .run("same-nick-b", "同名<&查询", password, 2027, "2", "13600136000");

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
    rawDb!.prepare("UPDATE courses SET description = ? WHERE id = 1").run(description);

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
      assert.equal(rawDb!.prepare("SELECT value FROM config WHERE key = 'student_notice'").pluck().get(), "新通知 https://example.com/help");

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
      assert.equal(rawDb!.prepare("SELECT value FROM config WHERE key = 'student_notice'").pluck().get(), "");
    } finally {
      rawDb!.prepare("DELETE FROM config WHERE key = 'student_notice'").run();
    }
  });

  it("lets administrators configure plain course instructions for the student course page", async () => {
    const admin = await login("admin", "123");
    const adminPage = await fetch(`${baseUrl}/admin/courses`, { headers: { cookie: admin.cookie } });
    const adminHtml = await adminPage.text();
    assert.match(adminHtml, /name="key" value="course_instructions"/);
    assert.match(adminHtml, /保存课程须知/);

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
      assert.equal(rawDb!.prepare("SELECT value FROM config WHERE key = 'course_instructions'").pluck().get(), "第一行\n<script>第二行</script>");

      const student = await login("student", "123");
      const courses = await fetch(`${baseUrl}/courses`, { headers: { cookie: student.cookie } });
      const coursesHtml = await courses.text();
      const instructionsIndex = coursesHtml.indexOf('id="course-instructions"');
      const headingIndex = coursesHtml.indexOf(">课程列表</h2>", instructionsIndex);
      assert.ok(instructionsIndex >= 0 && instructionsIndex < headingIndex);
      assert.match(coursesHtml, /第一行\s*&lt;script&gt;第二行&lt;\/script&gt;/);
      assert.doesNotMatch(coursesHtml, /<script>第二行<\/script>/);
    } finally {
      rawDb!.prepare("DELETE FROM config WHERE key = 'course_instructions'").run();
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

function createSchema() {
  const sqlite = new Database("data/db.sqlite");
  sqlite.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      nickname TEXT NOT NULL,
      password TEXT NOT NULL,
      is_admin INTEGER NOT NULL DEFAULT 0,
      grade INTEGER,
      class_name TEXT,
      phone TEXT
    );
    CREATE TABLE courses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      teacher TEXT NOT NULL,
      description TEXT,
      course_time TEXT,
      location TEXT,
      total_seats INTEGER NOT NULL,
      available_seats INTEGER NOT NULL,
      allowed_grades TEXT,
      tag TEXT
    );
    CREATE TABLE access (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course_id INTEGER NOT NULL REFERENCES courses(id),
      open_time TEXT NOT NULL
    );
    CREATE TABLE access_users (
      access_id INTEGER NOT NULL REFERENCES access(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      PRIMARY KEY (access_id, user_id)
    );
    CREATE TABLE selections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      course_id INTEGER NOT NULL REFERENCES courses(id),
      created_at TEXT NOT NULL,
      UNIQUE (user_id, course_id)
    );
    CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  sqlite.close();
}

function seedFixture(sqlite: Database.Database) {
  const password = bcryptjs.hashSync("123", 4);
  sqlite.prepare("INSERT INTO users (username, nickname, password, is_admin, grade, phone) VALUES (?, ?, ?, ?, ?, ?)")
    .run("admin", "Admin Nickname", password, 1, null, null);
  sqlite.prepare("INSERT INTO users (username, nickname, password, is_admin, grade, phone) VALUES (?, ?, ?, ?, ?, ?)")
    .run("student", "Student Nickname", password, 0, 2026, "13800138000");
  sqlite.prepare("INSERT INTO courses (name, teacher, total_seats, available_seats, allowed_grades) VALUES (?, ?, ?, ?, ?)")
    .run("Allowed course", "Teacher", 10, 10, "2026");
  sqlite.prepare("INSERT INTO courses (name, teacher, total_seats, available_seats, allowed_grades) VALUES (?, ?, ?, ?, ?)")
    .run("Restricted course", "Teacher", 10, 10, "2025");
  const later = sqlite.prepare("INSERT INTO access (course_id, open_time) VALUES (?, ?)").run(1, "2099-01-01T00:00:00").lastInsertRowid;
  const earlier = sqlite.prepare("INSERT INTO access (course_id, open_time) VALUES (?, ?)").run(1, "2090-01-01T00:00:00").lastInsertRowid;
  sqlite.prepare("INSERT INTO access_users (access_id, user_id) VALUES (?, ?)").run(later, 2);
  sqlite.prepare("INSERT INTO access_users (access_id, user_id) VALUES (?, ?)").run(earlier, 2);
  const setConfig = sqlite.prepare("INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  setConfig.run("start_time", "2000-01-01T00:00:00");
  setConfig.run("end_time", "2999-12-31T23:59:59");
  setConfig.run("max_selections", "3");
}
