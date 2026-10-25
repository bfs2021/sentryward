import { z } from "zod";
import { dashboardOverrideSchema, REPOSITORY_ONLY_KEYS, type DashboardOverride } from "../review/config/schema.ts";
import { forgeProviderSchema } from "../review/core/models.ts";

// Replaces the global config as a whole; an empty object resets it to the
// profile and the defaults.
export const updateGlobalConfigSchema = z.object({
  settings: dashboardOverrideSchema,
});

// The display preview: `base` is what the form inherits (the profile and
// defaults, or the global config for a repository) and `settings` what the
// form sets on top, so the preview follows unsaved edits. `base` is a resolved
// config sent back as is, so it carries the keys only a repository file may
// set (REPOSITORY_ONLY_KEYS), which dashboard settings refuse; they never
// affect the preview, so they are dropped, not rejected.
const previewBaseSchema = dashboardOverrideSchema
  .extend(Object.fromEntries(Object.keys(REPOSITORY_ONLY_KEYS).map((key) => [key, z.unknown().optional()])))
  .transform((base): DashboardOverride => {
    const kept: Record<string, unknown> = { ...base };
    for (const key of Object.keys(REPOSITORY_ONLY_KEYS)) delete kept[key];
    return kept as DashboardOverride;
  });

export const configPreviewSchema = z.object({
  provider: forgeProviderSchema,
  base: previewBaseSchema,
  settings: dashboardOverrideSchema,
});
