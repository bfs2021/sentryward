import { useEffect, useState } from "react"
import { Download, Loader2 } from "lucide-react"
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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { LlmProvider } from "@/features/llm-connections/api"
import { useDebounced } from "@/hooks/use-debounced"
import { usePagination } from "@/hooks/use-pagination"
import { downloadFile } from "@/lib/download"
import { ALL, selectedLabel } from "@/lib/filters"
import { timeAgo } from "@/lib/time"
import {
  fetchAuditExport,
  PROVIDER_OPTIONS,
  useAuditLog,
  type AuditPurpose,
  type AuditQuery,
  type AuditScope,
} from "./api"

const PURPOSE_OPTIONS: { value: AuditPurpose; label: string }[] = [
  { value: "review", label: "Review" },
  { value: "walkthrough", label: "Walkthrough" },
  { value: "verify", label: "Verify" },
  { value: "probe", label: "Capability probe" },
  { value: "reply", label: "Thread reply" },
  { value: "test", label: "Connection test" },
]

const OUTCOME_OPTIONS = [
  { value: "ok", label: "Succeeded" },
  { value: "failed", label: "Failed" },
]

const tokens = new Intl.NumberFormat()

// Outbound model requests: where each went and what it cost, never what was
// sent. The instance view adds the workspace column.
export function AuditLogTable({ scope }: { scope: AuditScope }) {
  const pagination = usePagination()
  const [provider, setProvider] = useState(ALL)
  const [purpose, setPurpose] = useState(ALL)
  const [outcome, setOutcome] = useState(ALL)
  const [query, setQuery] = useState("")
  const [exporting, setExporting] = useState(false)
  const q = useDebounced(query.trim())

  const filters: AuditQuery = {
    provider: provider === ALL ? undefined : (provider as LlmProvider),
    purpose: purpose === ALL ? undefined : (purpose as AuditPurpose),
    outcome: outcome === ALL ? undefined : (outcome as "ok" | "failed"),
    q: q || undefined,
  }
  const { data, isPending, isError } = useAuditLog(scope, { ...filters, page: pagination.page, limit: pagination.size })

  // A page past the end falls back to the last real page.
  const lastPage = data ? Math.max(1, Math.ceil(data.total / pagination.size)) : 1
  useEffect(() => {
    if (pagination.page > lastPage) pagination.setPage(lastPage)
  }, [pagination, lastPage])

  // A new filter or search starts over at the first page.
  function filterBy<T>(set: (value: T) => void) {
    return (value: T) => {
      set(value)
      pagination.setPage(1)
    }
  }

  function clearFilters() {
    filterBy(setProvider)(ALL)
    setPurpose(ALL)
    setOutcome(ALL)
  }

  async function exportAs(format: "csv" | "json") {
    setExporting(true)
    const stamp = new Date().toISOString().slice(0, 10)
    await downloadFile(
      fetchAuditExport(scope, filters, format),
      `sentryward-audit-${stamp}.${format}`,
      "Audit log",
      format === "csv" ? "text/csv;charset=utf-8" : "application/json;charset=utf-8",
    )
    setExporting(false)
  }

  const activeFilters = [
    { label: "Provider", value: selectedLabel(provider, PROVIDER_OPTIONS), onRemove: () => filterBy(setProvider)(ALL) },
    { label: "Purpose", value: selectedLabel(purpose, PURPOSE_OPTIONS), onRemove: () => filterBy(setPurpose)(ALL) },
    { label: "Outcome", value: selectedLabel(outcome, OUTCOME_OPTIONS), onRemove: () => filterBy(setOutcome)(ALL) },
  ].filter((filter): filter is ActiveFilter => filter.value !== null)

  const instance = scope === "instance"
  const columns = instance ? 8 : 7

  return (
    <>
      <FilterToolbar>
        <ActiveFilterChips filters={activeFilters} />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" disabled={exporting}>
              {exporting ? <Loader2 className="animate-spin" /> : <Download />}
              Export
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => exportAs("csv")}>CSV</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => exportAs("json")}>JSON</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <FilterPopover active={activeFilters.length > 0} onClear={clearFilters}>
          <FilterSelect
            id="audit-provider"
            label="Provider"
            allLabel="All providers"
            value={provider}
            onValueChange={filterBy(setProvider)}
            options={PROVIDER_OPTIONS}
          />
          <FilterSelect
            id="audit-purpose"
            label="Purpose"
            allLabel="All purposes"
            value={purpose}
            onValueChange={filterBy(setPurpose)}
            options={PURPOSE_OPTIONS}
          />
          <FilterSelect
            id="audit-outcome"
            label="Outcome"
            allLabel="All outcomes"
            value={outcome}
            onValueChange={filterBy(setOutcome)}
            options={OUTCOME_OPTIONS}
          />
        </FilterPopover>
        <SearchInput label="Search the audit log" value={query} onChange={filterBy(setQuery)} />
      </FilterToolbar>
      <Card>
        <CardHeader>
          <CardTitle>Audit log</CardTitle>
          <CardDescription>
            Every request sent to a model provider{instance ? " from any workspace" : ""}: when, where to and how many
            tokens. Prompts, code and replies are never recorded.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isPending ? (
            <Loader2 className="animate-spin text-muted-foreground" />
          ) : isError ? (
            <p className="text-sm text-destructive">Could not load the audit log.</p>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Time</TableHead>
                    {instance && <TableHead>Workspace</TableHead>}
                    <TableHead>Repository</TableHead>
                    <TableHead>Purpose</TableHead>
                    <TableHead>Model</TableHead>
                    <TableHead>Host</TableHead>
                    <TableHead className="text-right">Tokens in / out</TableHead>
                    <TableHead>Outcome</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.entries.length === 0 && (
                    <NoMatchesRow colSpan={columns}>No model requests match your filters.</NoMatchesRow>
                  )}
                  {data.entries.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell className="text-muted-foreground" title={new Date(entry.createdAt).toLocaleString()}>
                        {timeAgo(entry.createdAt)}
                      </TableCell>
                      {instance && <TableCell>{entry.workspaceName}</TableCell>}
                      <TableCell>
                        {entry.repository ? (
                          <>
                            {entry.repository}
                            {entry.changeNumber !== null && (
                              <span className="text-muted-foreground"> #{entry.changeNumber}</span>
                            )}
                          </>
                        ) : (
                          <span className="text-muted-foreground">Dashboard</span>
                        )}
                      </TableCell>
                      <TableCell>{selectedLabel(entry.purpose, PURPOSE_OPTIONS) ?? entry.purpose}</TableCell>
                      <TableCell className="font-mono text-xs">{entry.model}</TableCell>
                      <TableCell className="font-mono text-xs">{entry.host}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {tokens.format(entry.inputTokens)} / {tokens.format(entry.outputTokens)}
                      </TableCell>
                      <TableCell>
                        {entry.outcome === "ok" ? (
                          <Badge variant="outline">OK</Badge>
                        ) : (
                          <Badge variant="outline" className="border-destructive/40 text-destructive">
                            Failed{entry.errorKind ? ` (${entry.errorKind})` : ""}
                          </Badge>
                        )}
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
    </>
  )
}
