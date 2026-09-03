import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import session from "express-session";
import { RedisStore } from "connect-redis";
import { eq } from "drizzle-orm";
import { db } from "./db/index";
import { redis } from "./lib/redis";
import { config, users } from "./db/schema";
import adminAccessRouter from "./routes/admin-access";
import adminClassRouter from "./routes/admin-class";
import adminCoursesRouter from "./routes/admin-courses";
import adminUsersRouter from "./routes/admin-users";
import authRouter from "./routes/auth";
import coursesRouter from "./routes/courses";
import pagesRouter from "./routes/pages";
import profileRouter from "./routes/profile";
import selectionsRouter from "./routes/selections";
import { linkifyStudentNotice } from "./utils/student-notice";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  const isProduction = process.env.NODE_ENV === "production";
  if (isProduction && !process.env.SESSION_SECRET) {
    throw new Error("SESSION_SECRET is required in production");
  }

  app.use(session({
    store: new RedisStore({ client: redis }),
    secret: process.env.SESSION_SECRET || "elective-system-secret-change-in-production",
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 7 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: "lax",
      secure: isProduction,
    },
  }));

  app.use(express.static(path.join(path.dirname(currentDirectory), "public")));
  app.set("view engine", "ejs");
  app.set("views", path.join(currentDirectory, "views"));
  app.use(csrfMiddleware);

  app.use(async (req, res, next) => {
    try {
      res.locals.currentPath = req.path;
      res.locals.user = req.session.userId
        ? (await db.select().from(users).where(eq(users.id, req.session.userId)))[0] || null
        : null;
      const siteTitle = await db.select({ value: config.value }).from(config).where(eq(config.key, "site_title"));
      res.locals.siteTitle = siteTitle[0]?.value || "选课系统";
      const studentNoticeRow = await db.select({ value: config.value }).from(config).where(eq(config.key, "student_notice"));
      const studentNotice = studentNoticeRow[0]?.value.trim() || "";
      res.locals.studentNoticeSegments = res.locals.user && !res.locals.user.isAdmin && res.locals.user.phone && studentNotice
        ? linkifyStudentNotice(studentNotice)
        : [];
      next();
    } catch (err) {
      next(err);
    }
  });

  app.use((req, res, next) => {
    const user = res.locals.user as typeof users.$inferSelect | null;
    if (
      user &&
      !user.isAdmin &&
      !user.phone &&
      req.path !== "/profile" &&
      req.path !== "/api/profile" &&
      req.path !== "/api/logout"
    ) {
      return res.redirect("/profile");
    }
    next();
  });

  app.use((req, res, next) => {
    const render = res.render.bind(res);
    const renderWithLayout = function (view: string, options: Record<string, unknown> = {}, callback?: (error: Error, html: string) => void) {
      if (view === "login" || view === "layout" || options.layout === false) {
        return render(view, { ...options, user: options.user || res.locals.user }, callback);
      }
      const merged = { ...options, user: options.user || res.locals.user };
      render(view, merged, (error, body) => {
        if (error) return callback ? callback(error, "") : next(error);
        render("layout", { ...merged, body }, callback);
      });
    };
    res.render = renderWithLayout as typeof res.render;
    next();
  });

  app.use("/", pagesRouter);
  app.use("/", authRouter);
  app.use("/", profileRouter);
  app.use("/", coursesRouter);
  app.use("/", selectionsRouter);
  app.use("/", adminCoursesRouter);
  app.use("/", adminAccessRouter);
  app.use("/", adminUsersRouter);
  app.use("/", adminClassRouter);
  return app;
}

function csrfMiddleware(req: Request, res: Response, next: NextFunction) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    req.session.csrfToken ||= crypto.randomBytes(32).toString("hex");
    res.locals.csrfToken = req.session.csrfToken;
    return next();
  }

  const token = req.body?._csrf || req.headers["x-csrf-token"];
  if (!token || token !== req.session.csrfToken) {
    return res.status(403).send("CSRF 验证失败");
  }
  res.locals.csrfToken = req.session.csrfToken;
  next();
}
