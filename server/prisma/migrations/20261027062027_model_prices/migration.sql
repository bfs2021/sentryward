-- CreateTable
CREATE TABLE "model_prices" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "model" TEXT NOT NULL,
    "input" DOUBLE PRECISION NOT NULL,
    "output" DOUBLE PRECISION NOT NULL,
    "cached" DOUBLE PRECISION,
    "cache_write" DOUBLE PRECISION,
    "reasoning" DOUBLE PRECISION,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "model_prices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "model_prices_workspace_id_model_key" ON "model_prices"("workspace_id", "model");

-- AddForeignKey
ALTER TABLE "model_prices" ADD CONSTRAINT "model_prices_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
