-- CreateEnum
CREATE TYPE "finding_lifecycle" AS ENUM ('new', 'still_open', 'fixed', 'invalidated');

-- AlterTable
ALTER TABLE "findings" ADD COLUMN     "lifecycle" "finding_lifecycle" NOT NULL DEFAULT 'new';

-- Existing rows: resolved ones were all taken as fixed (no run told a fix from
-- a refactor yet), and a finding seen by more than one run is still open.
UPDATE "findings" SET "lifecycle" = 'fixed' WHERE "state" = 'resolved';
UPDATE "findings" SET "lifecycle" = 'still_open' WHERE "state" <> 'resolved' AND "last_seen_at" > "first_seen_at";

-- CreateIndex
CREATE INDEX "findings_repository_id_lifecycle_idx" ON "findings"("repository_id", "lifecycle");
