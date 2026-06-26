import { Queue } from "bullmq";
import { bullRedisOptions } from "./redis-options.js";

export interface EmailJob {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export const emailQueue = new Queue<EmailJob>("email", {
  connection: bullRedisOptions(),
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: 1000,
    removeOnFail: 5000
  }
});
