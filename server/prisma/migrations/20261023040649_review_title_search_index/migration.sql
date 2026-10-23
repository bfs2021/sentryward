-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- CreateIndex
CREATE INDEX "repositories_full_path_idx" ON "repositories" USING GIN ("full_path" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "review_jobs_title_idx" ON "review_jobs" USING GIN ("title" gin_trgm_ops);
