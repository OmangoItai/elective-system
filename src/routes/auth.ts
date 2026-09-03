import { Router, Request, Response } from "express";
import bcryptjs from "bcryptjs";
import { db } from "../db/index";
import { users } from "../db/schema";
import { eq } from "drizzle-orm";

const router = Router();

router.post("/api/login", async (req: Request, res: Response, next) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.render("login", { error: "请输入用户名和密码", title: "登录" });
    }

    const userRows = await db.select().from(users).where(eq(users.username, username));
    const user = userRows[0];

    if (!user || !bcryptjs.compareSync(password, user.password)) {
      return res.render("login", { error: "用户名或密码错误", title: "登录" });
    }

    req.session.regenerate((err) => {
      if (err) return res.status(500).send("登录失败");
      req.session.userId = user.id;
      req.session.isAdmin = user.isAdmin;
      req.session.save(() => {
        const redirectTo = user.isAdmin ? "/admin/courses" : user.phone ? "/courses" : "/profile";
        res.redirect(redirectTo);
      });
    });
  } catch (err) {
    next(err);
  }
});

router.post("/api/logout", (req: Request, res: Response) => {
  req.session.destroy(() => {
    res.redirect("/login");
  });
});

export default router;
