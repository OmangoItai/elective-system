import { eq } from "drizzle-orm";
import { config } from "../db/schema";
import { defaultEndTime, defaultStartTime } from "./time";

type ConfigClient = {
  select: (...args: any[]) => any;
};

export async function readConfig(client: ConfigClient, key: string): Promise<string | undefined> {
  const rows = await client.select({ value: config.value }).from(config).where(eq(config.key, key));
  return rows[0]?.value;
}

export async function readStartTime(client: ConfigClient): Promise<string> {
  return (await readConfig(client, "start_time")) || defaultStartTime();
}

export async function readEndTime(client: ConfigClient): Promise<string> {
  return (await readConfig(client, "end_time")) || defaultEndTime();
}
