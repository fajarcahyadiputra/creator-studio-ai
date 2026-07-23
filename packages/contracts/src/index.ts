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

export interface AutoClipCandidateSummary {
  candidate_id: string;
  start_seconds: number;
  end_seconds: number;
  duration_seconds: number;
  title: string;
  hook_text: string;
  ending_text: string;
  summary: string;
  why_it_works: string[];
  content_category: "debate" | "insight" | "story" | "reaction" | "humor" | "other";
  context_complete: boolean;
  safety_notes: string[];
  suggested_caption: string;
  suggested_cta: string;
  related_hashtags: string[];
  viral_hashtags: string[];
  suggested_hashtags: string[];
  thumbnail_text: string;
  speaker_ids: string[];
  scene_ids: string[];
  scores: Record<string, unknown>;
}

export interface AutoClipOutputSummary {
  analysis_version: string;
  source_summary: string;
  candidate_count: number;
  analyzer?: Record<string, unknown>;
  candidates: AutoClipCandidateSummary[];
}

export interface ClipOutputSummary {
  id: string;
  candidate_id: string;
  media_asset_id: string | null;
  version: number;
  quality_status: string;
  preview_object_key: string | null;
  final_object_key: string | null;
  metadata_object_key: string | null;
  thumbnail_object_key: string | null;
  render_settings: Record<string, unknown>;
  quality_report: Record<string, unknown>;
  duration_ms: string | null;
  width: number | null;
  height: number | null;
  created_at: string;
  updated_at: string;
}

export interface PersistedClipCandidateSummary {
  id: string;
  candidate_id: string;
  start_ms: string;
  end_ms: string;
  duration_ms: string;
  title: string;
  hook_text: string;
  ending_text: string;
  summary: string;
  why_it_works: unknown;
  content_category: string;
  score_breakdown: unknown;
  base_viral_score: unknown;
  final_viral_score: unknown;
  context_complete: boolean;
  safety_notes: unknown;
  metadata_suggestions: unknown;
  speaker_ids: unknown;
  scene_ids: unknown;
  analyzer_metadata: unknown;
  selected: boolean;
  rank: number | null;
  created_at: string;
  updated_at: string;
}

export interface JobOutputsEnvelope {
  job_id: string;
  status: JobStatus;
  candidate_count: number;
  clip_candidates: PersistedClipCandidateSummary[];
  output_summary: AutoClipOutputSummary | null;
  clip_outputs: ClipOutputSummary[];
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
