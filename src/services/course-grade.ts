import { eq, inArray, sql } from "drizzle-orm";
import { courses, selections, users } from "../db/schema";
import { isGradeAllowed, studentGrade } from "../utils/grade";
import { releaseCourseSeat } from "./seats";

interface SelectionWithGrade {
  selectionId: number;
  userId: number;
  grade: number | null;
}

interface SelectionWithCourse {
  selectionId: number;
  courseId: number;
  allowedGrades: string | null;
}

export async function removeIneligibleSelections(
  client: any,
  courseId: number,
  allowedGrades: string | null,
): Promise<{ removedCount: number; selectedCount: number }> {
  const selected = await client
    .select({ selectionId: selections.id, userId: selections.userId, grade: users.grade })
    .from(selections)
    .innerJoin(users, eq(selections.userId, users.id))
    .where(eq(selections.courseId, courseId)) as SelectionWithGrade[];

  const removed = selected
    .filter(({ grade }) => !isGradeAllowed(studentGrade(grade), allowedGrades));
  const removedIds = removed.map(({ selectionId }) => selectionId);

  if (removedIds.length > 0) {
    await client.delete(selections).where(inArray(selections.id, removedIds));
    for (const { userId } of removed) {
      await releaseCourseSeat(client, courseId, userId);
    }
    await client
      .update(courses)
      .set({ availableSeats: sql`${courses.availableSeats} + ${removedIds.length}` })
      .where(eq(courses.id, courseId));
  }

  return {
    removedCount: removedIds.length,
    selectedCount: selected.length - removedIds.length,
  };
}

export async function removeUserIneligibleSelections(
  client: any,
  userId: number,
  grade: number | null,
): Promise<number> {
  const selected = await client
    .select({ selectionId: selections.id, courseId: courses.id, allowedGrades: courses.allowedGrades })
    .from(selections)
    .innerJoin(courses, eq(selections.courseId, courses.id))
    .where(eq(selections.userId, userId)) as SelectionWithCourse[];

  const removed = selected.filter(({ allowedGrades }) => !isGradeAllowed(grade, allowedGrades));
  if (removed.length === 0) return 0;

  await client.delete(selections).where(inArray(selections.id, removed.map((item) => item.selectionId)));

  const removedByCourse = new Map<number, number>();
  for (const { courseId } of removed) {
    removedByCourse.set(courseId, (removedByCourse.get(courseId) || 0) + 1);
  }

  for (const [courseId, count] of removedByCourse) {
    await releaseCourseSeat(client, courseId, userId);
    await client
      .update(courses)
      .set({ availableSeats: sql`${courses.availableSeats} + ${count}` })
      .where(eq(courses.id, courseId));
  }

  return removed.length;
}
