import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { z } from "zod"
import { Button } from "@/components/ui/button"
import { Field, FieldGroup } from "@/components/ui/field"
import { TextField } from "@/features/auth/TextField"
import { applyServerErrors } from "@/features/auth/applyServerErrors"
import { useChangePassword, type PasswordInput } from "./api"

// An account created through a sign-in provider has no current password to
// enter; the server only asks for one when the account has one.
function passwordSchema(hasPassword: boolean) {
  return z
    .object({
      currentPassword: z.string().optional(),
      newPassword: z.string().min(8, "Password must be at least 8 characters").max(128),
      confirmPassword: z.string(),
    })
    .refine((data) => !hasPassword || Boolean(data.currentPassword), {
      message: "Current password is required",
      path: ["currentPassword"],
    })
    .refine((data) => data.newPassword === data.confirmPassword, {
      message: "Passwords do not match",
      path: ["confirmPassword"],
    })
}

const EMPTY: PasswordInput = { currentPassword: "", newPassword: "", confirmPassword: "" }

export function PasswordForm({ hasPassword }: { hasPassword: boolean }) {
  const change = useChangePassword()
  const form = useForm<PasswordInput>({ resolver: zodResolver(passwordSchema(hasPassword)), defaultValues: EMPTY })

  async function onSubmit({ currentPassword, ...values }: PasswordInput) {
    try {
      await change.mutateAsync(hasPassword ? { currentPassword, ...values } : values)
      form.reset(EMPTY)
      toast.success(hasPassword ? "Password changed" : "Password set")
    } catch (error) {
      applyServerErrors(error, form.setError)
    }
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
      <FieldGroup>
        {hasPassword && (
          <TextField
            control={form.control}
            name="currentPassword"
            label="Current password"
            type="password"
            autoComplete="current-password"
            placeholder="Enter your current password"
          />
        )}
        <TextField
          control={form.control}
          name="newPassword"
          label="New password"
          type="password"
          autoComplete="new-password"
          placeholder="At least 8 characters"
        />
        <TextField
          control={form.control}
          name="confirmPassword"
          label="Confirm new password"
          type="password"
          autoComplete="new-password"
          placeholder="Repeat the new password"
        />
        <Field orientation="horizontal">
          <Button type="submit" disabled={form.formState.isSubmitting}>
            {form.formState.isSubmitting && <Loader2 className="animate-spin" />}
            {hasPassword ? "Change password" : "Set password"}
          </Button>
        </Field>
      </FieldGroup>
    </form>
  )
}
