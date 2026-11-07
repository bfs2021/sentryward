import { z } from "zod";

export const registerSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(100),
    email: z.string().trim().toLowerCase().email("Invalid email address"),
    password: z.string().min(8, "Password must be at least 8 characters").max(128),
    confirmPassword: z.string(),
    // From an invite link; required when REGISTRATION_MODE is "invite".
    inviteToken: z.string().min(1).max(200).optional(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
});

export const inviteTokenParamsSchema = z.object({
  token: z.string().min(1).max(200),
});

export const resetTokenParamsSchema = inviteTokenParamsSchema;

export const passwordResetRequestSchema = z.object({
  email: z.string().trim().toLowerCase().email("Invalid email address"),
});

export const passwordResetSchema = z
  .object({
    password: z.string().min(8, "Password must be at least 8 characters").max(128),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

export const signInProviderParamsSchema = z.object({ provider: z.string().min(1).max(50) });

// `link` attaches the provider to the signed-in account; `login` signs in or
// signs up. The invite is passed through to an invite-only registration.
export const signInStartSchema = z.object({
  intent: z.enum(["login", "link"]).default("login"),
  invite: z.string().min(1).max(200).optional(),
});

// Loose on purpose: a malformed callback still redirects with an error rather
// than answering JSON to a browser navigation.
export const signInCallbackSchema = z.object({
  state: z.string().max(200).optional(),
  code: z.string().max(2000).optional(),
  error: z.string().max(200).optional(),
});
