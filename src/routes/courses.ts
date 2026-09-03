import { Router, Request, Response } from "express";
import { eq, and, sql } from "drizzle-orm";
import { db } from "../db/index";
import { courses, selections } from "../db/schema";
import { requireAuth } from "../middleware/auth";
import { asEndInstant, nowLocal } from "../utils/time";
import { parseRouteId } from "../utils/parse-id";
import { isGradeAllowed, studentGrade } from "../utils/grade";
import { effectiveOpenTime, resolveCourseState } from "../utils/course-state";
import { readConfig, readEndTime, readStartTime } from "../utils/app-config";
import { readMaxSelections, readOpenTimeForUser } from "../services/selection-policy";
import { releaseCourseSeat } from "../services/seats";
import { addSelectionJob, getJob } from "../lib/queue";

const router = Router();

router.get("/courses", requireAuth, async (req: Request, res: Response, next) => {
  try {
    if (req.session.isAdmin) return res.redirect("/admin/courses");

    const user = res.locals.user;
    if (!user) return res.redirect("/login");
    const now = nowLocal();
    const grade = studentGrade(user.grade);
    const startTime = await readStartTime(db);
    const endTime = await readEndTime(db);
    const maxSelections = await readMaxSelections(db);
    const courseInstructions = (await readConfig(db, "course_instructions"))?.trim() || "";

    const allCourses = await db.select().from(courses);

    const selectedRows = await db
      .select({ courseId: selections.courseId })
      .from(selections)
      .where(eq(selections.userId, user.id));
    const selectedIds = new Set(selectedRows.map((r) => r.courseId));

    const courseList = [];
    for (const c of allCourses) {
      if (!isGradeAllowed(grade, c.allowedGrades)) continue;
      const courseOpen = await readOpenTimeForUser(db, user.id, c.id);
      const opentime = effectiveOpenTime(courseOpen, startTime);
      const isSelected = selectedIds.has(c.id);
      const state = resolveCourseState({
        now,
        openTime: courseOpen,
        startTime,
        endTime,
        selected: isSelected,
        availableSeats: c.availableSeats,
      });
      courseList.push({ ...c, opentime, state, endtime: endTime });
    }

    res.render("courses", { courses: courseList, now, endTime, maxSelections, courseInstructions });
  } catch (err) {
    next(err);
  }
});

function isInternalError(msg: string): boolean {
  return /stack|undefined|null|cannot|syntax|ReferenceError|TypeError/i.test(msg);
}

router.post("/api/courses/:id/select", requireAuth, async (req: Request, res: Response, next) => {
  try {
    if (req.session.isAdmin) return res.status(403).send("管理员不能选课");

    const user = res.locals.user;
    if (!user) return res.status(403).send("请先登录");

    const courseId = parseRouteId(req.params.id);
    if (courseId === null) return res.status(400).send("无效的课程ID");
    const now = nowLocal();

    const courseRows = await db
      .select({
        id: courses.id,
        name: courses.name,
        teacher: courses.teacher,
        courseTime: courses.courseTime,
        location: courses.location,
        openTime: courses.openTime,
        allowedGrades: courses.allowedGrades,
        availableSeats: courses.availableSeats,
      })
      .from(courses)
      .where(eq(courses.id, courseId));
    if (courseRows.length === 0) {
      return res.status(400).send("课程不存在");
    }
    const course = courseRows[0];

    const grade = studentGrade(user.grade);
    if (!isGradeAllowed(grade, course.allowedGrades)) {
      return res.status(400).send("当前年级不可选择该课程");
    }

    const startTime = await readStartTime(db);
    const endTime = await readEndTime(db);
    const effectiveOpen = effectiveOpenTime(course.openTime, startTime);

    if (now < effectiveOpen) return res.status(400).send("尚未到开放时间");
    if (now >= asEndInstant(endTime)) return res.status(400).send("选课已截止");
    if (course.availableSeats <= 0) return res.status(400).send("没有剩余名额");

    const jobId = await addSelectionJob({ userId: user.id, courseId, now });
    res.render("_course-select-pending", { c: course, jobId: String(jobId), layout: false });
  } catch (e: any) {
    const msg = e.message || "";
    res.status(400).send(isInternalError(msg) ? "操作失败，请稍后重试" : msg);
  }
});

