import bcryptjs from "bcryptjs";
import { Router, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index";
import { users } from "../db/schema";
import { requireAuth } from "../middleware/auth";
import { removeUserIneligibleSelections } from "../services/course-grade";
import { parseProfileInput } from "../services/profile";
import { PHONE_PATTERN_SOURCE } from "../utils/phone";

const router = Router();

router.get("/profile", requireAuth, async (req: Request, res: Response, next) => {
  try {
    const userRows = await db.select().from(users).where(eq(users.id, req.session.userId!));
    const user = userRows[0];
    if (!user) return res.redirect("/login");
    if (user.isAdmin) return res.redirect("/admin/courses");

    res.render("profile", {
      title: "个人资料",
      profile: user,
      phonePattern: PHONE_PATTERN_SOURCE,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/api/profile", requireAuth, async (req: Request, res: Response, next) => {
  try {
    const userRows = await db.select().from(users).where(eq(users.id, req.session.userId!));
    const user = userRows[0];
    if (!user) return res.redirect("/login");
    if (user.isAdmin) return res.status(403).send("管理员不能修改学生资料");

    const profile = parseProfileInput({
      nickname: req.body.nickname,
      grade: req.body.grade,
      className: req.body.className,
      phone: req.body.phone,
      password: req.body.password,
    });
    if (!profile.ok) {
      return res.status(400).render("profile", {
        title: "个人资料",
        error: profile.error,
        phonePattern: PHONE_PATTERN_SOURCE,
        profile: {
          ...user,
          nickname: typeof req.body.nickname === "string" ? req.body.nickname : "",
          grade: req.body.grade,
          className: typeof req.body.className === "string" ? req.body.className : "",
          phone: typeof req.body.phone === "string" ? req.body.phone : "",
        },
      });
    }

    const updateData: Partial<typeof users.$inferInsert> = {
      nickname: profile.value.nickname,
      grade: profile.value.grade,
      className: profile.value.className,
      phone: profile.value.phone,
    };
    if (profile.value.password) {
      updateData.password = bcryptjs.hashSync(profile.value.password, 10);
    }

    await db.transaction(async (tx) => {
      await tx.update(users).set(updateData).where(eq(users.id, user.id));
      await removeUserIneligibleSelections(tx, user.id, profile.value.grade);
    });

    res.redirect("/courses");
  } catch (err) {
    next(err);
  }
});

export default router;
