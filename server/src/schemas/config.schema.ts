import { z } from "zod";
import { MAX_RULE_PATTERN_CHARS, MAX_RULES, dashboardOverrideSchema } from "../review/config/schema.ts";
import { forgeProviderSchema } from "../review/core/models.ts";

// Replaces the global config as a whole; an empty object resets it to the
// profile and the defaults.
export const updateGlobalConfigSchema = z.object({
  settings: dashboardOverrideSchema,
});

// The display preview: `base` is what the form inherits (the profile and
// defaults, or the global config for a repository) and `settings` what the
// form sets on top, so the preview follows unsaved edits. `base` is a resolved
// config sent back as is, which dashboard settings accept.
export const configPreviewSchema = z.object({
  provider: forgeProviderSchema,
  base: dashboardOverrideSchema,
  settings: dashboardOverrideSchema,
});

// The rule editor checks patterns as they are typed, against the same RE2 the
// worker compiles them with: the browser's own regex engine accepts
// lookarounds and backreferences that RE2 rejects.
export const checkRulePatternsSchema = z.object({
  patterns: z.array(z.string().max(MAX_RULE_PATTERN_CHARS)).max(MAX_RULES),
});
