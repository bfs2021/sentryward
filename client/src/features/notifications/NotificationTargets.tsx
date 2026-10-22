import { useState } from "react"
import { Controller, useForm, useWatch, type Control, type FieldValues, type Path } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { AlertTriangle, BellRing, Copy, Loader2, MoreHorizontal, Pencil, Plus, Send, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { z } from "zod"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { TextField } from "@/features/auth/TextField"
import { applyServerErrors } from "@/features/auth/applyServerErrors"
import { useAuth } from "@/features/auth/useAuth"
import { useMembers, type Member } from "@/features/workspaces/api"
import { copyToClipboard } from "@/lib/clipboard"
import {
  EVENT_OPTIONS,
  KIND_LABELS,
  useCreateNotificationTarget,
  useDeleteNotificationTarget,
  useNotificationTargets,
  useTestNotificationTarget,
  useUpdateNotificationTarget,
  type NotificationEvent,
  type NotificationKind,
  type NotificationTarget,
} from "./api"

const eventsSchema = z.array(z.enum(["blocked", "failed", "completed"])).min(1, "Choose at least one event")

const createSchema = z
  .object({
    kind: z.enum(["webhook", "slack", "email"]),
    name: z.string().trim().min(1, "Name is required").max(100),
    url: z.string().trim(),
    events: eventsSchema,
    recipientIds: z.array(z.string()),
  })
  .superRefine((data, ctx) => {
    if (data.kind === "email") {
      if (data.recipientIds.length === 0) {
        ctx.addIssue({ code: "custom", path: ["recipientIds"], message: "Choose at least one member" })
      }
    } else if (!/^https?:\/\/\S+$/.test(data.url)) {
      ctx.addIssue({ code: "custom", path: ["url"], message: "Enter an http or https URL" })
    }
  })
type CreateInput = z.infer<typeof createSchema>

const editSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  events: eventsSchema,
  recipientIds: z.array(z.string()),
})
type EditInput = z.infer<typeof editSchema>

const URL_PLACEHOLDERS: Record<Exclude<NotificationKind, "email">, string> = {
  webhook: "https://ci.example.com/hooks/sentryward",
  slack: "https://hooks.slack.com/services/...",
}

function toggle<T>(list: T[], value: T, on: boolean): T[] {
  return on ? [...list, value] : list.filter((item) => item !== value)
}

function CheckboxList<T extends FieldValues>({
  control,
  name,
  legend,
  options,
}: {
  control: Control<T>
  name: Path<T>
  legend: string
  options: { value: string; label: string; description?: string }[]
}) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field, fieldState }) => (
        <FieldSet data-invalid={fieldState.invalid}>
          <FieldLegend variant="label">{legend}</FieldLegend>
          <div className="flex max-h-56 flex-col gap-2 overflow-y-auto">
            {options.map((option) => {
              const id = `${name}-${option.value}`
              const value = field.value as string[]
              return (
                <Field key={option.value} orientation="horizontal">
                  <Checkbox
                    id={id}
                    checked={value.includes(option.value)}
                    onCheckedChange={(on) => field.onChange(toggle(value, option.value, on === true))}
                  />
                  <FieldContent>
                    <FieldLabel htmlFor={id} className="font-normal">
                      {option.label}
                    </FieldLabel>
                    {option.description && <FieldDescription>{option.description}</FieldDescription>}
                  </FieldContent>
                </Field>
              )
            })}
          </div>
          {fieldState.invalid && <FieldError errors={[fieldState.error]} />}
        </FieldSet>
      )}
    />
  )
}

function memberOptions(members: Member[] | undefined) {
  return (members ?? []).map((member) => ({ value: member.id, label: member.name, description: member.email }))
}

// The secret appears only here: the server never returns it again.
function CreatedSecretView({ secret }: { secret: string }) {
  return (
    <div className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>Webhook added</DialogTitle>
        <DialogDescription>
          Each delivery carries an <code className="font-mono text-xs">X-Sentryward-Signature</code> header: the
          HMAC-SHA256 of the body with this secret. Copy it now; it's shown only once.
        </DialogDescription>
      </DialogHeader>
      <div className="flex gap-2">
        <Input
          readOnly
          value={secret}
          aria-label="Signing secret"
          className="font-mono"
          onFocus={(e) => e.currentTarget.select()}
        />
        <Button type="button" variant="outline" onClick={() => copyToClipboard(secret, "Secret")}>
          <Copy />
          Copy
        </Button>
      </div>
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button">Done</Button>
        </DialogClose>
      </DialogFooter>
    </div>
  )
}

