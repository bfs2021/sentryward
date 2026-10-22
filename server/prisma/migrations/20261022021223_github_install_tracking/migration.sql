-- AlterTable
ALTER TABLE "forge_connections" ADD COLUMN     "account_id" TEXT;

-- AlterTable
ALTER TABLE "repositories" ADD COLUMN     "access_lost_at" TIMESTAMPTZ;

-- CreateIndex
CREATE UNIQUE INDEX "forge_connections_workspace_id_installation_id_key" ON "forge_connections"("workspace_id", "installation_id");
