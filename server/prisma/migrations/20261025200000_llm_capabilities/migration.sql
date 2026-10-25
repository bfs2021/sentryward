-- CreateTable
CREATE TABLE "llm_capabilities" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "thinking" TEXT,
    "tools" BOOLEAN,
    "source" TEXT NOT NULL,
    "detail" TEXT,
    "checked_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "llm_capabilities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "llm_capabilities_workspace_id_provider_endpoint_model_key" ON "llm_capabilities"("workspace_id", "provider", "endpoint", "model");

-- AddForeignKey
ALTER TABLE "llm_capabilities" ADD CONSTRAINT "llm_capabilities_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;

