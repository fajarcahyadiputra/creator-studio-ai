import type { JobStatus } from "../../generated/prisma/enums.js";

const transitions: Readonly<Record<JobStatus, ReadonlySet<JobStatus>>> = {
  DRAFT: new Set(["UPLOADING", "QUEUED", "CANCELED"]),
  UPLOADING: new Set(["QUEUED", "FAILED", "CANCEL_REQUESTED"]),
  QUEUED: new Set(["RUNNING", "FAILED", "CANCEL_REQUESTED"]),
  RUNNING: new Set([
    "PAUSE_REQUESTED",
    "CANCEL_REQUESTED",
    "FAILED",
    "COMPLETED",
    "PARTIALLY_COMPLETED",
    "NEEDS_REVIEW"
  ]),
  PAUSE_REQUESTED: new Set(["PAUSED", "FAILED", "CANCEL_REQUESTED"]),
  PAUSED: new Set(["QUEUED", "CANCEL_REQUESTED"]),
  CANCEL_REQUESTED: new Set(["CANCELED", "FAILED"]),
  CANCELED: new Set([]),
  FAILED: new Set(["QUEUED", "CANCELED"]),
  COMPLETED: new Set([]),
  PARTIALLY_COMPLETED: new Set([]),
  NEEDS_REVIEW: new Set(["QUEUED", "COMPLETED", "PARTIALLY_COMPLETED"])
};

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return transitions[from].has(to);
}

export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid job status transition: ${from} -> ${to}`);
  }
}
