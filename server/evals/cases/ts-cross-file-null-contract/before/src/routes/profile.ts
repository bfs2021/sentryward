import type { Request, Response } from "express";
import { findUser } from "../users/repository.ts";

export async function showProfile(req: Request, res: Response) {
  const user = await findUser(req.params.id);
  res.json({ name: user.name, email: user.email });
}
