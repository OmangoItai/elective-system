import { Router, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { db } from "../db/index";
import { requireAdmin } from "../middleware/auth";
import { nowLocal } from "../utils/time";
import { csvDocument, CSV_BOM } from "../utils/export-csv";
import { buildXlsx, XLSX_CONTENT_TYPE, XlsxSheet } from "../utils/xlsx";
import { buildZip } from "../utils/zip-store";

const router = Router();

/** China-local date as YYYY年MM月DD日 for export file names and sheet headers. */
function exportDateStamp(): string {
  const date = nowLocal().slice(0, 10);
  const [year, month, day] = date.split("-");
  return `${year}年${month}月${day}日`;
}

function sendBuffer(res: Response, name: string, data: Buffer, contentType: string) {
  res.setHeader("Content-Type", contentType);
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="export"; filename*=UTF-8''${encodeURIComponent(name)}`,
  );
  res.send(data);
}

type ExportFormat = "xlsx" | "csv";

/** Default format is xlsx; only an explicit `format=csv` selects CSV. */
function exportFormat(req: Request): ExportFormat {
  return req.query.format === "csv" ? "csv" : "xlsx";
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

/** Class/course rosters become one XLSX workbook (sheet per class/course). */
function sendSheets(
  res: Response,
  stamp: string,
  kind: "行政班级" | "社团班级",
  sheets: XlsxSheet[],
) {
  sendBuffer(res, `${kind}选课表-${stamp}.xlsx`, buildXlsx(sheets), XLSX_CONTENT_TYPE);
}

function sendCsvZip(res: Response, stamp: string, kind: "行政班级" | "社团班级", entries: { name: string; data: Buffer }[]) {
  sendBuffer(res, `${kind}选课表-${stamp}.zip`, buildZip(entries), "application/zip");
}

// 行政班级：xlsx 为每个年级每个班一个 sheet；csv 为每个班一个 CSV 打压缩包
router.get("/api/admin/export/class-rosters", requireAdmin, (req: Request, res: Response) => {
  const classes = db.all(
    sql`SELECT DISTINCT grade, class_name FROM users
        WHERE is_admin = 0 AND grade IS NOT NULL AND class_name IS NOT NULL AND class_name != ''
        ORDER BY grade, class_name`,
  ) as { grade: number; class_name: string }[];

  const stamp = exportDateStamp();
  const buildRows = (grade: number, className: string) => {
    const rows = db.all(
      sql`SELECT u.nickname, u.phone, u.username, c.name AS courseName, c.teacher AS courseTeacher, c.location AS courseLocation
          FROM users u
          LEFT JOIN selections s ON s.user_id = u.id
          LEFT JOIN courses c ON c.id = s.course_id
          WHERE u.is_admin = 0 AND u.grade = ${grade} AND u.class_name = ${className}
          ORDER BY u.id, c.id`,
    ) as {
      nickname: string;
      phone: string | null;
      username: string;
      courseName: string | null;
      courseTeacher: string | null;
      courseLocation: string | null;
    }[];
    return [
      [`${grade}年级${className}班`, stamp],
      ["学生姓名", "课程名", "课程教师", "课程地点", "联系方式", "账号"],
      ...rows.map((r) => [r.nickname, r.courseName, r.courseTeacher, r.courseLocation, r.phone, r.username]),
    ];
  };

  if (exportFormat(req) === "xlsx") {
    return sendSheets(
      res,
      stamp,
      "行政班级",
      classes.map((cls) => ({
        name: `${cls.grade}年级${cls.class_name}班`,
        rows: buildRows(cls.grade, cls.class_name),
      })),
    );
  }

  const entries = classes.map((cls) => ({
    name: `${cls.grade}年级${cls.class_name}班选课表-${stamp}.csv`,
    data: Buffer.from(CSV_BOM + csvDocument(buildRows(cls.grade, cls.class_name)), "utf8"),
  }));
  return sendCsvZip(res, stamp, "行政班级", entries);
});

// 社团班级：xlsx 为每门课程一个 sheet；csv 为每门课程一个 CSV 打压缩包
router.get("/api/admin/export/course-rosters", requireAdmin, (req: Request, res: Response) => {
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
  const buildRows = (course: (typeof courses)[number]) => {
    const students = db.all(
      sql`SELECT u.nickname, u.grade, u.class_name AS className, u.phone, u.username FROM selections s
          JOIN users u ON u.id = s.user_id
          WHERE s.course_id = ${course.id}
          ORDER BY u.id`,
    ) as RosterStudent[];
    return [
      [course.name, course.teacher, course.course_time, course.location, course.total_seats, course.tag, stamp],
      ...studentsWithClassRows(students),
    ];
  };

  if (exportFormat(req) === "xlsx") {
    return sendSheets(
      res,
      stamp,
      "社团班级",
      courses.map((course) => ({ name: course.name, rows: buildRows(course) })),
    );
  }

  // Same-name courses would collide inside the zip — disambiguate by id.
  const usedNames = new Set<string>();
  const entries = courses.map((course) => {
    let base = `${course.name}选课表-${stamp}.csv`;
    if (usedNames.has(base)) {
      base = `${course.name}(ID${course.id})选课表-${stamp}.csv`;
    }
    usedNames.add(base);
    return { name: base, data: Buffer.from(CSV_BOM + csvDocument(buildRows(course)), "utf8") };
  });
  return sendCsvZip(res, stamp, "社团班级", entries);
});

// 未选课学生：选了 0 门课的学生，xlsx 单文件单 sheet；csv 单文件直下载
router.get("/api/admin/export/unselected", requireAdmin, (req: Request, res: Response) => {
  const students = db.all(
    sql`SELECT u.nickname, u.grade, u.class_name AS className, u.phone, u.username FROM users u
        WHERE u.is_admin = 0 AND NOT EXISTS (SELECT 1 FROM selections s WHERE s.user_id = u.id)
        ORDER BY u.id`,
  ) as RosterStudent[];

  const stamp = exportDateStamp();
  const rows = [[stamp], ...studentsWithClassRows(students)];
  if (exportFormat(req) === "xlsx") {
    return sendBuffer(
      res,
      `未选课学生表-${stamp}.xlsx`,
      buildXlsx([{ name: "未选课学生", rows }]),
      XLSX_CONTENT_TYPE,
    );
  }
  return sendBuffer(
    res,
    `未选课学生表-${stamp}.csv`,
    Buffer.from(CSV_BOM + csvDocument(rows), "utf8"),
    "text/csv; charset=utf-8",
  );
});

export default router;
