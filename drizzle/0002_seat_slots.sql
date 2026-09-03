CREATE TABLE IF NOT EXISTS course_seats (
  id SERIAL PRIMARY KEY,
  course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT,
  UNIQUE (course_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_course_seats_course_id ON course_seats(course_id);
CREATE INDEX IF NOT EXISTS idx_course_seats_available ON course_seats(course_id) WHERE user_id IS NULL;

-- Backfill seat rows for existing courses based on their current available seats.
INSERT INTO course_seats (course_id)
SELECT c.id
FROM courses c
CROSS JOIN generate_series(1, c.available_seats) AS s;
