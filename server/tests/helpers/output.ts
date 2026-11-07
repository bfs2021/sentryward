import type { ConfigOverride } from "../../src/review/config/schema.ts";

// The output switches the quiet defaults turn off. Tests about what a review
// posts layer these under their own settings, so every part of the output is
// exercised as before; a test about the defaults themselves leaves them out.
export const EVERY_OUTPUT = {
  postCheck: true,
  findingCounts: true,
  findingLifecycle: true,
  reviewStats: true,
  walkthroughLabels: true,
  sequenceDiagrams: true,
  estimateEffort: true,
  assessLinkedIssues: true,
  highLevelSummary: true,
} satisfies NonNullable<ConfigOverride["output"]>;
