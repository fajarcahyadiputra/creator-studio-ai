-- A completed auto-clipping job cannot be successful when analysis produced
-- no candidate and the projection never created a renderable output.
UPDATE "Job" AS job
SET
  status = 'FAILED'::"JobStatus",
  "currentStage" = 'ANALYZING_CLIP_CANDIDATES',
  "progressPercent" = LEAST(job."progressPercent", 99),
  "updatedAt" = CURRENT_TIMESTAMP
WHERE job.type = 'AUTO_CLIPPING'::"JobType"
  AND job.status = 'COMPLETED'::"JobStatus"
  AND job."outputSummary"->>'candidate_count' = '0'
  AND NOT EXISTS (
    SELECT 1
    FROM "ClipOutput" AS output
    WHERE output."jobId" = job.id
      AND output."deletedAt" IS NULL
  );
