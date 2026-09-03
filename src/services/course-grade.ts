import { eq, inArray } from "drizzle-orm";
import { courses, selections, users } from "../db/schema";
import { isGradeAllowed, studentGrade } from "../utils/grade";

interface SelectionWithGrade {
  selectionId: number;
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
    .select({ selectionId: selections.id, grade: users.grade })
    .from(selections)
    .innerJoin(users, eq(selections.userId, users.id))
    .where(eq(selections.courseId, courseId)) as SelectionWithGrade[];

  const removedIds = selected
    .filter(({ grade }) => !isGradeAllowed(studentGrade(grade), allowedGrades))
    .map(({ selectionId }) => selectionId);

  if (removedIds.length > 0) {
    await client.delete(selections).where(inArray(selections.id, removedIds));
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

  for (const courseId of new Set(removed.map((item) => item.courseId))) {
    const courseRows = await client.select().from(courses).where(eq(courses.id, courseId));
    const course = courseRows[0];
    if (!course) continue;
    const selectedRows = await client
      .select({ id: selections.id })
      .from(selections)
      .where(eq(selections.courseId, courseId));
    await client.update(courses)
      .set({ availableSeats: course.totalSeats - selectedRows.length })
      .where(eq(courses.id, courseId));
  }

  return removed.length;
}
