import { parentPort, workerData } from "node:worker_threads";
import http from "node:http";
import { URL } from "node:url";

const { baseUrl, sessions, workerIndex, numWorkers, totalRequests, durationMs, courseId, concurrency } = workerData;

const targetUrl = new URL(`/api/courses/${courseId}/select`, baseUrl);

const agent = new http.Agent({ keepAlive: true, maxSockets: concurrency * 2 });

const results = [];

function makeRequest(cookie, csrf) {
  return new Promise((resolve) => {
    const start = performance.now();
    const req = http.request(
      targetUrl,
      {
        method: "POST",
        agent,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Cookie": cookie,
          "X-CSRF-Token": csrf,
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += chunk;
          if (body.length > 256) res.destroy();
        });
        res.on("end", () => {
          const latencyMs = performance.now() - start;
          resolve({ status: res.statusCode || 0, latencyMs, bodyPreview: body.slice(0, 120) });
        });
        res.on("error", (err) => {
          const latencyMs = performance.now() - start;
          resolve({ status: res.statusCode || 0, latencyMs, error: err.message });
        });
      }
    );
    req.on("error", (err) => {
      const latencyMs = performance.now() - start;
      resolve({ status: 0, latencyMs, error: err.message });
    });
    req.write("_csrf=" + encodeURIComponent(csrf));
    req.end();
  });
}

async function run() {
  const endTime = performance.now() + durationMs;
  const workerConcurrency = concurrency;
  let started = 0;
  let completed = 0;

  const sessionCount = sessions.length;
  const requestBudget = Math.ceil(totalRequests / numWorkers);

  async function sendLoop() {
    while (performance.now() < endTime && started < requestBudget) {
      const session = sessions[started % sessionCount];
      started++;
      makeRequest(session.cookie, session.csrf).then((r) => {
        results.push(r);
        completed++;
        if (completed % 1000 === 0) {
          parentPort?.postMessage({ type: "progress", completed, workerIndex });
        }
      });
      // Limit in-flight per worker
      while (started - completed >= workerConcurrency && performance.now() < endTime) {
        await new Promise((r) => setImmediate(r));
      }
    }
  }

  // Run the sender and wait for all in-flight to complete
  await sendLoop();
  while (completed < started) {
    await new Promise((r) => setImmediate(r));
  }

  agent.destroy();
  parentPort?.postMessage({ type: "done", results, workerIndex, started, completed });
}

run();
