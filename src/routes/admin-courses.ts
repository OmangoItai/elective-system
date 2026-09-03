import { Router, Request, Response } from "express";
import { eq, count, inArray } from "drizzle-orm";
import { db } from "../db/index";
import { courses, access, accessUsers, selections, config } from "../db/schema";
import { requireAdmin } from "../middleware/auth";
import {
  toLocalISOShort,
  nowLocal,
  isValidLocalDateTime,
  normalizeLocalDateTime,
  normalizeStartOfDay,
  future,
} from "../utils/time";
import { parseRouteId } from "../utils/parse-id";
import { parseAllowedGrades, serializeAllowedGrades } from "../utils/grade";
import { readEndTime, readStartTime } from "../utils/app-config";
import { removeIneligibleSelections } from "../services/course-grade";

const router = Router();

function getDefaultOpenTime(): string {
  const now = new Date();
  const { mar1, sep1 } = future(now);
  const closer = mar1.getTime() - now.getTime() < sep1.getTime() - now.getTime() ? mar1 : sep1;
  return toLocalISOShort(closer);
}

const ALLOWED_CONFIG_KEYS = ["site_title", "max_selections", "student_notice", "course_instructions"];

function parseAllowedGradesInput(raw: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw == null || String(raw).trim() === "") return { ok: true, value: null };
  const grades = parseAllowedGrades(String(raw));
  if (!grades) return { ok: false, error: "允许年级格式不正确，请填写4位年级标识，多个年级用逗号分隔，例如 2024,2026" };
  return { ok: true, value: serializeAllowedGrades(grades) };
}

class CourseCapacityError extends Error {}

