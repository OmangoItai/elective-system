import { Router, Request, Response } from "express";
import { eq, and, count, ne, or } from "drizzle-orm";
import bcryptjs from "bcryptjs";
import { db } from "../db/index";
import { users, selections, accessUsers } from "../db/schema";
import { requireAdmin } from "../middleware/auth";
import { parseRouteId } from "../utils/parse-id";
import { parseAccountInput } from "../services/account";
import { removeUserIneligibleSelections } from "../services/course-grade";
import { PHONE_PATTERN_SOURCE } from "../utils/phone";

const router = Router();

router.get("/admin/users", requireAdmin, async (_req: Request, res: Response, next) => {
  try {
    const admins = await db.select().from(users).where(eq(users.isAdmin, 1)).orderBy(users.id);

    res.render("admin-users", {
      title: "用户管理",
      admins,
      phonePattern: PHONE_PATTERN_SOURCE,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/api/admin/users/search", requireAdmin, async (req: Request, res: Response, next) => {
  try {
    const rawKeyword = req.query.keyword ?? req.query.username;
    if (!rawKeyword || typeof rawKeyword !== "string" || !rawKeyword.trim()) {
      return res.send(`<div class="px-6 py-4 text-sm text-gray-500">请输入用户名或昵称</div>`);
    }
    const keyword = rawKeyword.trim();

    const matches = await db.select().from(users)
      .where(and(
        eq(users.isAdmin, 0),
        or(eq(users.username, keyword), eq(users.nickname, keyword)),
      ))
      .orderBy(users.id);

    if (matches.length === 0) {
      return res.send(`<div class="px-6 py-4 text-sm text-red-500">未找到学生 "${escapeHtml(keyword)}"</div>`);
    }

    res.render("_user-search-results", {
      matches,
      phonePattern: PHONE_PATTERN_SOURCE,
      layout: false,
    });
  } catch (err) {
    next(err);
  }
});

router.post("/api/admin/users", requireAdmin, async (req: Request, res: Response, next) => {
  try {
    const { password, isAdmin } = req.body;
    if (typeof password !== "string" || password.length === 0 || password.length > 200) {
      return res.status(400).send("密码不能为空且不能超过200个字符");
    }

    const asAdmin = isAdmin === "1" || isAdmin === 1;
    const account = parseAccountInput({
      username: req.body.username,
      nickname: req.body.nickname,
      grade: req.body.grade,
      className: req.body.className,
      phone: req.body.phone,
      isAdmin: asAdmin,
    });
    if (!account.ok) return res.status(400).send(account.error);

    const existingRows = await db.select().from(users).where(eq(users.username, account.value.username));
    if (existingRows.length > 0) return res.status(400).send("用户名已被其他用户使用");

    const hash = bcryptjs.hashSync(password, 10);

    await db.insert(users).values({
      ...account.value,
      password: hash,
      isAdmin: asAdmin ? 1 : 0,
    });

    res.redirect("/admin/users");
  } catch (err) {
    next(err);
  }
});

router.put("/api/admin/users/:id", requireAdmin, async (req: Request, res: Response, next) => {
  try {
    const userId = parseRouteId(req.params.id);
    if (userId === null) return res.status(400).send("无效的用户ID");
    const { password, isAdmin } = req.body;

    const existingRows = await db.select().from(users).where(eq(users.id, userId));
    if (existingRows.length === 0) return res.status(404).send("用户不存在");
    const existing = existingRows[0];

    if (isAdmin !== undefined && isAdmin === "0" && userId === req.session.userId) {
      return res.status(400).send("不能取消自己的管理员权限");
    }

    if (existing.isAdmin && isAdmin !== undefined && (isAdmin === "0" || isAdmin === 0)) {
      const adminCountResult = await db.select({ count: count() }).from(users).where(eq(users.isAdmin, 1));
      const adminCount = adminCountResult[0].count;
      if (adminCount <= 1) {
        return res.status(400).send("不能移除最后一个管理员");
      }
    }

    const asAdmin = isAdmin === undefined
      ? Boolean(existing.isAdmin)
      : isAdmin === "1" || isAdmin === 1;
    const account = parseAccountInput({
      username: req.body.username ?? existing.username,
      nickname: req.body.nickname ?? existing.nickname,
      grade: req.body.grade ?? existing.grade,
      className: req.body.className ?? existing.className,
      phone: req.body.phone ?? existing.phone,
      isAdmin: asAdmin,
    });
    if (!account.ok) return res.status(400).send(account.error);

    const dupRows = await db.select().from(users)
      .where(and(eq(users.username, account.value.username), ne(users.id, userId)));
    if (dupRows.length > 0) {
      return res.status(400).send("用户名已被其他用户使用");
    }

    const updateData: Partial<typeof users.$inferInsert> = {
      ...account.value,
      isAdmin: asAdmin ? 1 : 0,
    };
    if (password !== undefined && password !== "") {
      if (typeof password !== "string" || password.length > 200) {
        return res.status(400).send("密码不能超过200个字符");
      }
      updateData.password = bcryptjs.hashSync(password, 10);
    }

    await db.transaction(async (tx) => {
      await tx.update(users).set(updateData).where(eq(users.id, userId));
      await removeUserIneligibleSelections(tx, userId, account.value.grade);
    });

    res.redirect("/admin/users");
  } catch (err) {
    next(err);
  }
});

router.delete("/api/admin/users/:id", requireAdmin, async (req: Request, res: Response, next) => {
  try {
    const userId = parseRouteId(req.params.id);
    if (userId === null) return res.status(400).send("无效的用户ID");

    if (userId === req.session.userId) {
      return res.status(400).send("不能删除自己的账户");
    }

    const existingRows = await db.select().from(users).where(eq(users.id, userId));
    if (existingRows.length === 0) return res.status(404).send("用户不存在");
    const existing = existingRows[0];

    if (existing.isAdmin) {
      const adminCountResult = await db.select({ count: count() }).from(users).where(eq(users.isAdmin, 1));
      const adminCount = adminCountResult[0].count;
      if (adminCount <= 1) {
        return res.status(400).send("不能移除最后一个管理员");
      }
    }

    await db.transaction(async (tx) => {
      await tx.delete(selections).where(eq(selections.userId, userId));
      await tx.delete(accessUsers).where(eq(accessUsers.userId, userId));
      await tx.delete(users).where(eq(users.id, userId));
    });

    res.status(200).send("OK");
  } catch (err) {
    next(err);
  }
});

export default router;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
