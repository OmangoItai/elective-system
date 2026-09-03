import Redis from "ioredis";
import { createClient } from "redis";

export const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
export const redis = new Redis(redisUrl);

export const sessionRedis = createClient({ url: redisUrl });
sessionRedis.on("error", (error) => console.error("Redis session client error", error));
await sessionRedis.connect();
