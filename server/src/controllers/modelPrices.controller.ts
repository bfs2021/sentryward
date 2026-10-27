import type { Request, Response } from "express";
import { HttpError } from "../lib/httpError.ts";
import { prisma } from "../lib/prisma.ts";
import { modelPriceIdParamSchema, saveModelPriceSchema } from "../schemas/modelPrices.schema.ts";
import { listModelPrices } from "../services/modelPrices.ts";

export async function getModelPrices(req: Request, res: Response) {
  res.json(await listModelPrices(req.workspaceId!));
}

// Keyed by model, so saving a model's price again replaces it.
export async function saveModelPrice(req: Request, res: Response) {
  const { model, ...rates } = saveModelPriceSchema.parse(req.body);
  const data = {
    input: rates.input,
    output: rates.output,
    cached: rates.cached ?? null,
    cacheWrite: rates.cacheWrite ?? null,
    reasoning: rates.reasoning ?? null,
  };
  const workspaceId = req.workspaceId!;
  await prisma.modelPrice.upsert({
    where: { workspaceId_model: { workspaceId, model } },
    create: { workspaceId, model, ...data },
    update: data,
  });
  res.json(await listModelPrices(workspaceId));
}

export async function deleteModelPrice(req: Request, res: Response) {
  const { id } = modelPriceIdParamSchema.parse(req.params);
  const { count } = await prisma.modelPrice.deleteMany({ where: { id, workspaceId: req.workspaceId! } });
  if (!count) throw new HttpError(404, "Price not found");
  res.status(204).end();
}
