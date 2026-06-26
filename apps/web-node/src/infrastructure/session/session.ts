import { RedisStore } from "connect-redis";
import session from "express-session";
import type { RedisClient } from "../redis/client.js";
import { env } from "../../config/env.js";

export function createSessionMiddleware(redis: RedisClient) {
  return session({
    name: "creator.sid",
    store: new RedisStore({ client: redis, prefix: "creator:sess:" }),
    secret: env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: env.COOKIE_SECURE,
      sameSite: "lax",
      maxAge: env.SESSION_TTL_SECONDS * 1000
    }
  });
}
