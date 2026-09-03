import Redis from "ioredis";

export const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";

// Separate clients for session store and BullMQ so high-volume queue traffic
// cannot interfere with session I/O. BullMQ's blocking connections require
// maxRetriesPerRequest to be null.
export const redis = new Redis(redisUrl);
export const queueRedis = new Redis(redisUrl, { maxRetriesPerRequest: null });

function logRedisErrors(client: Redis, name: string) {
  client.on("error", (err: any) => {
    if (err.command) {
      console.error(`[${name}] Redis error on ${err.command}: ${err.message}`, err.args);
    } else {
      console.error(`[${name}] Redis error:`, err.message);
    }
  });
}

logRedisErrors(redis, "session");
logRedisErrors(queueRedis, "queue");
