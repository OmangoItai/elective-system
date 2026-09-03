import { Router, Request, Response } from "express";
import { eq, and, inArray, count } from "drizzle-orm";
import { db } from "../db/index";
import { access, accessUsers, courses, users } from "../db/schema";
import { requireAdmin } from "../middleware/auth";
import { isValidLocalDateTime, normalizeStartOfDay, nowLocal } from "../utils/time";
import { parseRouteId } from "../utils/parse-id";
import { isGradeAllowed } from "../utils/grade";

const router = Router();

router.get("/admin/access", requireAdmin, async (_req: Request, res: Response, next) => {
  try {
    const accessRows = await db
      .select({
        id: access.id,
        courseId: access.courseId,
        openTime: access.openTime,
        courseName: courses.name,
        allowedGrades: courses.allowedGrades,
      })
      .from(access)
      .innerJoin(courses, eq(access.courseId, courses.id))
      .orderBy(access.id);

    const accessIds = accessRows.map((r) => r.id);
    const studentCounts = accessIds.length > 0
      ? await db
          .select({ accessId: accessUsers.accessId, count: count() })
          .from(accessUsers)
          .where(inArray(accessUsers.accessId, accessIds))
          .groupBy(accessUsers.accessId)
      : [];
    const countByAccess = new Map(studentCounts.map((r) => [r.accessId, Number(r.count)]));

    const allCourses = await db.select().from(courses);
    const allStudents = await db.select({
      id: users.id,
      username: users.username,
      nickname: users.nickname,
      grade: users.grade,
      className: users.className,
      phone: users.phone,
    }).from(users).where(eq(users.isAdmin, 0));

    const auRows = await db
      .select({
        accessId: accessUsers.accessId,
        userId: accessUsers.userId,
        username: users.username,
        nickname: users.nickname,
        grade: users.grade,
        className: users.className,
        phone: users.phone,
      })
      .from(accessUsers)
      .innerJoin(users, eq(accessUsers.userId, users.id));

    const accessStudents: Record<number, typeof auRows> = {};
    auRows.forEach((r) => {
      if (!accessStudents[r.accessId]) accessStudents[r.accessId] = [];
      accessStudents[r.accessId].push(r);
    });

    const accessRowsWithCount = accessRows.map((r) => ({
      ...r,
      student_count: countByAccess.get(r.id) || 0,
    }));

    res.render("admin-access", {
      title: "优先批次管理",
      accessRows: accessRowsWithCount,
      allCourses,
      allStudents,
      allStudentsJson: JSON.stringify(allStudents).replace(/</g, "\\u003c"),
      accessStudents,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/api/admin/access", requireAdmin, async (req: Request, res: Response, next) => {
  try {
    const courseId = parseInt(req.body.course_id);
    const openTime = req.body.open_time;
    const userIds = parseUserIds(req.body.user_ids);

    if (isNaN(courseId) || courseId < 1) return res.status(400).send("无效的课程ID");
    if (!openTime || !isValidLocalDateTime(openTime)) return res.status(400).send("无效的开放时间");
    if (userIds.length === 0) return res.status(400).send("至少选择一个学生");

    const courseRows = await db.select().from(courses).where(eq(courses.id, courseId));
    if (courseRows.length === 0) return res.status(400).send("课程不存在");
    const course = courseRows[0];

    const validUsers = await db.select({ id: users.id, grade: users.grade }).from(users)
      .where(and(eq(users.isAdmin, 0), inArray(users.id, userIds)));
    if (validUsers.length !== userIds.length) return res.status(400).send("批次中包含无效学生ID");
    if (validUsers.some((user) => !isGradeAllowed(user.grade, course.allowedGrades))) {
      return res.status(400).send("批次中包含该课程不允许年级的学生");
    }

    await db.transaction(async (tx) => {
      const [result] = await tx.insert(access).values({ courseId, openTime: normalizeStartOfDay(openTime) || nowLocal() }).returning({ id: access.id });
      if (result) {
        await tx.insert(accessUsers).values(
          userIds.map(userId => ({ accessId: result.id, userId }))
        );
      }
    });

    res.redirect("/admin/access");
  } catch (err) {
    next(err);
  }
});

router.put("/api/admin/access/:id", requireAdmin, async (req: Request, res: Response, next) => {
  try {
    const accessId = parseRouteId(req.params.id);
    if (accessId === null) return res.status(400).send("无效的批次ID");
    const { open_time } = req.body;

    const existingRows = await db.select().from(access).where(eq(access.id, accessId));
    if (existingRows.length === 0) return res.status(404).send("Access组不存在");
    const existing = existingRows[0];

    if (!open_time || !isValidLocalDateTime(open_time)) return res.status(400).send("无效的开放时间");
    const userIds = parseUserIds(req.body.user_ids);
    if (userIds.length === 0) return res.status(400).send("至少选择一个学生");

    const courseRows = await db.select().from(courses).where(eq(courses.id, existing.courseId));
    if (courseRows.length === 0) return res.status(404).send("课程不存在");
    const course = courseRows[0];

    const validUsers = await db.select({ id: users.id, grade: users.grade }).from(users)
      .where(and(eq(users.isAdmin, 0), inArray(users.id, userIds)));
    if (validUsers.length !== userIds.length) return res.status(400).send("批次中包含无效学生ID");
    if (validUsers.some((user) => !isGradeAllowed(user.grade, course.allowedGrades))) {
      return res.status(400).send("批次中包含该课程不允许年级的学生");
    }

    await db.transaction(async (tx) => {
      await tx.update(access)
        .set({ openTime: normalizeStartOfDay(open_time) })
        .where(eq(access.id, accessId));
      await tx.delete(accessUsers).where(eq(accessUsers.accessId, accessId));
      await tx.insert(accessUsers).values(userIds.map((userId) => ({ accessId, userId })));
    });

    res.redirect("/admin/access");
  } catch (err) {
    next(err);
  }
});

router.delete("/api/admin/access/:id", requireAdmin, async (req: Request, res: Response, next) => {
  try {
    const accessId = parseRouteId(req.params.id);
    if (accessId === null) return res.status(400).send("无效的批次ID");

    await db.delete(accessUsers).where(eq(accessUsers.accessId, accessId));
    await db.delete(access).where(eq(access.id, accessId));

    res.status(200).send("OK");
  } catch (err) {
    next(err);
  }
});

export default router;

function parseUserIds(raw: unknown): number[] {
  const values = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  return [...new Set(values
    .flatMap((value) => String(value).split(","))
    .map((value) => /^\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN)
    .filter((value) => Number.isInteger(value) && value > 0))];
}
