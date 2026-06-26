ALTER TABLE "JobAttempt"
  ADD COLUMN "operationKey" VARCHAR(100),
  ADD COLUMN "idempotencyKey" VARCHAR(160);

UPDATE "JobAttempt" AS attempt
SET
  "operationKey" = CASE
    WHEN attempt."attemptNumber" = 1 THEN 'CREATE_AUTO_CLIP_JOB_ATTEMPT'
    ELSE 'LEGACY_RETRY_JOB_ATTEMPT'
  END,
  "idempotencyKey" = CASE
    WHEN attempt."attemptNumber" = 1 THEN job."idempotencyKey"
    ELSE gen_random_uuid()::text
  END
FROM "Job" AS job
WHERE job."id" = attempt."jobId";

ALTER TABLE "JobAttempt"
  ALTER COLUMN "operationKey" SET NOT NULL,
  ALTER COLUMN "idempotencyKey" SET NOT NULL;

CREATE UNIQUE INDEX "JobAttempt_jobId_operationKey_idempotencyKey_key"
  ON "JobAttempt" ("jobId", "operationKey", "idempotencyKey");
