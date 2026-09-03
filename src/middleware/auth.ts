import { Request, Response, NextFunction } from "express";
import { db } from "../db/index";
import { users } from "../db/schema";
import { eq } from "drizzle-orm";

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session.userId) return res.redirect("/login");
  next();
}

export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  try {
    if (!req.session.userId) return res.redirect("/login");

    const userRows = await db.select({ isAdmin: users.isAdmin })
      .from(users)
      .where(eq(users.id, req.session.userId));
    const user = userRows[0];

    if (!user || !user.isAdmin) {
      req.session.isAdmin = 0;
      return res.redirect("/login");
    }
    next();
  } catch (err) {
    next(err);
  }
}
