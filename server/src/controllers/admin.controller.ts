import type { Request, Response } from "express";
import { HttpError } from "../lib/httpError.ts";
import { prisma } from "../lib/prisma.ts";
import { assertAnotherAdminRemains } from "../services/admins.ts";
import { createInvite, publicInvite, resendInvite } from "../services/invites.ts";
import { ADMIN_RESET_TTL_MS, createPasswordReset } from "../services/passwordResets.ts";
import { assertEmailAvailable, emailTaken, isUniqueViolation } from "../services/users.ts";
import { releaseWorkspaces } from "../services/workspaces.ts";
import type { Prisma } from "../generated/prisma/client.ts";
import {
  createInviteSchema,
  idParamsSchema,
  listUsersQuerySchema,
  updateUserSchema,
} from "../schemas/admin.schema.ts";
import { publicUser } from "./auth.controller.ts";

export async function listUsers(req: Request, res: Response) {
  const { role, q, sort, dir, page, limit } = listUsersQuerySchema.parse(req.query);
  const where: Prisma.UserWhereInput = role ? { role } : {};
  if (q) {
    where.OR = [
      { name: { contains: q, mode: "insensitive" } },
      { email: { contains: q, mode: "insensitive" } },
    ];
  }
  const [users, total] = await prisma.$transaction([
    prisma.user.findMany({
      where,
      // The id tiebreak keeps rows from shifting between pages when values collide.
      orderBy: [{ [sort]: dir }, { id: "asc" }],
      skip: (page - 1) * limit,
      take: limit,
      select: publicUser,
    }),
    prisma.user.count({ where }),
  ]);
  res.json({ users, total, page, limit });
}

export async function updateUser(req: Request, res: Response) {
  const { id } = idParamsSchema.parse(req.params);
  const data = updateUserSchema.parse(req.body);

  try {
    const user = await prisma.$transaction(async (tx) => {
      const target = await tx.user.findUnique({ where: { id }, select: { role: true } });
      if (!target) {
        throw new HttpError(404, "User not found");
      }
      // A name or email edit leaves the role alone, so only an explicit demotion is checked.
      if (target.role === "admin" && data.role !== undefined && data.role !== "admin") {
        await assertAnotherAdminRemains(tx, id);
      }
      if (data.email) {
        await assertEmailAvailable(tx, data.email, id);
      }
      return tx.user.update({ where: { id }, data, select: publicUser });
    });
    res.json({ user });
  } catch (error) {
    // Another account claimed the email between the check and the update.
    if (isUniqueViolation(error)) {
      throw emailTaken();
    }
    throw error;
  }
}

// Removing yourself goes through account deletion in settings, which asks for
// the password; this route is for removing other people.
export async function deleteUser(req: Request, res: Response) {
  const { id } = idParamsSchema.parse(req.params);
  if (id === req.userId) {
    throw new HttpError(400, "Delete your own account from Settings");
  }

  await prisma.$transaction(async (tx) => {
    const target = await tx.user.findUnique({ where: { id }, select: { role: true } });
    if (!target) {
      throw new HttpError(404, "User not found");
    }
    if (target.role === "admin") {
      await assertAnotherAdminRemains(tx, id);
    }
    await releaseWorkspaces(tx, id, { promoteSuccessor: true });
    await tx.user.delete({ where: { id } });
  });
  res.status(204).end();
}

// For someone locked out, whether or not mail is set up: the admin hands the
// link over. It is shown once, and the user's sessions only end when it is used.
// Your own password changes in Settings, behind the current password.
export async function postPasswordReset(req: Request, res: Response) {
  const { id } = idParamsSchema.parse(req.params);
  if (id === req.userId) {
    throw new HttpError(400, "Change your own password from Settings");
  }
  const user = await prisma.user.findUnique({ where: { id }, select: { id: true } });
  if (!user) {
    throw new HttpError(404, "User not found");
  }
  const result = await createPasswordReset(user.id, { ttlMs: ADMIN_RESET_TTL_MS, createdById: req.userId! });
  res.status(201).json(result);
}

export async function listInvites(_req: Request, res: Response) {
  const invites = await prisma.invite.findMany({
    // Team invites are managed by each workspace.
    where: { workspaceId: null, acceptedAt: null, expiresAt: { gt: new Date() } },
    select: publicInvite,
    orderBy: { createdAt: "desc" },
  });
  res.json({ invites });
}

export async function postInvite(req: Request, res: Response) {
  const { email } = createInviteSchema.parse(req.body);
  if (email && (await prisma.user.findUnique({ where: { email } }))) {
    throw new HttpError(409, "Validation failed", { email: ["Someone with this email already has an account"] });
  }
  const inviter = await prisma.user.findUniqueOrThrow({ where: { id: req.userId }, select: { name: true } });
  const result = await createInvite({ email, invitedById: req.userId!, inviterName: inviter.name });
  res.status(201).json(result);
}

export async function postResendInvite(req: Request, res: Response) {
  const { id } = idParamsSchema.parse(req.params);
  const inviter = await prisma.user.findUniqueOrThrow({ where: { id: req.userId }, select: { name: true } });
  const invite = await resendInvite(id, inviter.name);
  res.json({ invite });
}

export async function revokeInvite(req: Request, res: Response) {
  const { id } = idParamsSchema.parse(req.params);
  const { count } = await prisma.invite.deleteMany({ where: { id, workspaceId: null, acceptedAt: null } });
  if (count === 0) {
    throw new HttpError(404, "Invite not found");
  }
  res.status(204).end();
}
