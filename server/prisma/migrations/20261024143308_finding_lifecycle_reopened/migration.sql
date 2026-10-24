-- AlterEnum
ALTER TYPE "finding_lifecycle" ADD VALUE 'reopened';

-- AlterTable
ALTER TABLE "findings" ADD COLUMN     "end_line" INTEGER;
