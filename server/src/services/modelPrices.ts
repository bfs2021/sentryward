import { prisma } from "../lib/prisma.ts";
import { priceFor, type ModelPrice, type PriceOverrides } from "../review/core/pricing/pricing.ts";
import { digestModels } from "./usage.ts";

// How far back the price list looks for models the workspace has used.
const RECENT_DAYS = 90;

const PRICE_FIELDS = { id: true, model: true, input: true, output: true, cached: true, cacheWrite: true, reasoning: true, updatedAt: true } as const;

function asPrice(row: { input: number; output: number; cached: number | null; cacheWrite: number | null; reasoning: number | null }): ModelPrice {
  return {
    input: row.input,
    output: row.output,
    ...(row.cached === null ? {} : { cached: row.cached }),
    ...(row.cacheWrite === null ? {} : { cacheWrite: row.cacheWrite }),
    ...(row.reasoning === null ? {} : { reasoning: row.reasoning }),
  };
}

export async function priceOverridesFor(workspaceId: string): Promise<PriceOverrides> {
  const rows = await prisma.modelPrice.findMany({ where: { workspaceId }, select: PRICE_FIELDS });
  return Object.fromEntries(rows.map((row) => [row.model, asPrice(row)]));
}

// The workspace's prices, and the models its recent reviews called with the
// price each would get without one (null: unknown), so an admin can see which
// models still need a price.
export async function listModelPrices(workspaceId: string, now = new Date()) {
  const [prices, jobs] = await Promise.all([
    prisma.modelPrice.findMany({ where: { workspaceId }, select: PRICE_FIELDS, orderBy: { model: "asc" } }),
    prisma.reviewJob.findMany({
      where: {
        repository: { connection: { workspaceId } },
        createdAt: { gte: new Date(now.getTime() - RECENT_DAYS * 86_400_000) },
        status: { notIn: ["superseded", "skipped", "cancelled"] },
      },
      select: { summary: true },
    }),
  ]);
  const used = new Set(jobs.flatMap((job) => digestModels(job.summary)));
  return {
    prices: prices.map(({ input, output, cached, cacheWrite, reasoning, ...rest }) => ({
      ...rest,
      price: asPrice({ input, output, cached, cacheWrite, reasoning }),
    })),
    models: [...used].sort().map((model) => ({ model, builtIn: priceFor(model) })),
  };
}
