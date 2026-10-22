-- AlterTable
ALTER TABLE "review_jobs" ADD COLUMN     "result_expired_at" TIMESTAMPTZ;

-- CreateIndex
CREATE INDEX "review_jobs_status_finished_at_idx" ON "review_jobs"("status", "finished_at");
