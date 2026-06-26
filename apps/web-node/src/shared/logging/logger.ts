import pino from "pino";
import { env } from "../../config/env.js";

export const logger = pino({
  name: "web-node",
  level: env.LOG_LEVEL,
  base: { service: "web-node", environment: env.NODE_ENV },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    censor: "[REDACTED]",
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "request.headers.authorization",
      "request.headers.cookie",
      "password",
      "passwordHash",
      "apiKey",
      "accessToken",
      "refreshToken",
      "clientSecret",
      "token",
      "resetToken",
      "verificationToken",
      "signedUrl",
      "presignedUrl",
      "*.password",
      "*.passwordHash",
      "*.apiKey",
      "*.accessToken",
      "*.refreshToken",
      "*.token",
      "*.signedUrl",
      "*.presignedUrl"
    ]
  }
});

export type AppLogger = typeof logger;
