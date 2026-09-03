import { Worker, UnrecoverableError } from "bullmq";
import { eq, and, count } from "drizzle-orm";
import { db } from "../db/index";
import { courses, selections } from "../db/schema";
import { readMaxSelections, readOpenTimeForUser } from "../services/selection-policy";
import { readStartTime, readEndTime } from "../utils/app-config";
import { effectiveOpenTime } from "../utils/course-state";
import { asEndInstant } from "../utils/time";
import { redisUrl } from "../lib/redis";
import type { SelectionJobData } from "../lib/queue";

const concurrency = 4;

export const selectionWorker = new Worker<SelectionJobData>(
  "selection",
  async (job) => {
    const { userId, courseId, now } = job.data;

    await db.transaction(async (tx) => {
      const [course] = await tx
        .select()
        .from(courses)
        .where(eq(courses.id, courseId))
        .for("update");

      if (!course) {
        throw new UnrecoverableError("课程不存在");
      }

      const currentCount = await tx
        .select({ count: count() })
        .from(selections)
        .where(eq(selections.userId, userId));
      const maxSelections = await readMaxSelections(tx);
      if (currentCount[0].count >= maxSelections) {
        throw new UnrecoverableError(`最多只能选 ${maxSelections} 门课`);
      }

      const opentime = await readOpenTimeForUser(tx, userId, courseId);
      const startTime = await readStartTime(tx);
      const endTime = await readEndTime(tx);
      const effectiveOpen = effectiveOpenTime(opentime, startTime);

      if (now < effectiveOpen) {
        throw new UnrecoverableError("尚未到开放时间");
      }
      if (now >= asEndInstant(endTime)) {
        throw new UnrecoverableError("选课已截止");
      }
      if (course.availableSeats <= 0) {
        throw new UnrecoverableError("没有剩余名额");
      }

      const existing = await tx
        .select()
        .from(selections)
        .where(and(eq(selections.userId, userId), eq(selections.courseId, courseId)));
      if (existing.length > 0) {
        throw new UnrecoverableError("已选过该课程");
      }

      await tx
        .update(courses)
        .set({ availableSeats: course.availableSeats - 1 })
        .where(eq(courses.id, courseId));

      await tx.insert(selections).values({ userId, courseId, createdAt: now });
    });
  },
  {
    connection: { url: redisUrl },
    concurrency,
  },
);

selectionWorker.on("failed", (job, err) => {
  console.error(`Selection job ${job?.id} failed:`, err.message);
});

console.log(`Selection worker started with concurrency ${concurrency}`);
