import { z } from "zod";
import { USAGE_PERIODS } from "../services/usage.ts";

export const usageQuerySchema = z.object({
  period: z.enum(USAGE_PERIODS).default("7d"),
  repoId: z.uuid().optional(),
});
