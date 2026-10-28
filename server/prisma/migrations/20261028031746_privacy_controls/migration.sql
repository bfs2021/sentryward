-- CreateTable
CREATE TABLE "instance_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "allowed_providers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allowed_hosts" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "local_only" BOOLEAN NOT NULL DEFAULT false,
    "retention_days" INTEGER,
    "audit_retention_days" INTEGER,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "instance_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workspace_privacy" (
    "workspace_id" UUID NOT NULL,
    "allowed_providers" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allowed_hosts" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "local_only" BOOLEAN NOT NULL DEFAULT false,
    "retention_days" INTEGER,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "workspace_privacy_pkey" PRIMARY KEY ("workspace_id")
);

-- CreateTable
CREATE TABLE "llm_request_logs" (
    "id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "workspace_id" UUID,
    "workspace_name" TEXT NOT NULL,
    "repository_id" UUID,
    "repository" TEXT,
    "change_number" INTEGER,
    "job_id" UUID,
    "reply_id" UUID,
    "user_id" UUID,
    "purpose" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "cached_input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "reasoning_tokens" INTEGER NOT NULL DEFAULT 0,
    "latency_ms" INTEGER NOT NULL DEFAULT 0,
    "outcome" TEXT NOT NULL,
    "error_kind" TEXT,

    CONSTRAINT "llm_request_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "llm_request_logs_workspace_id_created_at_idx" ON "llm_request_logs"("workspace_id", "created_at");

-- CreateIndex
CREATE INDEX "llm_request_logs_created_at_idx" ON "llm_request_logs"("created_at");

-- AddForeignKey
ALTER TABLE "workspace_privacy" ADD CONSTRAINT "workspace_privacy_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "llm_request_logs" ADD CONSTRAINT "llm_request_logs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "llm_request_logs" ADD CONSTRAINT "llm_request_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A single row of instance-wide settings.
ALTER TABLE "instance_settings" ADD CONSTRAINT "instance_settings_singleton" CHECK ("id" = 1);
