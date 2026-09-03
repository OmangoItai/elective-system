import { sql } from "drizzle-orm";

type SqlClient = {
  execute: (query: any) => Promise<any>;
};

export async function createCourseSeats(client: SqlClient, courseId: number, count: number): Promise<void> {
  if (count <= 0) return;
  await client.execute(sql`
    INSERT INTO course_seats (course_id)
    SELECT ${courseId} FROM generate_series(1, ${count})
  `);
}

export async function deleteCourseSeats(client: SqlClient, courseId: number): Promise<void> {
  await client.execute(sql`DELETE FROM course_seats WHERE course_id = ${courseId}`);
}

export async function claimCourseSeat(
  client: SqlClient,
  courseId: number,
  userId: number,
  now: string,
): Promise<boolean> {
  const result = await client.execute(sql`
    WITH next_seat AS (
      SELECT id FROM course_seats
      WHERE course_id = ${courseId} AND user_id IS NULL
      ORDER BY id
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE course_seats
    SET user_id = ${userId}, created_at = ${now}
    FROM next_seat
    WHERE course_seats.id = next_seat.id
    RETURNING course_seats.id
  `);
  return (result.rowCount ?? 0) > 0;
}

export async function releaseCourseSeat(client: SqlClient, courseId: number, userId: number): Promise<void> {
  await client.execute(sql`
    UPDATE course_seats
    SET user_id = NULL, created_at = NULL
    WHERE course_id = ${courseId} AND user_id = ${userId}
  `);
}

export async function syncCourseAvailableSeats(client: SqlClient, courseId: number): Promise<void> {
  await client.execute(sql`
    UPDATE courses
    SET available_seats = (
      SELECT count(*) FROM course_seats
      WHERE course_id = ${courseId} AND user_id IS NULL
    )
    WHERE id = ${courseId}
  `);
}

export async function adjustCourseSeats(
  client: SqlClient,
  courseId: number,
  targetTotal: number,
): Promise<void> {
  const countResult = await client.execute(sql`
    SELECT count(*)::int AS total FROM course_seats WHERE course_id = ${courseId}
  `);
  const currentTotal = Number(countResult.rows[0]?.total ?? 0);

  if (currentTotal > targetTotal) {
    const excess = currentTotal - targetTotal;
    await client.execute(sql`
      DELETE FROM course_seats
      WHERE id IN (
        SELECT id FROM course_seats
        WHERE course_id = ${courseId} AND user_id IS NULL
        ORDER BY id DESC
        LIMIT ${excess}
      )
    `);
  } else if (currentTotal < targetTotal) {
    await createCourseSeats(client, courseId, targetTotal - currentTotal);
  }
}

export async function resetCourseSeats(
  client: SqlClient,
  courseId: number,
  totalSeats: number,
  selectedUserIds: number[],
): Promise<void> {
  await deleteCourseSeats(client, courseId);

  if (totalSeats > 0) {
    const assigned = selectedUserIds.slice(0, totalSeats);
    const emptyCount = totalSeats - assigned.length;

    if (emptyCount > 0) {
      await createCourseSeats(client, courseId, emptyCount);
    }

    if (assigned.length > 0) {
      const now = new Date().toISOString();
      const values = assigned.map((userId) => `(${courseId}, ${userId}, '${now}')`).join(", ");
      await client.execute(sql.raw(
        `INSERT INTO course_seats (course_id, user_id, created_at) VALUES ${values}`
      ));
    }
  }
}
