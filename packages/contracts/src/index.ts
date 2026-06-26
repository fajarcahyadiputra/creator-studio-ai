export const JOB_STATUSES = [
  "DRAFT",
  "UPLOADING",
  "QUEUED",
  "RUNNING",
  "PAUSE_REQUESTED",
  "PAUSED",
  "CANCEL_REQUESTED",
  "CANCELED",
  "FAILED",
  "COMPLETED",
  "PARTIALLY_COMPLETED",
  "NEEDS_REVIEW"
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export interface JobProgressEvent {
  job_id: string;
  stage: string;
  stage_progress: number;
  overall_progress: number;
  message: string;
  occurred_at: string;
  metadata: Record<string, unknown>;
  status?: JobStatus;
}

export interface FoundationWorkflowInput {
  job_id: string;
  user_id: string;
  job_type: "AUTO_CLIPPING" | "TEXT_TO_SPEECH" | "TRANSCRIPTION";
  input_snapshot: Record<string, unknown>;
  callback_base_url: string;
  attempt_number: number;
}

export interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
    request_id: string;
    details: Record<string, unknown>;
  };
}
