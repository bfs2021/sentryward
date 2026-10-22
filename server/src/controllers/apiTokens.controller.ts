import type { Request, Response } from "express";
import { apiTokenParamsSchema, createApiTokenSchema } from "../schemas/settings.schema.ts";
import { createApiToken, listApiTokens, revokeApiToken } from "../services/apiTokens.ts";

export async function listTokens(req: Request, res: Response) {
  res.json({ tokens: await listApiTokens(req.userId!) });
}

// The value is in this response only; afterwards just its hash exists.
export async function createToken(req: Request, res: Response) {
  const { name, expiresInDays } = createApiTokenSchema.parse(req.body);
  const { token, value } = await createApiToken(req.userId!, name, expiresInDays);
  res.status(201).json({ token, value });
}

export async function revokeToken(req: Request, res: Response) {
  const { id } = apiTokenParamsSchema.parse(req.params);
  await revokeApiToken(req.userId!, id);
  res.status(204).end();
}
