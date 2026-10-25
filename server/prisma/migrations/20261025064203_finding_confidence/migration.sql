-- AlterTable
ALTER TABLE "findings" ADD COLUMN     "confidence" DOUBLE PRECISION;

-- Best-effort backfill from the run that last reported each finding. Tool and
-- rule findings carry a fixed confidence that no model reported, so they stay
-- null, as do rows whose run is gone or did not record the finding.
UPDATE "findings" f
SET "confidence" = (rf->>'confidence')::double precision
FROM "review_jobs" j, jsonb_array_elements(j."result"->'findings') rf
WHERE j."id" = f."last_job_id"
  AND rf->>'fingerprint' = f."fingerprint"
  AND rf->>'source' = 'llm'
  AND jsonb_typeof(rf->'confidence') = 'number';
