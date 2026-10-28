import { useEffect, useMemo, useState } from "react"
import { Link, useSearchParams } from "react-router"
import { CircleAlert, FolderGit2, Loader2, MoreHorizontal, Plus, SlidersHorizontal, Trash2 } from "lucide-react"
import { toast } from "sonner"
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
import { ALL, matchesQuery, selectedLabel } from "@/lib/filters"
import { paginate, usePagination } from "@/hooks/use-pagination"
import { useSort } from "@/hooks/use-sort"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { AddReposSheet } from "@/features/forge/AddReposSheet"
import { ConnectionStatusBadge } from "@/features/forge/ConnectionStatusBadge"
import { FORGE_KIND_OPTIONS, forgeKey, kindLabel } from "@/features/forge/forgeKind"
import { PROVIDERS } from "@/features/forge/providers"
import {
  pausedConnections,
  statusRank,
  STATUS_OPTIONS,
  useConnectionStatuses,
  useConnections,
  useRemoveRepo,
  useRepos,
  useSetRepoEnabled,
  type Connection,
  type ConnectionStatus,
  type ForgeRepo,
} from "@/features/forge/api"

const REVIEW_OPTIONS = [
  { value: "enabled", label: "Enabled" },
  { value: "disabled", label: "Disabled" },
]

type ConnectionsById = Record<string, Connection | undefined>

// The repo only knows its provider; the connection says how it was connected.
function repoForge(repo: ForgeRepo, connections: ConnectionsById) {
  const connection = connections[repo.connectionId]
  return {
    key: connection ? forgeKey(connection) : null,
    label: connection ? kindLabel(connection) : PROVIDERS[repo.account.provider].label,
    icon: PROVIDERS[repo.account.provider].icon,
  }
}

type SortKey = "repository" | "forge" | "account" | "status" | "defaultBranch" | "reviews"

function compareRepos(
  a: ForgeRepo,
  b: ForgeRepo,
  key: SortKey,
  statuses: Record<string, ConnectionStatus | undefined>,
  connections: ConnectionsById,
) {
  switch (key) {
    case "repository":
      return a.fullPath.localeCompare(b.fullPath)
    case "forge":
      return repoForge(a, connections).label.localeCompare(repoForge(b, connections).label)
    case "account":
      return a.account.login.localeCompare(b.account.login)
    case "status":
      return statusRank(statuses[a.connectionId]) - statusRank(statuses[b.connectionId])
    case "defaultBranch":
      return a.defaultBranch.localeCompare(b.defaultBranch)
    case "reviews":
      // Enabled first.
      return Number(b.enabled) - Number(a.enabled)
  }
}

