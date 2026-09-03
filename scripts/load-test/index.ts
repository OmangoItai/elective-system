import { Worker } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import bcryptjs from "bcryptjs";
import { Pool } from "pg";
import Redis from "ioredis";
import { selectionQueue } from "../../src/lib/queue";
import { redis as appRedis, queueRedis } from "../../src/lib/redis";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DATABASE_URL = process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/elective";
const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";
const SESSION_SECRET = process.env.SESSION_SECRET || "elective-system-load-test-secret-2026-09-03";
const BASE_URL = process.env.BASE_URL || "http://localhost:8080";

const NUM_USERS = Number(process.env.NUM_USERS || 50000);
const COURSE_SEATS = Number(process.env.COURSE_SEATS || 1000);
const DURATION_MS = Number(process.env.DURATION_MS || 10000);
const TOTAL_REQUESTS = Number(process.env.TOTAL_REQUESTS || 400000);
const NUM_WORKERS = Number(process.env.NUM_WORKERS || 8);
const WORKER_CONCURRENCY = Number(process.env.WORKER_CONCURRENCY || 300);

function signSessionId(val: string, secret: string): string {
  const sig = crypto.createHmac("sha256", secret).update(val).digest("base64").replace(/=+$/, "");
  return `${val}.${sig}`;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function setup() {
  console.log("Connecting to PostgreSQL and Redis...");
  const pool = new Pool({ connectionString: DATABASE_URL });
  const redis = new Redis(REDIS_URL);

  try {
    // Clean previous test data
    await pool.query(`DELETE FROM selections WHERE user_id > 1`);
    await pool.query(`DELETE FROM access_users`);
    await pool.query(`DELETE FROM access`);
    await pool.query(`DELETE FROM courses WHERE id = 1`);
    await pool.query(`DELETE FROM users WHERE id > 1`);
    await pool.query(`DELETE FROM config WHERE key IN ('start_time', 'end_time', 'max_selections')`);

    // Flush any stale jobs from previous runs
    await selectionQueue.drain();
    await selectionQueue.clean(0, 0, "failed");
    await selectionQueue.clean(0, 0, "completed");

    // Reset admin password
    const adminHash = bcryptjs.hashSync("123", 10);
    await pool.query(
      `INSERT INTO users (id, username, nickname, password, is_admin) VALUES (1, 'admin', '管理员', $1, 1)
       ON CONFLICT (id) DO UPDATE SET password = EXCLUDED.password`,
      [adminHash]
    );

    console.log(`Inserting ${NUM_USERS} test students...`);
    const batchSize = 1000;
    const studentHash = bcryptjs.hashSync("123", 10);
    for (let batch = 0; batch < NUM_USERS / batchSize; batch++) {
      const values: string[] = [];
      const params: (string | number)[] = [];
      for (let i = 0; i < batchSize; i++) {
        const id = 2 + batch * batchSize + i;
        values.push(`($${params.length + 1}, $${params.length + 2}, $${params.length + 3}, $${params.length + 4}, $${params.length + 5}, $${params.length + 6}, $${params.length + 7}, $${params.length + 8})`);
        params.push(id, `loadtest${id}`, `学生${id}`, studentHash, 0, 2024, `班级${(id % 10) + 1}`, `1380000${String(id).padStart(5, '0')}`);
      }
      await pool.query(
        `INSERT INTO users (id, username, nickname, password, is_admin, grade, class_name, phone) VALUES ${values.join(", ")} ON CONFLICT (id) DO NOTHING`,
        params
      );
      process.stdout.write(".");
    }
    console.log("\nStudents inserted.");

    console.log("Creating test course...");
    const now = new Date();
    const openTime = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 19);
    const startTime = new Date(now.getTime() - 60 * 60 * 1000).toISOString().slice(0, 19);
    const endTime = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 19);

    await pool.query(
      `INSERT INTO courses (id, name, teacher, description, total_seats, available_seats, open_time, allowed_grades)
       VALUES (1, 'Load Test Course', 'Test Teacher', 'Load test', $1, $1, $2, '2024,2025,2026')
       ON CONFLICT (id) DO UPDATE SET total_seats = EXCLUDED.total_seats, available_seats = EXCLUDED.available_seats, open_time = EXCLUDED.open_time`,
      [COURSE_SEATS, openTime]
    );

    await pool.query(
      `INSERT INTO config (key, value) VALUES ('start_time', $1), ('end_time', $2), ('max_selections', '1')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [startTime, endTime]
    );

    console.log("Creating Redis sessions...");
    const sessions: Array<{ sid: string; cookie: string; csrf: string; userId: number }> = [];
    const pipeline = redis.pipeline();
    for (let i = 0; i < NUM_USERS; i++) {
      const userId = 2 + i;
      const sid = crypto.randomUUID();
      const csrf = crypto.randomBytes(32).toString("hex");
      const signed = signSessionId(sid, SESSION_SECRET);
      const cookie = `connect.sid=s%3A${encodeURIComponent(signed)}`;
      sessions.push({ sid, cookie, csrf, userId });
      const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      pipeline.set(
        `sess:${sid}`,
        JSON.stringify({
          userId,
          isAdmin: false,
          csrfToken: csrf,
          cookie: {
            originalMaxAge: 7 * 24 * 60 * 60 * 1000,
            expires,
            httpOnly: true,
            sameSite: "lax",
            secure: false,
            path: "/",
          },
        })
      );
    }
    await pipeline.exec();
    console.log(`Created ${sessions.length} sessions.`);

    return { pool, redis, sessions };
  } catch (err) {
    await pool.end();
    await redis.quit();
    throw err;
  }
}

async function runLoadTest(sessions: Array<{ sid: string; cookie: string; csrf: string; userId: number }>) {
  console.log(`\nStarting load test: ${TOTAL_REQUESTS} requests over ${DURATION_MS}ms across ${NUM_WORKERS} workers`);
  console.log(`Target RPS: ${(TOTAL_REQUESTS / (DURATION_MS / 1000)).toFixed(0)}`);

  const perWorker = Math.ceil(sessions.length / NUM_WORKERS);
  const workers: Worker[] = [];
  const allResults: any[] = [];

  for (let w = 0; w < NUM_WORKERS; w++) {
    const workerSessions = sessions.slice(w * perWorker, (w + 1) * perWorker);
    if (workerSessions.length === 0) continue;

    const worker = new Worker(path.join(__dirname, "worker.js"), {
      workerData: {
        baseUrl: BASE_URL,
        sessions: workerSessions,
        workerIndex: w,
        numWorkers: NUM_WORKERS,
        totalRequests: TOTAL_REQUESTS,
        durationMs: DURATION_MS,
        courseId: 1,
        concurrency: WORKER_CONCURRENCY,
      },
    });

    worker.on("message", (msg) => {
      if (msg.type === "progress") {
        // console.log(`Worker ${msg.workerIndex}: ${msg.completed} completed`);
      } else if (msg.type === "done") {
        allResults.push(...msg.results);
      }
    });

    worker.on("error", (err) => console.error(`Worker ${w} error:`, err));
    workers.push(worker);
  }

  const start = performance.now();
  await Promise.all(
    workers.map(
      (w) =>
        new Promise<void>((resolve, reject) => {
          w.on("exit", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`Worker exited with code ${code}`));
          });
        })
    )
  );
  const elapsed = performance.now() - start;

  return { elapsed, results: allResults };
}

function analyze(results: any[]) {
  const total = results.length;
  const status200 = results.filter((r) => r.status === 200).length;
  const status400 = results.filter((r) => r.status === 400).length;
  const status403 = results.filter((r) => r.status === 403).length;
  const status500 = results.filter((r) => r.status >= 500).length;
  const errors = results.filter((r) => r.status === 0).length;
  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const p50 = latencies[Math.floor(latencies.length * 0.5)];
  const p95 = latencies[Math.floor(latencies.length * 0.95)];
  const p99 = latencies[Math.floor(latencies.length * 0.99)];
  const max = latencies[latencies.length - 1];

  return { total, status200, status400, status403, status500, errors, avg, p50, p95, p99, max };
}

async function verify(pool: Pool) {
  const selected = await pool.query(`SELECT COUNT(*) FROM selections WHERE course_id = 1`);
  const count = Number(selected.rows[0].count);
  const counts = await selectionQueue.getJobCounts();
  return { selectedCount: count, jobCounts: counts };
}

async function waitForQueueDrain(pool: Pool, targetSeats: number) {
  let lastCount = -1;
  let stableFor = 0;
  const start = performance.now();
  while (performance.now() - start < 120000) {
    const selected = await pool.query(`SELECT COUNT(*) FROM selections WHERE course_id = 1`);
    const count = Number(selected.rows[0].count);
    const counts = await selectionQueue.getJobCounts();
    const inFlight = (counts.waiting || 0) + (counts.active || 0) + (counts.paused || 0);
    console.log(`  drain check: selected=${count}, waiting=${counts.waiting}, active=${counts.active}, failed=${counts.failed}`);
    if (inFlight === 0 && count === targetSeats) return count;
    if (count === lastCount) {
      stableFor += 2000;
      if (stableFor >= 10000) return count;
    } else {
      stableFor = 0;
      lastCount = count;
    }
    await sleep(2000);
  }
  const final = await pool.query(`SELECT COUNT(*) FROM selections WHERE course_id = 1`);
  return Number(final.rows[0].count);
}

async function main() {
  const { pool, redis, sessions } = await setup();

  // Give app a moment to pick up fresh config if needed
  await sleep(500);

  const { elapsed, results } = await runLoadTest(sessions);
  const stats = analyze(results);

  console.log("\n=== Load Test Results ===");
  console.log(`Total requests:    ${stats.total}`);
  console.log(`Elapsed time:      ${(elapsed / 1000).toFixed(2)}s`);
  console.log(`Actual RPS:        ${(stats.total / (elapsed / 1000)).toFixed(0)}`);
  console.log(`Status 200:        ${stats.status200}`);
  console.log(`Status 400:        ${stats.status400}`);
  console.log(`Status 403:        ${stats.status403}`);
  console.log(`Status 500+:       ${stats.status500}`);
  console.log(`Network errors:    ${stats.errors}`);
  console.log(`Avg latency:       ${stats.avg.toFixed(2)}ms`);
  console.log(`P50 latency:       ${stats.p50.toFixed(2)}ms`);
  console.log(`P95 latency:       ${stats.p95.toFixed(2)}ms`);
  console.log(`P99 latency:       ${stats.p99.toFixed(2)}ms`);
  console.log(`Max latency:       ${stats.max.toFixed(2)}ms`);

  // Allow workers time to finish
  await sleep(3000);

  // Wait for the queue to drain and verify no oversell
  console.log("\nWaiting for BullMQ queue to drain...");
  const selectedCount = await waitForQueueDrain(pool, COURSE_SEATS);
  const { jobCounts } = await verify(pool);
  console.log("\n=== Verification ===");
  console.log(`Course seats:      ${COURSE_SEATS}`);
  console.log(`Selections count:  ${selectedCount}`);
  console.log(`Oversold:          ${selectedCount > COURSE_SEATS ? "YES" : "NO"}`);
  console.log(`Waiting jobs:      ${jobCounts.waiting}`);
  console.log(`Active jobs:       ${jobCounts.active}`);
  console.log(`Completed jobs:    ${jobCounts.completed}`);
  console.log(`Failed jobs:       ${jobCounts.failed}`);

  if (selectedCount > COURSE_SEATS) {
    console.error("\nFAIL: Oversold detected!");
    process.exitCode = 1;
  } else if (selectedCount === COURSE_SEATS) {
    console.log("\nOK: No oversell and all seats filled.");
  } else {
    console.log(`\nWARN: Only ${selectedCount}/${COURSE_SEATS} seats filled (expected when requests < seats or failures occurred).`);
  }

  await selectionQueue.close();
  await queueRedis.quit();
  await appRedis.quit();
  await pool.end();
  await redis.quit();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
