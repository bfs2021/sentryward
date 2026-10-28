import { z } from "zod";
import { PROVIDERS } from "../review/llm/providers.ts";
import { normalizeHostPattern } from "../services/privacyPolicy.ts";

// A hostname, optionally `*.`-prefixed for any host below it, or a bracketed
// IPv6 literal, with an optional port. No scheme or path survives normalizing.
const HOST_PATTERN = /^(?:(?:\*\.)?(?:[a-z0-9-]+\.)*[a-z0-9-]+|\[[0-9a-f:.]+\])(?::\d{1,5})?$/;

const hostPatternSchema = z
  .string()
  .max(253)
  .transform(normalizeHostPattern)
  .refine((value) => HOST_PATTERN.test(value), "Use a host name such as llm.internal, *.example.com or 10.0.0.5:11434");

const retentionSchema = z.number().int().min(1, "At least 1 day").max(3650, "At most 3650 days").nullable();

export const privacyLayerSchema = z.object({
  allowedProviders: z
    .array(z.enum(PROVIDERS))
    .max(PROVIDERS.length)
    .transform((values) => [...new Set(values)]),
  allowedHosts: z
    .array(hostPatternSchema)
    .max(50, "At most 50 hosts")
    .transform((values) => [...new Set(values)]),
  localOnly: z.boolean(),
  retentionDays: retentionSchema,
});

export const instanceSettingsSchema = privacyLayerSchema.extend({
  auditRetentionDays: retentionSchema,
});

const filters = {
  provider: z.enum(PROVIDERS).optional(),
  purpose: z.enum(["review", "walkthrough", "verify", "probe", "reply", "test"]).optional(),
  outcome: z.enum(["ok", "failed"]).optional(),
  q: z.string().trim().max(200).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
};

export const auditLogQuerySchema = z.object({
  ...filters,
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const auditExportQuerySchema = z.object({
  ...filters,
  format: z.enum(["csv", "json"]).default("csv"),
});

// Instance admins may narrow the instance-wide log to one workspace.
export const instanceAuditFilterSchema = z.object({ workspaceId: z.uuid().optional() });