router.get("/admin/courses", requireAdmin, async (_req: Request, res: Response, next) => {
  try {
    const endTime = await readEndTime(db);
    const startTime = await readStartTime(db);
    const siteTitleRows = await db.select({ value: config.value }).from(config).where(eq(config.key, "site_title"));
    const siteTitle = siteTitleRows[0]?.value || "选课系统";
    const maxSelectionsRows = await db.select({ value: config.value }).from(config).where(eq(config.key, "max_selections"));
    const maxSelections = maxSelectionsRows[0]?.value || "1";
    const studentNoticeRows = await db.select({ value: config.value }).from(config).where(eq(config.key, "student_notice"));
    const studentNotice = studentNoticeRows[0]?.value || "";
    const courseInstructionsRows = await db.select({ value: config.value }).from(config).where(eq(config.key, "course_instructions"));
    const courseInstructions = courseInstructionsRows[0]?.value || "";
    const defaultOpenTime = getDefaultOpenTime();

    const selectedCounts = await db
      .select({ courseId: selections.courseId, count: count() })
      .from(selections)
      .groupBy(selections.courseId);
    const countMap = new Map(selectedCounts.map((r) => [r.courseId, Number(r.count)]));

    const allCourses = await db.select().from(courses).orderBy(courses.id);
    const courseRows = allCourses.map((c) => ({
      ...c,
      selected_count: countMap.get(c.id) || 0,
    }));

    res.render("admin-courses", {
      title: "课程管理",
      courses: courseRows,
      endTime,
      startTime,
      siteTitle,
      maxSelections,
      studentNotice,
      courseInstructions,
      defaultOpenTime,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/api/admin/courses", requireAdmin, async (req: Request, res: Response, next) => {
  try {
    const { name, teacher, description, courseTime, location, openTime } = req.body;
    const totalSeats = Number(req.body.totalSeats);

    const errors: string[] = [];
    if (!name || !name.trim()) errors.push("课程名称不能为空");
    if (!teacher || !teacher.trim()) errors.push("授课教师不能为空");
    if (!Number.isInteger(totalSeats) || totalSeats < 1) errors.push("总名额必须为大于0的整数");
    if (!openTime || !isValidLocalDateTime(openTime)) errors.push("开放时间格式不正确");
    let allowedGrades: string | null = null;
    const allowed = parseAllowedGradesInput(req.body.allowedGrades);
    if (!allowed.ok) errors.push(allowed.error);
    else allowedGrades = allowed.value;

    if (errors.length > 0) {
      return res.status(400).send(errors.join("；"));
    }

    await db.insert(courses).values({
      name: name.trim(),
      teacher: teacher.trim(),
      description: description || null,
      courseTime: courseTime || null,
      location: location || null,
      totalSeats,
      availableSeats: totalSeats,
      openTime: normalizeStartOfDay(openTime) || nowLocal(),
      allowedGrades,
    });

    res.redirect("/admin/courses");
  } catch (err) {
    next(err);
  }
});

router.put("/api/admin/courses/:id", requireAdmin, async (req: Request, res: Response, next) => {
  try {
    const courseId = parseRouteId(req.params.id);
    if (courseId === null) return res.status(400).send("无效的课程ID");
    const { name, teacher, description, courseTime, location, totalSeats, openTime, resetSeats, allowedGrades } = req.body;

    const existingRows = await db.select().from(courses).where(eq(courses.id, courseId));
    if (existingRows.length === 0) return res.status(404).send("课程不存在");
    const existing = existingRows[0];

    const updateData: any = {};

    if (name !== undefined) {
      if (!String(name).trim()) return res.status(400).send("课程名称不能为空");
      updateData.name = String(name).trim();
    }
    if (teacher !== undefined) {
      if (!String(teacher).trim()) return res.status(400).send("授课教师不能为空");
      updateData.teacher = String(teacher).trim();
    }
    if (description !== undefined) updateData.description = description || null;
    if (courseTime !== undefined) updateData.courseTime = courseTime || null;
    if (location !== undefined) updateData.location = location || null;
    if (openTime !== undefined) {
      if (openTime && !isValidLocalDateTime(openTime)) {
        return res.status(400).send("开放时间格式不正确");
      }
      updateData.openTime = openTime ? normalizeStartOfDay(openTime) : openTime;
    }
    if (allowedGrades !== undefined) {
      const allowed = parseAllowedGradesInput(allowedGrades);
      if (!allowed.ok) return res.status(400).send(allowed.error);
      updateData.allowedGrades = allowed.value;
    }
    let parsedTotalSeats: number | undefined;
    if (totalSeats !== undefined) {
      parsedTotalSeats = Number(totalSeats);
      if (!Number.isInteger(parsedTotalSeats) || parsedTotalSeats < 1) {
        return res.status(400).send("总名额必须为大于0的整数");
      }
      updateData.totalSeats = parsedTotalSeats;
    }

    const shouldResetSeats = resetSeats === "true" || resetSeats === "1";
    let removedCount = 0;

    if (Object.keys(updateData).length > 0 || shouldResetSeats) {
      try {
        await db.transaction(async (tx) => {
          const selectedCountResult = await tx
            .select({ count: count() })
            .from(selections)
            .where(eq(selections.courseId, courseId));
          let selectedCount = selectedCountResult[0].count;

          if (allowedGrades !== undefined) {
            const reconciled = await removeIneligibleSelections(tx, courseId, updateData.allowedGrades);
            removedCount = reconciled.removedCount;
            selectedCount = reconciled.selectedCount;
          }

          const effectiveTotalSeats = parsedTotalSeats ?? existing.totalSeats;
          if (effectiveTotalSeats < selectedCount) {
            throw new CourseCapacityError(`总名额不能小于已选人数（${selectedCount}）`);
          }

          if (parsedTotalSeats !== undefined || shouldResetSeats || removedCount > 0) {
            updateData.availableSeats = effectiveTotalSeats - selectedCount;
          }

          await tx.update(courses).set(updateData).where(eq(courses.id, courseId));
        });
      } catch (error) {
        if (error instanceof CourseCapacityError) {
          return res.status(400).send(error.message);
        }
        throw error;
      }
    }

    if (removedCount > 0) res.set("X-Removed-Selections", String(removedCount));
    res.redirect("/admin/courses");
  } catch (err) {
    next(err);
  }
});

router.delete("/api/admin/courses/:id", requireAdmin, async (req: Request, res: Response, next) => {
  try {
    const courseId = parseRouteId(req.params.id);
    if (courseId === null) return res.status(400).send("无效的课程ID");

    const courseRows = await db.select().from(courses).where(eq(courses.id, courseId));
    if (courseRows.length === 0) return res.status(404).send("课程不存在");

    await db.transaction(async (tx) => {
      const accessIds = await tx.select({ id: access.id }).from(access).where(eq(access.courseId, courseId));
      if (accessIds.length > 0) {
        await tx.delete(accessUsers).where(
          inArray(accessUsers.accessId, accessIds.map(a => a.id))
        );
      }
      await tx.delete(access).where(eq(access.courseId, courseId));
      await tx.delete(selections).where(eq(selections.courseId, courseId));
      await tx.delete(courses).where(eq(courses.id, courseId));
    });

    res.status(200).send("OK");
  } catch (err) {
    next(err);
  }
});

router.put("/api/admin/selection-window", requireAdmin, async (req: Request, res: Response, next) => {
  try {
    const startTime = String(req.body.startTime || "");
    const endTime = String(req.body.endTime || "");

    if (!startTime || !endTime) {
      return res.status(400).send("开始时间和截止时间不能为空");
    }
    const normalizedStart = normalizeLocalDateTime(startTime);
    const normalizedEnd = normalizeLocalDateTime(endTime);
    if (!normalizedStart || !normalizedEnd) {
      return res.status(400).send("开始时间或截止时间格式不正确");
    }
    if (normalizedStart > normalizedEnd) {
      return res.status(400).send("开始时间不得晚于截止时间");
    }

    const values = [
      { key: "start_time", value: normalizedStart },
      { key: "end_time", value: normalizedEnd },
    ];
    await db.transaction(async (tx) => {
      for (const value of values) {
        await tx.insert(config).values(value)
          .onConflictDoUpdate({ target: config.key, set: { value: value.value } });
      }
    });

    res.redirect("/admin/courses");
  } catch (err) {
    next(err);
  }
});

router.put("/api/admin/config", requireAdmin, async (req: Request, res: Response, next) => {
  try {
    const { key, value } = req.body;

    if (!ALLOWED_CONFIG_KEYS.includes(key)) {
      return res.status(400).send("不可修改的配置项");
    }

    if (key === "max_selections" && (!/^\d+$/.test(String(value)) || Number(value) < 1)) {
      return res.status(400).send("最大选课数必须为正整数");
    }
    if (key === "site_title" && !String(value || "").trim()) {
      return res.status(400).send("显示标题不能为空");
    }
    if (key === "student_notice" && String(value || "").length > 2000) {
      return res.status(400).send("学生通知不能超过2000个字符");
    }

    let stored = value || "";
    if (key === "site_title") stored = stored.trim();
    if (key === "student_notice" || key === "course_instructions") stored = String(stored).trim();

    await db.insert(config).values({ key, value: stored })
      .onConflictDoUpdate({ target: config.key, set: { value: stored } });

    res.redirect("/admin/courses");
  } catch (err) {
    next(err);
  }
});

export default router;
