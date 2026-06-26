import { createClient } from "redis";
import { env } from "../../config/env.js";
import { logger } from "../../shared/logging/logger.js";

export type RedisClient = ReturnType<typeof createClient>;

export function createRedisClient(): RedisClient {
  const client = createClient({ url: env.REDIS_URL });
  client.on("error", (error) => logger.error({ err: error }, "Redis client error"));
  return client;
}
