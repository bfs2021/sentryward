import { env } from "../config/env.ts";
import { HttpError } from "../lib/httpError.ts";
import { mailer } from "../lib/mailer.ts";
import { hashPassword } from "../lib/password.ts";
import { prisma } from "../lib/prisma.ts";
import { hashToken, newToken } from "../lib/tokens.ts";
import type { PasswordReset, Prisma } from "../generated/prisma/client.ts";

// An emailed link only has to survive until the user checks their inbox. An
// admin's link is passed on by hand, which can take longer.
export const EMAILED_RESET_TTL_MS = 60 * 60 * 1000;
export const ADMIN_RESET_TTL_MS = 24 * 60 * 60 * 1000;

export function resetLink(token: string): string {
  return `${env.CLIENT_ORIGIN}/reset-password/${token}`;
}

// Issuing a link replaces any earlier unused one, so only the newest works. The
// raw token exists only in the returned link.
export async function createPasswordReset(userId: string, options: { ttlMs: number; createdById?: string }) {
  const token = newToken();
  const expiresAt = new Date(Date.now() + options.ttlMs);
  await prisma.$transaction([
    prisma.passwordReset.deleteMany({ where: { userId, usedAt: null } }),
    prisma.passwordReset.create({
      data: { tokenHash: hashToken(token), userId, createdById: options.createdById ?? null, expiresAt },
    }),
  ]);
  return { link: resetLink(token), expiresAt };
}

// The caller answers the same way whatever happens here, so nothing reveals
// whether the email has an account. The email is sent in the background for
// the same reason: waiting on SMTP only for known addresses would show in the
// response time.
export async function requestPasswordReset(email: string): Promise<void> {
  if (!mailer.configured()) return;
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true, email: true } });
  if (!user) return;

  const { link } = await createPasswordReset(user.id, { ttlMs: EMAILED_RESET_TTL_MS });
  mailer
    .send({
      to: user.email,
      subject: "Reset your Sentryward password",
      text:
        `Someone asked to reset the password for your Sentryward account.\n\n` +
        `Set a new password: ${link}\n\n` +
        `This link expires in 1 hour and works once. If you didn't ask for this, you can ignore this email.`,
    })
    .catch((err: unknown) => console.warn(`Could not email a password reset to user ${user.id}`, err));
}

export async function findValidReset(
  token: string,
  db: Prisma.TransactionClient = prisma,
): Promise<PasswordReset | null> {
  return db.passwordReset.findFirst({
    where: { tokenHash: hashToken(token), usedAt: null, expiresAt: { gt: new Date() } },
  });
}

// Sets the new password and bumps the session version in one transaction, so
// every existing session ends with the reset. The guarded update makes two
// concurrent uses of one link race to a single winner, and the expiry guard
// makes a link that expired since the lookup lose too.
export async function completePasswordReset(token: string, password: string) {
  const passwordHash = await hashPassword(password);
  return prisma.$transaction(async (tx) => {
    const reset = await findValidReset(token, tx);
    const { count } = reset
      ? await tx.passwordReset.updateMany({
          where: { id: reset.id, usedAt: null, expiresAt: { gt: new Date() } },
          data: { usedAt: new Date() },
        })
      : { count: 0 };
    if (!reset || count === 0) {
      throw new HttpError(400, "This reset link is invalid or has expired");
    }
    await tx.passwordReset.deleteMany({ where: { userId: reset.userId, id: { not: reset.id } } });
    return tx.user.update({
      where: { id: reset.userId },
      data: { passwordHash, sessionVersion: { increment: 1 } },
      select: { id: true, sessionVersion: true },
    });
  });
}
