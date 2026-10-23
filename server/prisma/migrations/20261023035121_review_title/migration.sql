-- AlterTable
ALTER TABLE "review_jobs" ADD COLUMN     "title" TEXT;

-- Backfill from the summary digest so existing reviews are searchable by title.
UPDATE "review_jobs" SET "title" = "summary"->>'title' WHERE "summary" IS NOT NULL;
