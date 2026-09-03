import { eq } from "drizzle-orm";
import { config } from "../db/schema";
import { defaultEndTime, defaultStartTime } from "./time";

type ConfigClient = {
  select: (...args: any[]) => any;
};

const CONFIG_CACHE_TTL_MS = Number(process.env.CONFIG_CACHE_TTL_MS || 5000);
const isProduction = process.env.NODE_ENV === "production";
const configCache = new Map<string, { value: string | undefined; expiresAt: number }>();

export function clearConfigCache(): void {
  configCache.clear();
}

export async function readConfig(client: ConfigClient, key: string): Promise<string | undefined> {
  if (isProduction) {
    const cached = configCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
  }

  const rows = await client.select({ value: config.value }).from(config).where(eq(config.key, key));
  const value = rows[0]?.value;

  if (isProduction) {
    configCache.set(key, { value, expiresAt: Date.now() + CONFIG_CACHE_TTL_MS });
  }

  return value;
}

export async function readStartTime(client: ConfigClient): Promise<string> {
  return (await readConfig(client, "start_time")) || defaultStartTime();
}

export async function readEndTime(client: ConfigClient): Promise<string> {
  return (await readConfig(client, "end_time")) || defaultEndTime();
}
