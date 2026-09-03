import { Router, Request, Response } from "express";
import { eq, and, inArray, ne } from "drizzle-orm";
import { db } from "../db/index";
import { courses, users, selections } from "../db/schema";
import { requireAdmin } from "../middleware/auth";
import { nowLocal } from "../utils/time";
import { parseRouteId } from "../utils/parse-id";
import { formatAllowedGrades } from "../utils/grade";
import { isGradeAllowed } from "../utils/grade";
import { readMaxSelections } from "../services/selection-policy";

const router = Router();

router.get("/admin/class", requireAdmin, async (_req: Request, res: Response, next) => {
  try {
    const allStudents = await db
      .select({ id: users.id, username: users.username, nickname: users.nickname, grade: users.grade, className: users.className, phone: users.phone })
      .from(users)
      .where(eq(users.isAdmin, 0));

    const allCourses = await db.select().from(courses);

    res.render("admin-class", {
      title: "班级管理",
      allStudents,
      allStudentsJson: JSON.stringify(allStudents).replace(/</g, "\\u003c"),
      allCourses,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/api/admin/class/courses/search", requireAdmin, async (req: Request, res: Response, next) => {
  try {
    const { name } = req.query;
    if (!name || typeof name !== "string" || !name.trim()) {
      return res.send(`<div class="px-6 py-4 text-sm text-gray-500">请输入课程名</div>`);
    }

    const courseRows = await db
      .select()
      .from(courses)
      .where(eq(courses.name, name.trim()));

    if (courseRows.length === 0) {
      return res.send(
        `<div class="px-6 py-4 text-sm text-red-500">未找到课程 "${escapeHtml(name.trim())}"</div>`
      );
    }
    const course = courseRows[0];

    const enrolledStudents = await db
      .select({ id: users.id, username: users.username, nickname: users.nickname, grade: users.grade, className: users.className, phone: users.phone })
      .from(selections)
      .innerJoin(users, eq(selections.userId, users.id))
      .where(eq(selections.courseId, course.id));

    res.send(renderResult(course, enrolledStudents, res.locals.csrfToken));
  } catch (err) {
    next(err);
  }
});

router.put(
  "/api/admin/class/courses/:id/students",
  requireAdmin,
  async (req: Request, res: Response, next) => {
    try {
      const courseId = parseRouteId(req.params.id);
      if (courseId === null) return res.status(400).send("无效的课程ID");
      const { user_ids } = req.body;

      const courseRows = await db
        .select()
        .from(courses)
        .where(eq(courses.id, courseId));
      if (courseRows.length === 0) return res.status(404).send("课程不存在");
      const course = courseRows[0];

      const rawIds = Array.isArray(user_ids) ? user_ids : user_ids ? [user_ids] : [];
      if (rawIds.some((id: unknown) => !/^\d+$/.test(String(id)))) {
        return res.status(400).send("名单中包含无效学生ID");
      }
      const ids = rawIds.map((id: unknown) => Number(id));

      const uniqueIds = [...new Set(ids)];

      const validUsers = uniqueIds.length > 0
        ? await db.select({ id: users.id, grade: users.grade })
            .from(users)
            .where(and(eq(users.isAdmin, 0), inArray(users.id, uniqueIds)))
        : [];
      const validIds = validUsers.map((user) => user.id);
      if (validIds.length !== uniqueIds.length) {
        return res.status(400).send("名单中包含不存在或非学生账号");
      }
      if (validUsers.some((user) => !isGradeAllowed(user.grade, course.allowedGrades))) {
        return res.status(400).send("名单中包含该课程不允许年级的学生");
      }

      if (validIds.length > course.totalSeats) {
        return res
          .status(400)
          .send(
            `名额不足，课程总名额 ${course.totalSeats}，当前提交 ${validIds.length} 人`
          );
      }

      const maxSelections = await readMaxSelections(db);
      for (const userId of validIds) {
        const otherSelections = await db.select({ id: selections.id })
          .from(selections)
          .where(and(eq(selections.userId, userId), ne(selections.courseId, courseId)));
        if (otherSelections.length >= maxSelections) {
          return res.status(400).send(`学生ID ${userId} 已达到最多 ${maxSelections} 门课限制`);
        }
      }

      await db.transaction(async (tx) => {
        await tx.delete(selections).where(eq(selections.courseId, courseId));

        if (validIds.length > 0) {
          const now = nowLocal();
          await tx.insert(selections)
            .values(
              validIds.map((userId) => ({ userId, courseId, createdAt: now }))
            );
        }

        await tx.update(courses)
          .set({ availableSeats: course.totalSeats - validIds.length })
          .where(eq(courses.id, courseId));
      });

      const updatedCourseRows = await db
        .select()
        .from(courses)
        .where(eq(courses.id, courseId));
      const updatedCourse = updatedCourseRows[0]!;

      const enrolledStudents = await db
        .select({ id: users.id, username: users.username, nickname: users.nickname, grade: users.grade, className: users.className, phone: users.phone })
        .from(selections)
        .innerJoin(users, eq(selections.userId, users.id))
        .where(eq(selections.courseId, courseId));

      res.send(renderResult(updatedCourse, enrolledStudents, req.session.csrfToken!));
    } catch (err) {
      next(err);
    }
  }
);

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function renderBadgesReadOnly(
  students: StudentSummary[]
): string {
  if (students.length === 0) {
    return '<p class="text-sm text-gray-400">暂无学生选课</p>';
  }
  let html = '<div class="flex flex-wrap gap-1.5">';
  students.forEach((s) => {
    html +=
      '<span class="inline-flex items-center rounded-full bg-blue-50 border border-blue-200 px-2.5 py-0.5 text-xs font-medium text-blue-700">' +
      escapeHtml(studentLabel(s)) +
      "</span>";
  });
  html += "</div>";
  return html;
}

function renderResult(
  course: any,
  enrolled: StudentSummary[],
  csrfToken: string
): string {
  const selected = enrolled.length;
  const total = course.totalSeats;
  const availableRatio = total > 0 ? (total - selected) / total : 0;
  const barC =
    availableRatio > 0.5
      ? "bg-green-500"
      : availableRatio > 0.2
        ? "bg-yellow-500"
        : "bg-red-500";
  const txtC =
    availableRatio > 0.5
      ? "text-green-700"
      : availableRatio > 0.2
        ? "text-yellow-700"
        : "text-red-700";

  let h = "";
  h += '<div id="class-result-' + course.id + '" class="px-6 py-4">';

  h += '<div class="flex items-start justify-between mb-3">';
  h += "<div>";
  h +=
    '<h3 class="text-lg font-semibold text-gray-900">' + escapeHtml(course.name) + "</h3>";
  h +=
    '<p class="text-sm text-gray-500 mt-0.5">' +
    escapeHtml(course.teacher || "") +
    " &middot; " +
    escapeHtml(course.courseTime || "") +
    " &middot; " +
    escapeHtml(course.location || "") +
    " &middot; 允许年级 " +
    escapeHtml(formatAllowedGrades(course.allowedGrades)) +
    "</p>";
  h += "</div>";
  h +=
    '<span class="text-sm font-medium ' +
    txtC +
    '">' +
    selected +
    " / " +
    total +
    "</span>";
  h += "</div>";

  h += '<div class="w-full bg-gray-100 rounded-full h-2 mb-4">';
  h +=
    '<div class="' +
    barC +
    ' h-2 rounded-full transition-all" style="width: ' +
    (total > 0 ? (selected / total) * 100 : 0) +
    '%"></div>';
  h += "</div>";

  h += '<div class="flex items-center justify-between mb-2">';
  h +=
    '<span class="text-xs font-medium text-gray-500 uppercase tracking-wider">已选学生 &middot; ' +
    selected +
    " 人</span>";
  h +=
    '<button onclick="document.getElementById(\'edit-class-' +
    course.id +
    '\').classList.toggle(\'hidden\')" class="text-xs font-medium rounded-lg px-2.5 py-1.5 bg-white border border-gray-300 text-gray-700 hover:bg-gray-50 transition-colors">编辑</button>';
  h += "</div>";

  h += '<div id="badges-readonly-' + course.id + '" class="mb-3">';
  h += renderBadgesReadOnly(enrolled);
  h += "</div>";

  h += '<div id="edit-class-' + course.id + '" class="hidden border-t border-dashed border-gray-200 pt-4 pb-1">';
  h +=
    '<form method="POST" action="/api/admin/class/courses/' +
    course.id +
    '/students?_method=PUT" class="edit-form">';

  h += '<input type="hidden" name="_csrf" value="' + escapeHtml(csrfToken) + '" />';

  h +=
    '<label class="block text-sm font-medium text-gray-700 mb-1.5">当前班级学生</label>';
  h +=
    '<div id="edit-badges-' +
    course.id +
    '" class="student-badges flex flex-wrap gap-1.5 mb-3 min-h-[2rem]' +
    (enrolled.length === 0 ? " items-center" : "") +
    '" data-course-id="' +
    course.id +
    '">';
  if (enrolled.length === 0) {
    h += '<span class="text-xs text-gray-400">暂无学生</span>';
  } else {
    enrolled.forEach((s) => {
      h +=
        '<span class="inline-flex items-center gap-1 rounded-full bg-blue-50 border border-blue-200 px-2.5 py-0.5 text-xs font-medium text-blue-700" data-user-id="' +
        s.id +
        '">' +
        escapeHtml(studentLabel(s)) +
        '<button type="button" onclick="removeStudentBadge(this)" class="text-blue-400 hover:text-red-500 hover:bg-red-50 transition-colors mx-0.5" title="移除">&times;</button></span>';
    });
  }
  h += "</div>";

  h +=
    '<textarea class="edit-student-input w-full rounded-lg border border-gray-300 px-3 py-2 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 resize-y mb-2" rows="2" placeholder="粘贴学生用户名，可用空格、逗号、换行分隔"></textarea>';
  h +=
    '<button type="button" onclick="addStudentsToEdit(this)" class="inline-flex items-center justify-center text-xs font-medium rounded-lg px-3 py-1.5 bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100 transition-colors mb-3">批量添加</button>';
  h +=
    '<div class="edit-unmatched text-xs text-red-500 mb-3 hidden"></div>';

  h += '<div class="hidden-inputs-container">';
  enrolled.forEach((s) => {
    h +=
      '<input type="hidden" name="user_ids" value="' + s.id + '" />';
  });
  h += "</div>";

  h += '<div class="flex items-center gap-2">';
  h +=
    '<button type="submit" class="inline-flex items-center justify-center text-sm font-medium rounded-lg px-4 py-2 bg-blue-600 text-white hover:bg-blue-700 transition-colors">保存</button>';
  h +=
    '<button type="button" onclick="document.getElementById(\'edit-class-' +
    course.id +
    '\').classList.add(\'hidden\')" class="inline-flex items-center justify-center text-sm font-medium rounded-lg px-4 py-2 border border-gray-300 text-gray-700 hover:bg-gray-50 transition-colors">取消</button>';
  h += "</div>";

  h += "</form>";
  h += "</div>";

  h += "</div>";
  return h;
}

export default router;

type StudentSummary = {
  id: number;
  username: string;
  nickname: string;
  grade: number | null;
  className: string | null;
  phone: string | null;
};

function studentLabel(student: StudentSummary): string {
  const grade = student.grade === null ? "未设置年级" : `${student.grade}级`;
  return `${student.nickname}（${student.username}，${grade}，${student.className || "未设置班级"}，${student.phone || "未填写手机号"}）`;
}
