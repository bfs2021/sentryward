import { createHash, randomBytes } from "node:crypto";

// For single-use links (invites, password resets): the raw token goes in the
// link and only its hash is stored, so a database leak exposes no usable link.
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
