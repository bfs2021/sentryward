import { useEffect, useMemo, useState } from "react"
import { Controller, useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { Navigate, useSearchParams } from "react-router"
import { Copy, KeyRound, Loader2, MailPlus, MoreHorizontal, Pencil, Trash2, UserPlus, Users } from "lucide-react"
import { toast } from "sonner"
import { z } from "zod"
import { PageHeader } from "@/components/PageHeader"
import { PageShell } from "@/components/PageShell"
import { SortableHead } from "@/components/SortableHead"
import {
  ActiveFilterChips,
  FilterPopover,
  FilterSelect,
  FilterToolbar,
  NoMatchesRow,
  SearchInput,
  type ActiveFilter,
} from "@/components/TableFilters"
import { TablePagination } from "@/components/TablePagination"
import { UserAvatar } from "@/components/UserAvatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
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
import { Field, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { User } from "@/features/auth/auth-context"
import { TextField } from "@/features/auth/TextField"
import { applyServerErrors } from "@/features/auth/applyServerErrors"
import { useAuth } from "@/features/auth/useAuth"
import {
  useAdminUsers,
  useCreateInvite,
  useCreatePasswordReset,
  useDeleteUser,
  useInvites,
  useResendInvite,
  useRevokeInvite,
  useUpdateUser,
  type CreatedInvite,
  type CreatedPasswordReset,
  type PendingInvite,
  type UserEdit,
  type UserSortKey,
} from "@/features/admin/api"
import { useDebounced } from "@/hooks/use-debounced"
import { paginate, usePagination } from "@/hooks/use-pagination"
import { useSort } from "@/hooks/use-sort"
import { CreatedInviteView } from "@/features/invites/CreatedInviteView"
import { InviteActions, ResendInviteDialog, RevokeInviteDialog } from "@/features/invites/InviteRowActions"
import { copyToClipboard } from "@/lib/clipboard"
import { ALL, matchesQuery, selectedLabel } from "@/lib/filters"
import { timeAgo } from "@/lib/time"

const ROLE_OPTIONS = [
  { value: "admin", label: "Admin" },
  { value: "member", label: "Member" },
]

const TAB_ITEMS = [
  { value: "users", label: "Users", icon: Users },
  { value: "invites", label: "Pending invites", icon: MailPlus },
] as const
type Tab = (typeof TAB_ITEMS)[number]["value"]
const TABS: readonly string[] = TAB_ITEMS.map((item) => item.value)

const USER_COLUMNS: { key: UserSortKey; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "email", label: "Email" },
  { key: "role", label: "Role" },
  { key: "createdAt", label: "Joined" },
]

const inviteSchema = z.object({
  email: z.union([z.literal(""), z.email("Enter a valid email address")]),
})
type InviteInput = z.infer<typeof inviteSchema>

function InviteDialog() {
  const [open, setOpen] = useState(false)
  const [created, setCreated] = useState<CreatedInvite | null>(null)
  const createInvite = useCreateInvite()
  const form = useForm<InviteInput>({ resolver: zodResolver(inviteSchema), defaultValues: { email: "" } })

  async function onSubmit({ email }: InviteInput) {
    try {
      setCreated(await createInvite.mutateAsync(email || undefined))
    } catch (error) {
      applyServerErrors(error, form.setError)
    }
  }

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (!next) {
      form.reset()
      setCreated(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm">
          <UserPlus />
          Invite user
        </Button>
      </DialogTrigger>
      <DialogContent>
        {created ? (
          <CreatedInviteView created={created} />
        ) : (
          <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>Invite a user</DialogTitle>
              <DialogDescription>
                Creates a one-time sign-up link. Add an email to restrict the link to that address and, if mail is
                set up, send it.
              </DialogDescription>
            </DialogHeader>
            <TextField
              control={form.control}
              name="email"
              label="Email (optional)"
              type="email"
              autoComplete="off"
              placeholder="teammate@example.com"
            />
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting && <Loader2 className="animate-spin" />}
                Create invite
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

// Removing yourself is left out: the server refuses it, and Settings deletes
// your own account behind a password check. A reset link is left out for the
// same reason: your own password changes in Settings.
function UserActions({
  user,
  isSelf,
  onEdit,
  onResetPassword,
  onRemove,
}: {
  user: User
  isSelf: boolean
  onEdit: () => void
  onResetPassword: () => void
  onRemove: () => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8" aria-label={`Actions for ${user.name}`}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      {/* The shared menu matches its trigger's width, which is far too narrow for an icon button. */}
      <DropdownMenuContent align="end" className="w-max whitespace-nowrap">
        <DropdownMenuItem onSelect={onEdit}>
          <Pencil />
          Edit
        </DropdownMenuItem>
        {!isSelf && (
          <>
            <DropdownMenuItem onSelect={onResetPassword}>
              <KeyRound />
              Create reset link
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onRemove}>
              <Trash2 />
              Remove
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

const editUserSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  email: z.email("Enter a valid email address"),
  role: z.enum(["admin", "member"]),
})
type EditUserInput = z.infer<typeof editUserSchema>

function EditUserDialog({ user, onOpenChange }: { user: User | null; onOpenChange: (open: boolean) => void }) {
  const update = useUpdateUser()
  const form = useForm<EditUserInput>({ resolver: zodResolver(editUserSchema) })

  // The dialog stays mounted, so each opened user refills the form.
  useEffect(() => {
    if (user) form.reset({ name: user.name, email: user.email, role: user.role })
  }, [user, form])

  async function onSubmit(values: EditUserInput) {
    if (!user) return
    // Only what changed goes up, so a name edit never runs the last-admin check.
    const edit: UserEdit = {}
    if (values.name.trim() !== user.name) edit.name = values.name
    if (values.email.trim().toLowerCase() !== user.email) edit.email = values.email
    if (values.role !== user.role) edit.role = values.role
    if (Object.keys(edit).length === 0) {
      onOpenChange(false)
      return
    }
    try {
      const { user: saved } = await update.mutateAsync({ id: user.id, ...edit })
      onOpenChange(false)
      toast.success(`Saved ${saved.name}`)
    } catch (error) {
      applyServerErrors(error, form.setError)
    }
  }

  return (
    <Dialog open={user !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        {user && (
          <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>Edit {user.name}</DialogTitle>
              <DialogDescription>Admins can use and manage this Sentryward instance; members can only use it.</DialogDescription>
            </DialogHeader>
            <TextField control={form.control} name="name" label="Name" autoComplete="off" />
            <TextField control={form.control} name="email" label="Email" type="email" autoComplete="off" />
            <Controller
              control={form.control}
              name="role"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="edit-user-role">Role</FieldLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="edit-user-role" className="w-full" onBlur={field.onBlur}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent position="popper">
                      {ROLE_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FieldError errors={[fieldState.error]} />
                </Field>
              )}
            />
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting && <Loader2 className="animate-spin" />}
                Save changes
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

// For someone locked out, whether or not this server can send email: the admin
// passes the link on themselves. It's shown only here, once.
function ResetPasswordDialog({ user, onOpenChange }: { user: User | null; onOpenChange: (open: boolean) => void }) {
  const [created, setCreated] = useState<CreatedPasswordReset | null>(null)
  const createReset = useCreatePasswordReset()

  async function create() {
    if (!user) return
    try {
      setCreated(await createReset.mutateAsync(user.id))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create the link")
    }
  }

  function handleOpenChange(next: boolean) {
    if (!next) setCreated(null)
    onOpenChange(next)
  }

  return (
    <Dialog open={user !== null} onOpenChange={handleOpenChange}>
      <DialogContent>
        {user &&
          (created ? (
            <div className="flex flex-col gap-4">
              <DialogHeader>
                <DialogTitle>Reset link created</DialogTitle>
                <DialogDescription>
                  Send this link to {user.name}. It's shown only once, works once and expires in 24 hours.
                </DialogDescription>
              </DialogHeader>
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={created.link}
                  aria-label="Reset link"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <Button type="button" variant="outline" onClick={() => copyToClipboard(created.link, "Reset link")}>
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
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Create a reset link for {user.name}?</DialogTitle>
                <DialogDescription>
                  The link lets whoever opens it set a new password for {user.email}, so only give it to them. Using
                  it signs them out everywhere else, and any earlier reset link for them stops working.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose asChild>
                  <Button type="button" variant="outline">
                    Cancel
                  </Button>
                </DialogClose>
                <Button disabled={createReset.isPending} onClick={create}>
                  {createReset.isPending && <Loader2 className="animate-spin" />}
                  Create link
                </Button>
              </DialogFooter>
            </>
          ))}
      </DialogContent>
    </Dialog>
  )
}

function RemoveUserDialog({ user, onOpenChange }: { user: User | null; onOpenChange: (open: boolean) => void }) {
  const deleteUser = useDeleteUser()

  async function confirm() {
    if (!user) return
    try {
      await deleteUser.mutateAsync(user.id)
      onOpenChange(false)
      toast.success(`${user.name} was removed`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not remove the user")
    }
  }

  return (
    <Dialog open={user !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        {user && (
          <>
            <DialogHeader>
              <DialogTitle>Remove {user.name}?</DialogTitle>
              <DialogDescription>
                This deletes {user.email} along with their personal connections, repositories, review history and API
                keys. Data in teams they belong to stays, and ownership passes to another member. It cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
              <Button variant="destructive" disabled={deleteUser.isPending} onClick={confirm}>
                {deleteUser.isPending && <Loader2 className="animate-spin" />}
                Remove user
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function UsersCard({ currentUserId }: { currentUserId: string }) {
  const pagination = usePagination()
  const [role, setRole] = useState(ALL)
  const [query, setQuery] = useState("")
  const { sort, onSort } = useSort<UserSortKey>()
  const q = useDebounced(query.trim())

  const { data, isPending, isError } = useAdminUsers({
    role: role === ALL ? undefined : (role as User["role"]),
    q: q || undefined,
    // Unsorted leaves the server's default: oldest account first.
    sort: sort?.key,
    dir: sort?.dir,
    page: pagination.page,
    limit: pagination.size,
  })
  const [editing, setEditing] = useState<User | null>(null)
  const [removing, setRemoving] = useState<User | null>(null)
  const [resetting, setResetting] = useState<User | null>(null)

  // A page past the end (e.g. after removing the last user on it) falls back to the last real page.
  const lastPage = data ? Math.max(1, Math.ceil(data.total / pagination.size)) : 1
  useEffect(() => {
    if (pagination.page > lastPage) pagination.setPage(lastPage)
  }, [pagination, lastPage])

  // A new filter, search or sort starts over at the first page.
  function filterBy<T>(set: (value: T) => void) {
    return (value: T) => {
      set(value)
      pagination.setPage(1)
    }
  }

  const activeFilters = [
    { label: "Role", value: selectedLabel(role, ROLE_OPTIONS), onRemove: () => filterBy(setRole)(ALL) },
  ].filter((filter): filter is ActiveFilter => filter.value !== null)

  return (
    <>
      <FilterToolbar>
        <ActiveFilterChips filters={activeFilters} />
        <InviteDialog />
        <FilterPopover active={role !== ALL} onClear={() => filterBy(setRole)(ALL)}>
          <FilterSelect
            id="user-role"
            label="Role"
            allLabel="All roles"
            value={role}
            onValueChange={filterBy(setRole)}
            options={ROLE_OPTIONS}
          />
        </FilterPopover>
        <SearchInput label="Search users" value={query} onChange={filterBy(setQuery)} />
      </FilterToolbar>
      <Card>
        <CardHeader>
          <CardTitle>Users</CardTitle>
          <CardDescription>Admins can manage users and invites. Personal data stays private to each user; team data is shared with that team's members.</CardDescription>
        </CardHeader>
        <CardContent>
          {isPending ? (
            <Loader2 className="animate-spin text-muted-foreground" />
          ) : isError ? (
            <p className="text-sm text-destructive">Could not load users.</p>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    {USER_COLUMNS.map((column) => (
                      <SortableHead
                        key={column.key}
                        label={column.label}
                        sortKey={column.key}
                        sort={sort}
                        onSort={filterBy(onSort)}
                      />
                    ))}
                    <TableHead className="w-0" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.users.length === 0 && <NoMatchesRow colSpan={5}>No users match your filters.</NoMatchesRow>}
                  {data.users.map((user) => (
                    <TableRow key={user.id}>
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-2">
                          <UserAvatar user={user} size="sm" />
                          {user.name}
                          {user.id === currentUserId && <Badge variant="secondary">You</Badge>}
                        </div>
                      </TableCell>
                      <TableCell>{user.email}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{user.role === "admin" ? "Admin" : "Member"}</Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{timeAgo(user.createdAt)}</TableCell>
                      <TableCell className="text-right">
                        <UserActions
                          user={user}
                          isSelf={user.id === currentUserId}
                          onEdit={() => setEditing(user)}
                          onResetPassword={() => setResetting(user)}
                          onRemove={() => setRemoving(user)}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {data.total > 0 && (
                <TablePagination
                  page={Math.min(pagination.page, lastPage)}
                  size={pagination.size}
                  total={data.total}
                  onPageChange={pagination.setPage}
                  onSizeChange={pagination.setSize}
                />
              )}
            </>
          )}
        </CardContent>
      </Card>
      <EditUserDialog user={editing} onOpenChange={(open) => !open && setEditing(null)} />
      <ResetPasswordDialog user={resetting} onOpenChange={(open) => !open && setResetting(null)} />
      <RemoveUserDialog user={removing} onOpenChange={(open) => !open && setRemoving(null)} />
    </>
  )
}

type InviteSortKey = "email" | "invitedBy" | "createdAt" | "expiresAt"

const INVITE_COLUMNS: { key: InviteSortKey; label: string }[] = [
  { key: "email", label: "For" },
  { key: "invitedBy", label: "Invited by" },
  { key: "createdAt", label: "Created" },
  { key: "expiresAt", label: "Expires" },
]

const INVITE_TYPE_OPTIONS = [
  { value: "email", label: "Specific email" },
  { value: "link", label: "Anyone with the link" },
]

// Open links have no email; they sort after every addressed invite.
function compareInvites(a: PendingInvite, b: PendingInvite, key: InviteSortKey) {
  switch (key) {
    case "email":
      return (a.email ?? "\uffff").localeCompare(b.email ?? "\uffff")
    case "invitedBy":
      return (a.invitedBy?.name ?? "").localeCompare(b.invitedBy?.name ?? "")
    case "createdAt":
      return Date.parse(a.createdAt) - Date.parse(b.createdAt)
    case "expiresAt":
      return Date.parse(a.expiresAt) - Date.parse(b.expiresAt)
  }
}

function InvitesTable({ invites, emptyMessage }: { invites: PendingInvite[]; emptyMessage: string }) {
  // Unsorted keeps the API order (newest first).
  const { sort, onSort } = useSort<InviteSortKey>()
  const [resending, setResending] = useState<PendingInvite | null>(null)
  const [revoking, setRevoking] = useState<PendingInvite | null>(null)
  const resend = useResendInvite()
  const revoke = useRevokeInvite()

  const sorted = useMemo(() => {
    if (!sort) return invites
    const direction = sort.dir === "asc" ? 1 : -1
    return [...invites].sort(
      (a, b) => direction * compareInvites(a, b, sort.key) || Date.parse(b.createdAt) - Date.parse(a.createdAt),
    )
  }, [invites, sort])
  const pagination = usePagination()
  const page = paginate(sorted, pagination.page, pagination.size)

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            {INVITE_COLUMNS.map((column) => (
              <SortableHead key={column.key} label={column.label} sortKey={column.key} sort={sort} onSort={onSort} />
            ))}
            <TableHead className="w-0" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {!sorted.length && <NoMatchesRow colSpan={5}>{emptyMessage}</NoMatchesRow>}
          {page.rows.map((invite) => (
            <TableRow key={invite.id}>
              <TableCell>{invite.email ?? <span className="text-muted-foreground">Anyone with the link</span>}</TableCell>
              <TableCell>{invite.invitedBy?.name ?? "Removed user"}</TableCell>
              <TableCell className="text-muted-foreground">{timeAgo(invite.createdAt)}</TableCell>
              <TableCell className="text-muted-foreground" title={new Date(invite.expiresAt).toLocaleString()}>
                {timeAgo(invite.expiresAt)}
              </TableCell>
              <TableCell className="text-right">
                <InviteActions
                  invite={invite}
                  onResend={() => setResending(invite)}
                  onRevoke={() => setRevoking(invite)}
                />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {page.total > 0 && (
        <TablePagination
          page={page.page}
          size={pagination.size}
          total={page.total}
          onPageChange={pagination.setPage}
          onSizeChange={pagination.setSize}
        />
      )}
      <ResendInviteDialog
        invite={resending}
        onOpenChange={(open) => !open && setResending(null)}
        resend={resend}
        linkLabel="sign-up link"
      />
      <RevokeInviteDialog invite={revoking} onOpenChange={(open) => !open && setRevoking(null)} revoke={revoke} />
    </>
  )
}

// The search and filter sit above the card, so their state lives here and
// the table only sorts what it is given.
function InvitesTab() {
  const { data: invites, isPending } = useInvites()
  const { setPage } = usePagination()
  const [query, setQuery] = useState("")
  const [type, setType] = useState(ALL)

  // A new filter or search starts over at the first page.
  function filterBy<T>(set: (value: T) => void) {
    return (value: T) => {
      set(value)
      setPage(1)
    }
  }

  const filtered = useMemo(
    () =>
      (invites ?? []).filter(
        (invite) =>
          matchesQuery(query, invite.email ?? "", invite.invitedBy?.name ?? "") &&
          (type === ALL || (type === "email") === (invite.email !== null)),
      ),
    [invites, query, type],
  )

  if (isPending) return null

  // Narrowed means the search or a filter hid rows; otherwise there are none.
  const narrowed = type !== ALL || query.trim() !== ""
  const emptyMessage = narrowed
    ? "No invites match your filters."
    : "No pending invites yet. Invite someone to give them a one-time sign-up link."

  const activeFilters = [
    { label: "Type", value: selectedLabel(type, INVITE_TYPE_OPTIONS), onRemove: () => filterBy(setType)(ALL) },
  ].filter((filter): filter is ActiveFilter => filter.value !== null)

  return (
    <>
      <FilterToolbar>
        <ActiveFilterChips filters={activeFilters} />
        <InviteDialog />
        <FilterPopover active={type !== ALL} onClear={() => filterBy(setType)(ALL)}>
          <FilterSelect
            id="invite-type"
            label="Type"
            allLabel="All invites"
            value={type}
            onValueChange={filterBy(setType)}
            options={INVITE_TYPE_OPTIONS}
          />
        </FilterPopover>
        <SearchInput label="Search invites" value={query} onChange={filterBy(setQuery)} />
      </FilterToolbar>
      <Card>
        <CardHeader>
          <CardTitle>Pending invites</CardTitle>
          <CardDescription>Links that have not been used yet. Each works once and expires after 7 days.</CardDescription>
        </CardHeader>
        <CardContent>
          <InvitesTable invites={filtered} emptyMessage={emptyMessage} />
        </CardContent>
      </Card>
    </>
  )
}

export function AdminUsersPage() {
  const { user } = useAuth()
  // ?tab= keeps the open tab linkable, e.g. /admin/users?tab=invites.
  const [params, setParams] = useSearchParams()
  const requested = params.get("tab")
  const tab: Tab = requested && TABS.includes(requested) ? (requested as Tab) : "users"
  if (!user) return null
  if (user.role !== "admin") return <Navigate to="/home" replace />

  return (
    <PageShell>
      <PageHeader title="Users" description="Who can use this Sentryward instance." />
      <Tabs className="flex-1" value={tab} onValueChange={(value) => setParams({ tab: value }, { replace: true })}>
        <TabsList>
          {TAB_ITEMS.map((item) => (
            <TabsTrigger key={item.value} value={item.value}>
              <item.icon />
              <span>{item.label}</span>
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="users" className="flex flex-col gap-4">
          <UsersCard currentUserId={user.id} />
        </TabsContent>
        <TabsContent value="invites" className="flex flex-col gap-4">
          <InvitesTab />
        </TabsContent>
      </Tabs>
    </PageShell>
  )
}
