import { env } from "../config/env.ts";
import { HttpError } from "../lib/httpError.ts";
import { mailer } from "../lib/mailer.ts";
import { prisma } from "../lib/prisma.ts";
import { hashToken, newToken } from "../lib/tokens.ts";
import type { Invite, Prisma, WorkspaceRole } from "../generated/prisma/client.ts";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function inviteLink(token: string): string {
  return `${env.CLIENT_ORIGIN}/invite/${token}`;
}

export const publicInvite = {
  id: true,
  email: true,
  role: true,
  expiresAt: true,
  createdAt: true,
  invitedBy: { select: { name: true } },
} as const;

export interface CreateInviteInput {
  email?: string;
  invitedById: string;
  inviterName: string;
  // Absent for an instance invite, which only lets someone register.
  workspace?: { id: string; name: string; role: WorkspaceRole };
}

// The raw token exists only in this return value: the link is shown once and
// emailed, and the database keeps its hash.
export async function createInvite(input: CreateInviteInput) {
  const token = newToken();
  const invite = await prisma.invite.create({
    data: {
      tokenHash: hashToken(token),
      email: input.email ?? null,
      invitedById: input.invitedById,
      workspaceId: input.workspace?.id ?? null,
      role: input.workspace?.role ?? null,
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    },
    select: publicInvite,
  });
  const link = inviteLink(token);

  // A failed or skipped email never fails the invite: the link still works.
  let emailed = false;
  if (input.email && mailer.configured()) {
    try {
      await sendInviteEmail({ to: input.email, link, inviterName: input.inviterName, workspace: input.workspace });
      emailed = true;
    } catch (err) {
      console.warn(`Could not email invite ${invite.id}`, err);
    }
  }
  return { invite, link, emailed };
}

async function sendInviteEmail(input: {
  to: string;
  link: string;
  inviterName: string;
  workspace?: { name: string };
}): Promise<void> {
  const { to, link, inviterName, workspace } = input;
  await mailer.send({
    to,
    subject: workspace ? `Join ${workspace.name} on Sentryward` : "You're invited to Sentryward",
    text: workspace
      ? `${inviterName} invited you to the ${workspace.name} workspace on Sentryward.\n\nJoin: ${link}\n\nThis link expires in 7 days.`
      : `${inviterName} invited you to Sentryward.\n\nCreate your account: ${link}\n\nThis link expires in 7 days.`,
  });
}

// Only the token's hash is stored, so the old link cannot be sent again:
// resending issues a new token and renews the expiry, and the old link stops
// working. The email goes out before anything is saved, so a failed send
// leaves the invite exactly as it was. Without `workspace` only an instance
// invite matches, and with it only that team's, so neither route can reach
// the other's invites.
export async function resendInvite(id: string, inviterName: string, workspace?: { id: string; name: string }) {
  const existing = await prisma.invite.findFirst({
    where: { id, workspaceId: workspace?.id ?? null, acceptedAt: null },
  });
  if (!existing) {
    throw new HttpError(404, "Invite not found");
  }
  if (!existing.email) {
    throw new HttpError(400, "Only invites for a specific email can be resent");
  }
  if (!mailer.configured()) {
    throw new HttpError(409, "Email is not set up on this server");
  }

  const token = newToken();
  try {
    await sendInviteEmail({ to: existing.email, link: inviteLink(token), inviterName, workspace });
  } catch (err) {
    console.warn(`Could not resend invite ${id}`, err);
    throw new HttpError(502, "Could not send the email");
  }
  return prisma.invite.update({
    where: { id },
    data: { tokenHash: hashToken(token), expiresAt: new Date(Date.now() + INVITE_TTL_MS) },
    select: publicInvite,
  });
}

export async function findValidInvite(token: string, db: Prisma.TransactionClient = prisma): Promise<Invite | null> {
  return db.invite.findFirst({
    where: { tokenHash: hashToken(token), acceptedAt: null, expiresAt: { gt: new Date() } },
  });
}

// Marks the invite used inside the caller's transaction. The acceptedAt guard
// makes two concurrent registrations with one token race to a single winner,
// and the token and expiry guards make a resend or expiry since the lookup
// lose too.
export async function consumeInvite(tx: Prisma.TransactionClient, invite: Invite): Promise<void> {
  const { count } = await tx.invite.updateMany({
    where: { id: invite.id, tokenHash: invite.tokenHash, acceptedAt: null, expiresAt: { gt: new Date() } },
    data: { acceptedAt: new Date() },
  });
  if (count === 0) {
    throw new HttpError(400, "This invite is invalid or has expired");
  }
}

export function assertInviteEmail(invite: Invite, email: string): void {
  if (invite.email && invite.email.toLowerCase() !== email.toLowerCase()) {
    throw new HttpError(400, "Validation failed", { email: ["This invite is for a different email address"] });
  }
}

// Spends a workspace invite on `userId` inside the caller's transaction.
export async function joinWorkspace(tx: Prisma.TransactionClient, invite: Invite, userId: string): Promise<void> {
  if (!invite.workspaceId || !invite.role) {
    throw new HttpError(400, "This invite is not for a workspace");
  }
  const existing = await tx.membership.findUnique({
    where: { userId_workspaceId: { userId, workspaceId: invite.workspaceId } },
  });
  if (existing) {
    throw new HttpError(409, "You are already a member of this workspace");
  }
  await consumeInvite(tx, invite);
  await tx.membership.create({ data: { userId, workspaceId: invite.workspaceId, role: invite.role } });
}
