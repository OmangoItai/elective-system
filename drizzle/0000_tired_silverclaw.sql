CREATE TABLE "access" (
	"id" serial PRIMARY KEY NOT NULL,
	"course_id" integer NOT NULL,
	"open_time" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "access_users" (
	"access_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	CONSTRAINT "access_users_access_id_user_id_pk" PRIMARY KEY("access_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "config" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "courses" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"teacher" text NOT NULL,
	"description" text,
	"course_time" text,
	"location" text,
	"total_seats" integer NOT NULL,
	"available_seats" integer NOT NULL,
	"open_time" text NOT NULL,
	"allowed_grades" text
	,"tag" text
);
--> statement-breakpoint
CREATE TABLE "selections" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"course_id" integer NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "selections_user_id_course_id_unique" UNIQUE("user_id","course_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"nickname" text DEFAULT '' NOT NULL,
	"password" text NOT NULL,
	"is_admin" integer DEFAULT 0 NOT NULL,
	"grade" integer,
	"class_name" text,
	"phone" text,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
ALTER TABLE "access" ADD CONSTRAINT "access_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_users" ADD CONSTRAINT "access_users_access_id_access_id_fk" FOREIGN KEY ("access_id") REFERENCES "public"."access"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_users" ADD CONSTRAINT "access_users_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "selections" ADD CONSTRAINT "selections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "selections" ADD CONSTRAINT "selections_course_id_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."courses"("id") ON DELETE no action ON UPDATE no action;
