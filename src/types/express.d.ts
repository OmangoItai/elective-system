import "express-session";
import type { users } from "../db/schema";

declare module "express-session" {
  interface SessionData {
    userId: number;
    isAdmin: number;
    csrfToken: string;
    user?: typeof users.$inferSelect | null;
  }
}
