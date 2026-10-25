import { z } from "zod";
import { dashboardOverrideSchema } from "../review/config/schema.ts";
import { forgeProviderSchema } from "../review/core/models.ts";

// Replaces the global config as a whole; an empty object resets it to the
// profile and the defaults.
export const updateGlobalConfigSchema = z.object({
  settings: dashboardOverrideSchema,
});

// The display preview: `base` is what the form inherits (the profile and
// defaults, or the global config for a repository) and `settings` what the
// form sets on top, so the preview follows unsaved edits. `base` is a resolved
// config sent back as is, so it carries `rules`, which dashboard settings
// refuse; they never affect the preview, so they are dropped, not rejected.
export const configPreviewSchema = z.object({
  provider: forgeProviderSchema,
  base: dashboardOverrideSchema
    .extend({ rules: z.array(z.unknown()).optional() })
    .transform(({ rules: _rules, ...base }) => base),
  settings: dashboardOverrideSchema,
});