router.get("/api/courses/:id/select-status", requireAuth, async (req: Request, res: Response, next) => {
  try {
    const userId = req.session.userId!;
    const courseId = parseRouteId(req.params.id);
    if (courseId === null) return res.status(400).send("无效的课程ID");

    const jobId = req.query.jobId as string | undefined;
    if (!jobId) return res.status(400).send("缺少 jobId");

    const job = await getJob(jobId);
    if (!job) return res.status(404).send("任务不存在");

    const courseRows = await db.select().from(courses).where(eq(courses.id, courseId));
    if (courseRows.length === 0) return res.status(404).send("课程不存在");
    const course = courseRows[0];

    const state = await job.getState();

    if (state === "completed") {
      const courseOpen = await readOpenTimeForUser(db, userId, courseId);
      const startTime = await readStartTime(db);
      const endTimeStr = await readEndTime(db);
      const c = {
        ...course,
        opentime: effectiveOpenTime(courseOpen, startTime),
        state: "selected" as const,
        endtime: endTimeStr,
      };
      return res.render("_course-card", { c, layout: false });
    }

    if (state === "failed") {
      const courseOpen = await readOpenTimeForUser(db, userId, courseId);
      const startTime = await readStartTime(db);
      const endTime = await readEndTime(db);
      const selectedRows = await db
        .select({ courseId: selections.courseId })
        .from(selections)
        .where(and(eq(selections.userId, userId), eq(selections.courseId, courseId)));
      const c = {
        ...course,
        opentime: effectiveOpenTime(courseOpen, startTime),
        state: resolveCourseState({
          now: nowLocal(),
          openTime: courseOpen,
          startTime,
          endTime,
          selected: selectedRows.length > 0,
          availableSeats: course.availableSeats,
        }),
        endtime: endTime,
      };
      res.setHeader("HX-Trigger", JSON.stringify({ toast: { message: job.failedReason || "选课失败", type: "error" } }));
      return res.render("_course-card", { c, layout: false });
    }

    return res.render("_course-select-pending", { c: course, jobId, layout: false });
  } catch (e: any) {
    const msg = e.message || "";
    res.status(400).send(isInternalError(msg) ? "操作失败，请稍后重试" : msg);
  }
});

router.post("/api/courses/:id/drop", requireAuth, async (req: Request, res: Response, next) => {
  try {
    if (req.session.isAdmin) return res.status(403).send("管理员不能退课");

    const userId = req.session.userId!;
    const courseId = parseRouteId(req.params.id);
    if (courseId === null) return res.status(400).send("无效的课程ID");
    const now = nowLocal();

    await db.transaction(async (tx) => {
      const endTime = await readEndTime(tx);
      if (now >= asEndInstant(endTime)) throw new Error("选课已截止，无法退课");

      const sel = await tx
        .select()
        .from(selections)
        .where(and(eq(selections.userId, userId), eq(selections.courseId, courseId)));
      if (sel.length === 0) throw new Error("未选过该课程");

      await tx.delete(selections).where(eq(selections.id, sel[0].id));
      await releaseCourseSeat(tx, courseId, userId);
      await tx
        .update(courses)
        .set({ availableSeats: sql`${courses.availableSeats} + 1` })
        .where(eq(courses.id, courseId));
    });

    const courseRows = await db.select().from(courses).where(eq(courses.id, courseId));
    const course = courseRows[0]!;
    const courseOpen = await readOpenTimeForUser(db, userId, courseId);
    const startTime = await readStartTime(db);
    const endTime = await readEndTime(db);
    const opentime = effectiveOpenTime(courseOpen, startTime);
    const state = resolveCourseState({
      now,
      openTime: courseOpen,
      startTime,
      endTime,
      selected: false,
      availableSeats: course.availableSeats,
    });

    const c = { ...course, opentime, state, endtime: endTime };

    res.render("_course-card", { c, layout: false });
  } catch (e: any) {
    const msg = e.message || "";
    res.status(400).send(isInternalError(msg) ? "操作失败，请稍后重试" : msg);
  }
});

export default router;