function RepoTable({
  repos,
  statuses,
  connections,
}: {
  repos: ForgeRepo[]
  statuses: Record<string, ConnectionStatus | undefined>
  connections: ConnectionsById
}) {
  const setEnabled = useSetRepoEnabled()
  // Unsorted keeps the API order (by repository path).
  const { sort, onSort } = useSort<SortKey>()
  const [removing, setRemoving] = useState<ForgeRepo | null>(null)

  const sorted = useMemo(() => {
    if (!sort) return repos
    const direction = sort.dir === "asc" ? 1 : -1
    return [...repos].sort(
      (a, b) => direction * compareRepos(a, b, sort.key, statuses, connections) || a.fullPath.localeCompare(b.fullPath),
    )
  }, [repos, sort, statuses, connections])
  const pagination = usePagination()
  const page = paginate(sorted, pagination.page, pagination.size)

  async function toggle(repo: ForgeRepo, enabled: boolean) {
    try {
      const { webhook } = await setEnabled.mutateAsync({ repo, enabled })
      // Manual reviews still work; say why automatic ones do not.
      if (webhook && !webhook.active) toast.warning(webhook.error ?? "Automatic reviews are unavailable")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not update the repository")
    }
  }

  const head = { sort, onSort }
  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <SortableHead label="Repository" sortKey="repository" {...head} />
            <SortableHead label="Forge" sortKey="forge" {...head} />
            <SortableHead label="Account" sortKey="account" {...head} />
            <SortableHead label="Connection" sortKey="status" {...head} />
            <SortableHead label="Default branch" sortKey="defaultBranch" {...head} />
            <SortableHead label="Reviews" sortKey="reviews" {...head} />
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {!sorted.length && <NoMatchesRow colSpan={7}>No repositories match your filters.</NoMatchesRow>}
          {page.rows.map((repo) => {
            const forge = repoForge(repo, connections)
            return (
              <TableRow key={repo.id}>
                <TableCell>
                  <a href={repo.webUrl} target="_blank" rel="noreferrer" className="font-medium hover:underline">
                    {repo.fullPath}
                  </a>
                </TableCell>
                <TableCell>
                  <Badge variant="outline">
                    <forge.icon />
                    {forge.label}
                  </Badge>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {repo.account.login} ({repo.account.host})
                </TableCell>
                <TableCell>
                  <ConnectionStatusBadge status={statuses[repo.connectionId]} />
                </TableCell>
                <TableCell className="text-muted-foreground">{repo.defaultBranch}</TableCell>
                <TableCell>
                  <Switch
                    checked={repo.enabled}
                    onCheckedChange={(checked) => toggle(repo, checked)}
                    aria-label={`Reviews for ${repo.fullPath}`}
                    disabled={setEnabled.isPending}
                  />
                </TableCell>
                <TableCell className="text-right">
                  <RepoActions repo={repo} onRemove={() => setRemoving(repo)} />
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
      <TablePagination
        page={page.page}
        size={pagination.size}
        total={page.total}
        onPageChange={pagination.setPage}
        onSizeChange={pagination.setSize}
      />
      <RemoveRepoDialog repo={removing} onOpenChange={(open) => !open && setRemoving(null)} />
    </>
  )
}

// Ignores ids that no longer match a connection, e.g. a stale link.
function initialAccount(requested: string | null, connections: Connection[]) {
  if (!requested) return ALL
  return connections.some((connection) => connection.id === requested) ? requested : ALL
}

// The search and filters sit above the card, so their state lives here and
// the table only sorts what it is given.
function RepoList({
  repos,
  connections,
  onAdd,
}: {
  repos: ForgeRepo[]
  connections: Connection[]
  onAdd: () => void
}) {
  const statuses = useConnectionStatuses(connections)
  const [params, setParams] = useSearchParams()
  const [query, setQuery] = useState("")
  const [forge, setForge] = useState(ALL)
  const [account, setAccount] = useState(() => initialAccount(params.get("account"), connections))
  const [status, setStatus] = useState(ALL)
  const [reviews, setReviews] = useState(ALL)

  // ?account= is a one-shot preset from the Installation tab's "Manage
  // repositories"; drop it so a reload does not override later filter changes.
  useEffect(() => {
    if (!params.has("account")) return
    setParams(
      (current) => {
        const next = new URLSearchParams(current)
        next.delete("account")
        return next
      },
      { replace: true },
    )
  }, [params, setParams])
  const { setPage } = usePagination()
  const filtering = forge !== ALL || account !== ALL || status !== ALL || reviews !== ALL

  // A new filter or search starts over at the first page.
  function filterBy<T>(set: (value: T) => void) {
    return (value: T) => {
      set(value)
      setPage(1)
    }
  }

  function clearFilters() {
    setForge(ALL)
    setAccount(ALL)
    setStatus(ALL)
    setReviews(ALL)
    setPage(1)
  }

  const connectionsById = useMemo<ConnectionsById>(
    () => Object.fromEntries(connections.map((connection) => [connection.id, connection])),
    [connections],
  )

  const accountOptions = useMemo(
    () =>
      connections
        .map((connection) => ({ value: connection.id, label: `${connection.accountLogin} (${connection.host})` }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [connections],
  )

  const filtered = useMemo(
    () =>
      repos.filter(
        (repo) =>
          matchesQuery(query, repo.fullPath, repo.account.login, repo.account.host, repo.defaultBranch) &&
          (forge === ALL || repoForge(repo, connectionsById).key === forge) &&
          (account === ALL || repo.connectionId === account) &&
          // Connections still being checked match no specific status.
          (status === ALL || statuses[repo.connectionId] === status) &&
          (reviews === ALL || repo.enabled === (reviews === "enabled")),
      ),
    [repos, query, forge, account, status, reviews, statuses, connectionsById],
  )

  const activeFilters = [
    { label: "Forge", value: selectedLabel(forge, FORGE_KIND_OPTIONS), onRemove: () => filterBy(setForge)(ALL) },
    { label: "Account", value: selectedLabel(account, accountOptions), onRemove: () => filterBy(setAccount)(ALL) },
    { label: "Connection status", value: selectedLabel(status, STATUS_OPTIONS), onRemove: () => filterBy(setStatus)(ALL) },
    { label: "Reviews", value: selectedLabel(reviews, REVIEW_OPTIONS), onRemove: () => filterBy(setReviews)(ALL) },
  ].filter((filter): filter is ActiveFilter => filter.value !== null)

  return (
    <>
      <FilterToolbar>
        <ActiveFilterChips filters={activeFilters} />
        <Button size="sm" onClick={onAdd}>
          <Plus />
          Add repository
        </Button>
        <FilterPopover active={filtering} onClear={clearFilters}>
          <FilterSelect
            id="repo-forge"
            label="Forge"
            allLabel="All forges"
            value={forge}
            onValueChange={filterBy(setForge)}
            options={FORGE_KIND_OPTIONS}
          />
          {/* With one connection the filter changes nothing, unless it was preset by "Manage repositories". */}
          {(accountOptions.length > 1 || account !== ALL) && (
            <FilterSelect
              id="repo-account"
              label="Account"
              allLabel="All accounts"
              value={account}
              onValueChange={filterBy(setAccount)}
              options={accountOptions}
            />
          )}
          <FilterSelect
            id="repo-status"
            label="Connection status"
            allLabel="All statuses"
            value={status}
            onValueChange={filterBy(setStatus)}
            options={STATUS_OPTIONS}
          />
          <FilterSelect
            id="repo-reviews"
            label="Reviews"
            allLabel="All reviews"
            value={reviews}
            onValueChange={filterBy(setReviews)}
            options={REVIEW_OPTIONS}
          />
        </FilterPopover>
        <SearchInput label="Search repositories" value={query} onChange={filterBy(setQuery)} />
      </FilterToolbar>
      <PausedAlert connections={pausedConnections(connections, statuses)} />
      <Card>
        <CardHeader>
          <CardTitle>Repositories</CardTitle>
        </CardHeader>
        <CardContent>
          <RepoTable repos={filtered} statuses={statuses} connections={connectionsById} />
        </CardContent>
      </Card>
    </>
  )
}

// Reconnecting the same account replaces the credentials on its connection,
// so unlike removing it, nothing is lost.
function PausedAlert({ connections }: { connections: Connection[] }) {
  if (!connections.length) return null
  return (
    <Alert variant="destructive">
      <CircleAlert />
      <AlertTitle>Automatic reviews are paused</AlertTitle>
      <AlertDescription>
        <p>
          The forge rejected the stored credentials for{" "}
          {connections.map((connection, index) => (
            <span key={connection.id}>
              {index > 0 && ", "}
              <span className="font-medium">
                {connection.accountLogin} ({connection.host})
              </span>
            </span>
          ))}
          . Connect the same account again to resume; its repositories and review history are kept.
        </p>
      </AlertDescription>
    </Alert>
  )
}

function RepoActions({ repo, onRemove }: { repo: ForgeRepo; onRemove: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8" aria-label={`Actions for ${repo.fullPath}`}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      {/* The shared menu matches its trigger's width, which is far too narrow for an icon button. */}
      <DropdownMenuContent align="end" className="w-max whitespace-nowrap">
        <DropdownMenuItem asChild>
          <Link to={`/configuration?repo=${repo.id}`}>
            <SlidersHorizontal />
            Review settings
          </Link>
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

// Rendered once beside the table rather than inside the row menu, which
// unmounts its items (and any dialog in them) as soon as it closes.
function RemoveRepoDialog({ repo, onOpenChange }: { repo: ForgeRepo | null; onOpenChange: (open: boolean) => void }) {
  const remove = useRemoveRepo()

  async function onRemove() {
    if (!repo) return
    try {
      await remove.mutateAsync(repo)
      onOpenChange(false)
      toast.success(`Removed ${repo.fullPath}`)
    } catch {
      toast.error("Could not remove the repository")
    }
  }

  return (
    <Dialog open={repo !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        {repo && (
          <>
            <DialogHeader>
              <DialogTitle>Remove {repo.fullPath}?</DialogTitle>
              <DialogDescription>
                Sentryward will stop reviewing it and remove its webhook. Its review history is deleted too. This cannot be
                undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
              <Button variant="destructive" onClick={onRemove} disabled={remove.isPending}>
                {remove.isPending && <Loader2 className="animate-spin" />}
                Remove repository
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

export function RepositoriesTab() {
  const { data, isPending } = useConnections()
  const repos = useRepos()
  const [adding, setAdding] = useState(false)
  const connections = data?.connections ?? []

  const sheet = <AddReposSheet connections={connections} open={adding} onOpenChange={setAdding} />

  if (isPending || (connections.length && repos.isPending)) {
    return (
      <div>
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }

  if (!connections.length) {
    return (
      <div className="flex flex-1 flex-col">
        <Empty className="flex-1 border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderGit2 />
            </EmptyMedia>
            <EmptyTitle>No forge connected</EmptyTitle>
            <EmptyDescription>Connect GitHub or GitLab to choose repositories to review.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button asChild>
              <Link to="/repositories?tab=installation">Connect a forge</Link>
            </Button>
          </EmptyContent>
        </Empty>
      </div>
    )
  }

  if (repos.isError) {
    return (
      <div>
        <p className="text-sm text-destructive">{repos.error.message}</p>
      </div>
    )
  }

  if (!repos.data?.repos.length) {
    return (
      <div className="flex flex-1 flex-col">
        <Empty className="flex-1 border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderGit2 />
            </EmptyMedia>
            <EmptyTitle>No repositories added</EmptyTitle>
            <EmptyDescription>Choose which repositories Sentryward should review.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={() => setAdding(true)}>
              <Plus />
              Add repository
            </Button>
          </EmptyContent>
        </Empty>
        {sheet}
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col gap-4">
      <RepoList repos={repos.data.repos} connections={connections} onAdd={() => setAdding(true)} />
      {sheet}
    </div>
  )
}
