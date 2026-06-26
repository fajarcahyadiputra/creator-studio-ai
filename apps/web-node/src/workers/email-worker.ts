import { Worker } from "bullmq";
import nodemailer from "nodemailer";
import { env } from "../config/env.js";
import { bullRedisOptions } from "../infrastructure/queue/redis-options.js";
import type { EmailJob } from "../infrastructure/queue/email-queue.js";
import { logger } from "../shared/logging/logger.js";

const transporter = nodemailer.createTransport({
  host: env.SMTP_HOST,
  port: env.SMTP_PORT,
  secure: env.SMTP_SECURE,
  auth: env.SMTP_USER && env.SMTP_PASSWORD ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined
});

const worker = new Worker<EmailJob>(
  "email",
  async (job) => {
    await transporter.sendMail({
      from: env.SMTP_FROM,
      to: job.data.to,
      subject: job.data.subject,
      text: job.data.text,
      html: job.data.html
    });
    logger.info({ jobId: job.id, emailType: job.name }, "Email delivered");
  },
  { connection: bullRedisOptions(), concurrency: 5 }
);

worker.on("failed", (job, error) => {
  logger.error({ jobId: job?.id, err: error }, "Email job failed");
});
worker.on("error", (error) => logger.error({ err: error }, "Email worker error"));

async function shutdown(): Promise<void> {
  logger.info("Email worker draining");
  await worker.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
