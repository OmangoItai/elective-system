import { pgTable, serial, integer, text, primaryKey, unique } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  nickname: text("nickname").notNull().default(""),
  password: text("password").notNull(),
  isAdmin: integer("is_admin").notNull().default(0),
  grade: integer("grade"),
  className: text("class_name"),
  phone: text("phone"),
});

export const courses = pgTable("courses", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  teacher: text("teacher").notNull(),
  description: text("description"),
  courseTime: text("course_time"),
  location: text("location"),
  totalSeats: integer("total_seats").notNull(),
  availableSeats: integer("available_seats").notNull(),
  openTime: text("open_time").notNull(),
  allowedGrades: text("allowed_grades"),
  tag: text("tag"),
});

export const access = pgTable("access", {
  id: serial("id").primaryKey(),
  courseId: integer("course_id").notNull().references(() => courses.id),
  openTime: text("open_time").notNull(),
});

export const accessUsers = pgTable("access_users", {
  accessId: integer("access_id").notNull().references(() => access.id),
  userId: integer("user_id").notNull().references(() => users.id),
}, (table) => ({
  pk: primaryKey({ columns: [table.accessId, table.userId] }),
}));

export const selections = pgTable("selections", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id),
  courseId: integer("course_id").notNull().references(() => courses.id),
  createdAt: text("created_at").notNull(),
}, (table) => ({
  uniq: unique().on(table.userId, table.courseId),
}));

export const config = pgTable("config", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});
