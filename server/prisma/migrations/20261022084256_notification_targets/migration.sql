-- CreateEnum
CREATE TYPE "notification_kind" AS ENUM ('webhook', 'slack', 'email');

-- CreateEnum
CREATE TYPE "notification_event" AS ENUM ('blocked', 'failed', 'completed');

-- AlterTable
ALTER TABLE "review_jobs" ADD COLUMN     "notified_at" TIMESTAMPTZ;

-- CreateTable
CREATE TABLE "notification_targets" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "kind" "notification_kind" NOT NULL,
    "name" TEXT NOT NULL,
    "events" "notification_event"[],
    "encrypted_url" TEXT,
    "encrypted_secret" TEXT,
    "recipient_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "notification_targets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notification_targets_workspace_id_idx" ON "notification_targets"("workspace_id");

-- AddForeignKey
ALTER TABLE "notification_targets" ADD CONSTRAINT "notification_targets_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
