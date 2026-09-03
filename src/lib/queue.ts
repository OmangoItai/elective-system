import { Queue } from "bullmq";
import { redis, redisUrl } from "./redis";

export interface SelectionJobData {
  userId: number;
  courseId: number;
  now: string;
}

export const selectionQueue = new Queue<SelectionJobData>("selection", {
  connection: { url: redisUrl },
});

export async function addSelectionJob(data: SelectionJobData) {
  const job = await selectionQueue.add("select", data);
  return job.id;
}

export async function getJob(jobId: string) {
  return selectionQueue.getJob(jobId);
}

export async function closeQueue() {
  await selectionQueue.close();
  await redis.quit();
}
