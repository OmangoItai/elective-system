import { Router, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { db } from "../db/index";
import { requireAdmin } from "../middleware/auth";
import { nowLocal } from "../utils/time";
import { csvDocument, CSV_BOM } from "../utils/export-csv";
import { buildZip } from "../utils/zip-store";

const router = Router();

/** China-local date as YYYYMMDD for export file names. */
function exportDateStamp(): string {
  return nowLocal().slice(0, 10).replace(/-/g, "");
}

function sendBuffer(res: Response, name: string, data: Buffer, contentType: string) {
  res.setHeader("Content-Type", contentType);
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="export"; filename*=UTF-8''${encodeURIComponent(name)}`,
  );
  res.send(data);
}

interface RosterStudent {
  nickname: string;
  grade: number | null;
  className: string | null;
  phone: string | null;
  username: string;
}

const STUDENT_FIELDS = ["学生姓名", "年级", "班级", "联系方式", "账号"];

function studentsWithClassRows(students: RosterStudent[]): unknown[][] {
  return [
    STUDENT_FIELDS,
    ...students.map((s) => [s.nickname, s.grade, s.className, s.phone, s.username]),
  ];
}

// 行政班级：每个年级每个班一个 CSV，打进一个压缩包
router.get("/api/admin/export/class-rosters", requireAdmin, (_req: Request, res: Response) => {
  const classes = db.all(
    sql`SELECT DISTINCT grade, class_name FROM users
        WHERE is_admin = 0 AND grade IS NOT NULL AND class_name IS NOT NULL AND class_name != ''
        ORDER BY grade, class_name`,
  ) as { grade: number; class_name: string }[];

  const stamp = exportDateStamp();
  const entries = classes.map((cls) => {
    const students = db.all(
      sql`SELECT nickname, grade, class_name AS className, phone, username FROM users
          WHERE is_admin = 0 AND grade = ${cls.grade} AND class_name = ${cls.class_name}
          ORDER BY id`,
    ) as RosterStudent[];
    const csv = csvDocument([
      [`${cls.grade}年级${cls.class_name}班`, stamp],
      ["学生姓名", "联系方式", "账号"],
      ...students.map((s) => [s.nickname, s.phone, s.username]),
    ]);
    return {
      name: `${cls.grade}年级${cls.class_name}班选课表-${stamp}.csv`,
      data: Buffer.from(CSV_BOM + csv, "utf8"),
    };
  });

  sendBuffer(res, `行政班级选课表-${stamp}.zip`, buildZip(entries), "application/zip");
});

// 社团班级：每门课程一个 CSV，打进一个压缩包
router.get("/api/admin/export/course-rosters", requireAdmin, (_req: Request, res: Response) => {
  const courses = db.all(sql`SELECT * FROM courses ORDER BY id`) as {
    id: number;
    name: string;
    teacher: string;
    course_time: string | null;
    location: string | null;
    total_seats: number;
    tag: string | null;
  }[];

  const stamp = exportDateStamp();
  const usedNames = new Set<string>();
  const entries = courses.map((course) => {
    const students = db.all(
      sql`SELECT u.nickname, u.grade, u.class_name AS className, u.phone, u.username FROM selections s
          JOIN users u ON u.id = s.user_id
          WHERE s.course_id = ${course.id}
          ORDER BY u.id`,
    ) as RosterStudent[];
    const csv = csvDocument([
      [course.name, course.teacher, course.course_time, course.location, course.total_seats, course.tag, stamp],
      ...studentsWithClassRows(students),
    ]);
    // Same-name courses would collide inside the zip — disambiguate by id.
    let base = `${course.name}选课表-${stamp}.csv`;
    if (usedNames.has(base)) {
      base = `${course.name}(ID${course.id})选课表-${stamp}.csv`;
    }
    usedNames.add(base);
    return { name: base, data: Buffer.from(CSV_BOM + csv, "utf8") };
  });

  sendBuffer(res, `社团班级选课表-${stamp}.zip`, buildZip(entries), "application/zip");
});

// 未选课学生：选了 0 门课的学生，单 CSV 直下载
router.get("/api/admin/export/unselected", requireAdmin, (_req: Request, res: Response) => {
  const students = db.all(
    sql`SELECT u.nickname, u.grade, u.class_name AS className, u.phone, u.username FROM users u
        WHERE u.is_admin = 0 AND NOT EXISTS (SELECT 1 FROM selections s WHERE s.user_id = u.id)
        ORDER BY u.id`,
  ) as RosterStudent[];

  const stamp = exportDateStamp();
  const csv = csvDocument([[stamp], ...studentsWithClassRows(students)]);
  sendBuffer(
    res,
    `未选课学生表-${stamp}.csv`,
    Buffer.from(CSV_BOM + csv, "utf8"),
    "text/csv; charset=utf-8",
  );
});

export default router;
