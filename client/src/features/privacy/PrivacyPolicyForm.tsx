import { useEffect } from "react"
import { Controller, useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import { z } from "zod"
import { TagInput } from "@/components/TagInput"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from "@/components/ui/field"
import { Switch } from "@/components/ui/switch"
import { TextField } from "@/features/auth/TextField"
import { applyServerErrors } from "@/features/auth/applyServerErrors"
import { PROVIDER_OPTIONS, type InstanceSettings, type PolicyLayer } from "./api"

// Days are typed as text so an empty box can mean "no limit".
const daysField = z
  .string()
  .trim()
  .refine((value) => value === "" || (/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 3650), {
    message: "Enter 1 to 3650 days, or leave empty",
  })

const policySchema = z.object({
  allowedProviders: z.array(z.enum(["anthropic", "openai", "google", "ollama"])),
  allowedHosts: z.array(z.string()),
  localOnly: z.boolean(),
  retentionDays: daysField,
  auditRetentionDays: daysField,
})
type PolicyInput = z.infer<typeof policySchema>

const toText = (days: number | null | undefined) => (days == null ? "" : String(days))
const toDays = (text: string) => (text.trim() === "" ? null : Number(text))

function toInput(values: PolicyLayer & { auditRetentionDays?: number | null }): PolicyInput {
  return {
    allowedProviders: values.allowedProviders,
    allowedHosts: values.allowedHosts,
    localOnly: values.localOnly,
    retentionDays: toText(values.retentionDays),
    auditRetentionDays: toText(values.auditRetentionDays),
  }
}

function list(values: string[], empty: string) {
  return values.length ? values.join(", ") : empty
}

// Edits one policy layer. The workspace form shows the instance's values it
// can only narrow; the instance form adds the audit log's retention.
export function PrivacyPolicyForm(props: {
  scope: "instance" | "workspace"
  values: PolicyLayer | InstanceSettings
  // The instance layer, shown read-only above the workspace's own fields.
  instance?: PolicyLayer
  // REVIEW_RETENTION_DAYS, used while the instance leaves retention unset.
  envRetentionDays?: number | null
  readOnly?: boolean
  onSave: (values: InstanceSettings) => Promise<unknown>
}) {
  const { scope, instance, readOnly } = props
  const form = useForm<PolicyInput>({ resolver: zodResolver(policySchema), defaultValues: toInput(props.values) })
  const { reset } = form
  // A save elsewhere (another tab, the instance page) refreshes the form.
  useEffect(() => reset(toInput(props.values)), [props.values, reset])

  async function onSubmit(values: PolicyInput) {
    try {
      await props.onSave({
        allowedProviders: values.allowedProviders,
        allowedHosts: values.allowedHosts,
        localOnly: values.localOnly,
        retentionDays: toDays(values.retentionDays),
        auditRetentionDays: toDays(values.auditRetentionDays),
      })
      toast.success("Privacy settings saved")
    } catch (error) {
      applyServerErrors(error, form.setError)
    }
  }

  const retentionHint =
    scope === "instance"
      ? props.envRetentionDays
        ? `Empty uses REVIEW_RETENTION_DAYS from the server environment (${props.envRetentionDays} days).`
        : "Empty keeps review data forever."
      : instance?.retentionDays
        ? `Empty follows the instance (${instance.retentionDays} days); a value can only be shorter.`
        : "Empty keeps review data forever."

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="flex flex-col gap-6">
      <FieldGroup>
        <Controller
          control={form.control}
          name="allowedProviders"
          render={({ field, fieldState }) => (
            <FieldSet data-invalid={fieldState.invalid}>
              <FieldLegend variant="label">Allowed providers</FieldLegend>
              <FieldDescription>
                None selected allows every provider.
                {instance && ` The instance allows: ${list(instance.allowedProviders, "every provider")}.`}
              </FieldDescription>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {PROVIDER_OPTIONS.map((option) => {
                  const id = `${scope}-provider-${option.value}`
                  const checked = field.value.includes(option.value)
                  return (
                    <FieldLabel key={option.value} htmlFor={id}>
                      <Field orientation="horizontal" data-disabled={readOnly}>
                        <Checkbox
                          id={id}
                          checked={checked}
                          disabled={readOnly}
                          onCheckedChange={(on) =>
                            field.onChange(
                              on === true
                                ? [...field.value, option.value]
                                : field.value.filter((value) => value !== option.value),
                            )
                          }
                        />
                        <FieldContent>
                          <FieldTitle>{option.label}</FieldTitle>
                        </FieldContent>
                      </Field>
                    </FieldLabel>
                  )
                })}
              </div>
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </FieldSet>
          )}
        />
        <Controller
          control={form.control}
          name="allowedHosts"
          render={({ field, fieldState }) => (
            <Field data-invalid={fieldState.invalid}>
              <FieldLabel htmlFor={`${scope}-hosts`}>Allowed hosts</FieldLabel>
              <TagInput
                id={`${scope}-hosts`}
                value={field.value}
                onChange={field.onChange}
                disabled={readOnly}
                placeholder="e.g. ollama.internal:11434, *.example.com, then Enter"
                aria-invalid={fieldState.invalid}
              />
              <FieldDescription>
                Where model requests may go. A host without a port matches any port; *.example.com matches hosts below
                it. Empty allows every host.
                {instance && ` The instance allows: ${list(instance.allowedHosts, "every host")}.`}
              </FieldDescription>
              {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
            </Field>
          )}
        />
        <Controller
          control={form.control}
          name="localOnly"
          render={({ field }) => {
            const locked = Boolean(instance?.localOnly)
            return (
              <Field orientation="horizontal">
                <FieldContent>
                  <FieldLabel htmlFor={`${scope}-local-only`}>Local only</FieldLabel>
                  <FieldDescription>
                    Only endpoints that resolve to private or loopback addresses, such as a self-hosted Ollama, may be
                    called. Official provider APIs are refused.
                    {locked && " Turned on for the whole instance."}
                  </FieldDescription>
                </FieldContent>
                <Switch
                  id={`${scope}-local-only`}
                  checked={locked || field.value}
                  onCheckedChange={field.onChange}
                  disabled={readOnly || locked}
                />
              </Field>
            )
          }}
        />
        <div>
          <TextField
            control={form.control}
            name="retentionDays"
            label="Review data retention (days)"
            inputMode="numeric"
            placeholder="No limit"
            disabled={readOnly}
          />
          <p className="mt-1.5 text-sm text-muted-foreground">
            Finished reviews older than this lose their stored result. Changes with no activity for this long also
            lose their findings and thread replies. {retentionHint}
          </p>
        </div>
        {scope === "instance" && (
          <div>
            <TextField
              control={form.control}
              name="auditRetentionDays"
              label="Audit log retention (days)"
              inputMode="numeric"
              placeholder="Keep forever"
              disabled={readOnly}
            />
            <p className="mt-1.5 text-sm text-muted-foreground">
              Applies to every workspace. Empty keeps the audit log forever.
            </p>
          </div>
        )}
      </FieldGroup>
      {!readOnly && (
        <div>
          <Button type="submit" disabled={form.formState.isSubmitting || !form.formState.isDirty}>
            {form.formState.isSubmitting && <Loader2 className="animate-spin" />}
            Save privacy settings
          </Button>
        </div>
      )}
    </form>
  )
}