function AddTargetDialog({ mailConfigured, members }: { mailConfigured: boolean; members: Member[] | undefined }) {
  const [open, setOpen] = useState(false)
  const [secret, setSecret] = useState<string | null>(null)
  const createTarget = useCreateNotificationTarget()
  const form = useForm<CreateInput>({
    resolver: zodResolver(createSchema),
    defaultValues: { kind: "webhook", name: "", url: "", events: ["blocked", "failed"], recipientIds: [] },
  })
  const kind = useWatch({ control: form.control, name: "kind" })

  async function onSubmit({ kind, name, url, events, recipientIds }: CreateInput) {
    try {
      const result = await createTarget.mutateAsync(
        kind === "email" ? { kind, name, events, recipientIds } : { kind, name, events, url },
      )
      if (result.secret) {
        setSecret(result.secret)
      } else {
        toast.success(`Added ${name}`)
        handleOpenChange(false)
      }
    } catch (error) {
      applyServerErrors(error, form.setError)
    }
  }

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (!next) {
      form.reset()
      setSecret(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus />
          Add target
        </Button>
      </DialogTrigger>
      <DialogContent>
        {secret ? (
          <CreatedSecretView secret={secret} />
        ) : (
          <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>Add a notification target</DialogTitle>
              <DialogDescription>Choose where finished reviews are reported, and which ones.</DialogDescription>
            </DialogHeader>
            <Controller
              control={form.control}
              name="kind"
              render={({ field }) => (
                <Field>
                  <FieldLabel htmlFor="notification-kind">Type</FieldLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="notification-kind" className="w-full" onBlur={field.onBlur}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent position="popper">
                      <SelectItem value="webhook">Webhook</SelectItem>
                      <SelectItem value="slack">Slack</SelectItem>
                      <SelectItem value="email" disabled={!mailConfigured}>
                        Email{!mailConfigured && " (mail is not configured)"}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              )}
            />
            <TextField control={form.control} name="name" label="Name" autoComplete="off" placeholder="Team alerts" />
            {kind === "email" ? (
              <CheckboxList control={form.control} name="recipientIds" legend="Recipients" options={memberOptions(members)} />
            ) : (
              <TextField
                control={form.control}
                name="url"
                label={kind === "slack" ? "Incoming webhook URL" : "URL"}
                type="url"
                autoComplete="off"
                placeholder={URL_PLACEHOLDERS[kind]}
              />
            )}
            <CheckboxList control={form.control} name="events" legend="Events" options={EVENT_OPTIONS} />
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting && <Loader2 className="animate-spin" />}
                Add target
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

function EditTargetDialog({
  target,
  members,
  onOpenChange,
}: {
  target: NotificationTarget
  members: Member[] | undefined
  onOpenChange: (open: boolean) => void
}) {
  const updateTarget = useUpdateNotificationTarget()
  const form = useForm<EditInput>({
    resolver: zodResolver(editSchema),
    defaultValues: { name: target.name, events: target.events, recipientIds: target.recipientIds },
  })

  async function onSubmit({ name, events, recipientIds }: EditInput) {
    if (target.kind === "email" && recipientIds.length === 0) {
      form.setError("recipientIds", { message: "Choose at least one member" })
      return
    }
    try {
      await updateTarget.mutateAsync({
        id: target.id,
        name,
        events,
        ...(target.kind === "email" ? { recipientIds } : {}),
      })
      toast.success(`Saved ${name}`)
      onOpenChange(false)
    } catch (error) {
      applyServerErrors(error, form.setError)
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Edit {target.name}</DialogTitle>
            <DialogDescription>
              {target.kind === "email"
                ? "Change who is emailed and about which reviews."
                : "To change the URL, remove this target and add it again."}
            </DialogDescription>
          </DialogHeader>
          <TextField control={form.control} name="name" label="Name" autoComplete="off" />
          {target.kind === "email" && (
            <CheckboxList control={form.control} name="recipientIds" legend="Recipients" options={memberOptions(members)} />
          )}
          <CheckboxList control={form.control} name="events" legend="Events" options={EVENT_OPTIONS} />
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting && <Loader2 className="animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function RemoveTargetDialog({
  target,
  onOpenChange,
}: {
  target: NotificationTarget | null
  onOpenChange: (open: boolean) => void
}) {
  const deleteTarget = useDeleteNotificationTarget()

  async function remove() {
    if (!target) return
    try {
      await deleteTarget.mutateAsync(target.id)
      toast.success(`Removed ${target.name}`)
      onOpenChange(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not remove the target")
    }
  }

  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove this target?</DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground">{target?.name}</span> stops receiving notifications at once.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              Cancel
            </Button>
          </DialogClose>
          <Button type="button" variant="destructive" onClick={remove} disabled={deleteTarget.isPending}>
            {deleteTarget.isPending && <Loader2 className="animate-spin" />}
            Remove target
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Destination({ target, members }: { target: NotificationTarget; members: Member[] | undefined }) {
  if (target.undecryptable) return <Badge variant="destructive">Can't be decrypted</Badge>
  if (target.kind !== "email") return <span className="font-mono text-xs">{target.host}</span>
  const byId = new Map((members ?? []).map((member) => [member.id, member.name]))
  // Recipients who left the workspace are not emailed, so they are not listed.
  const names = target.recipientIds.flatMap((id) => byId.get(id) ?? [])
  return <span>{names.length ? names.join(", ") : <span className="text-muted-foreground">No current members</span>}</span>
}

function EventBadges({ events }: { events: NotificationEvent[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {EVENT_OPTIONS.filter((option) => events.includes(option.value)).map((option) => (
        <Badge key={option.value} variant="secondary">
          {option.label}
        </Badge>
      ))}
    </div>
  )
}

function TargetActions({
  target,
  onEdit,
  onRemove,
}: {
  target: NotificationTarget
  onEdit: () => void
  onRemove: () => void
}) {
  const testTarget = useTestNotificationTarget()

  async function sendTest() {
    try {
      const result = await testTarget.mutateAsync(target.id)
      if (result.ok) toast.success(`Test sent to ${target.name}`)
      else toast.error(`Test to ${target.name} failed: ${result.error}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not send the test")
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8" aria-label={`Actions for ${target.name}`}>
          {testTarget.isPending ? <Loader2 className="animate-spin" /> : <MoreHorizontal />}
        </Button>
      </DropdownMenuTrigger>
      {/* The shared menu matches its trigger's width, which is far too narrow for an icon button. */}
      <DropdownMenuContent align="end" className="w-max whitespace-nowrap">
        <DropdownMenuItem onSelect={sendTest} disabled={testTarget.isPending}>
          <Send />
          Send test
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onEdit}>
          <Pencil />
          Edit
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={onRemove}>
          <Trash2 />
          Remove
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function NotificationTargets() {
  const { workspace } = useAuth()
  const { data, isPending, isError } = useNotificationTargets()
  // Members can see the targets; the server lets only admins change them.
  const canManage = workspace?.role === "owner" || workspace?.role === "admin"
  // Names for email recipients, and the picker when adding one.
  const { data: members } = useMembers(workspace?.id ?? "")
  const [editing, setEditing] = useState<NotificationTarget | null>(null)
  const [removing, setRemoving] = useState<NotificationTarget | null>(null)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-4">
        <p className="flex-1 text-sm text-muted-foreground">
          Sent once a review finishes. A delivery that fails is logged and never affects the review.
        </p>
        {canManage && data && <AddTargetDialog mailConfigured={data.mailConfigured} members={members} />}
      </div>
      {isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : isError ? (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>Could not load notification targets.</AlertTitle>
        </Alert>
      ) : data.targets.length === 0 ? (
        <Empty className="border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BellRing />
            </EmptyMedia>
            <EmptyTitle>No notification targets</EmptyTitle>
            <EmptyDescription>
              {canManage
                ? "Add a webhook, Slack channel or email to hear about blocked and failed reviews."
                : "A workspace admin can add a webhook, Slack channel or email for review notifications."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          {data.targets.some((target) => target.undecryptable) && (
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertTitle>Some targets can't be decrypted</AlertTitle>
              <AlertDescription>They were saved under a different encryption key. Remove and add them again.</AlertDescription>
            </Alert>
          )}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Destination</TableHead>
                <TableHead>Events</TableHead>
                {canManage && (
                  <TableHead className="w-0">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.targets.map((target) => (
                <TableRow key={target.id}>
                  <TableCell className="font-medium">{target.name}</TableCell>
                  <TableCell>{KIND_LABELS[target.kind]}</TableCell>
                  <TableCell>
                    <Destination target={target} members={members} />
                  </TableCell>
                  <TableCell>
                    <EventBadges events={target.events} />
                  </TableCell>
                  {canManage && (
                    <TableCell>
                      <TargetActions
                        target={target}
                        onEdit={() => setEditing(target)}
                        onRemove={() => setRemoving(target)}
                      />
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
      {editing && (
        <EditTargetDialog
          key={editing.id}
          target={editing}
          members={members}
          onOpenChange={(open) => !open && setEditing(null)}
        />
      )}
      <RemoveTargetDialog target={removing} onOpenChange={(open) => !open && setRemoving(null)} />
    </div>
  )
}
