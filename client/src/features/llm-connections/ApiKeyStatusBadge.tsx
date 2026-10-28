import { Loader2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { STATUS_LABELS, type LlmConnectionStatus } from "./api"

const STATUS_BADGES: Record<LlmConnectionStatus, { className: string; title: string }> = {
  active: {
    className: "border-emerald-600/40 text-emerald-700 dark:text-emerald-400",
    title: "The provider accepts the stored credentials",
  },
  revoked: {
    className: "border-destructive/40 text-destructive",
    title: "The provider rejected the stored credentials; replace this connection",
  },
  unreachable: {
    className: "border-amber-600/40 text-amber-700 dark:text-amber-400",
    title: "Could not verify the connection with the provider",
  },
  blocked: {
    className: "border-destructive/40 text-destructive",
    title: "The privacy policy does not allow this connection; reviews cannot use it",
  },
}

export function ApiKeyStatusBadge({ status }: { status: LlmConnectionStatus | undefined }) {
  if (!status) {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        Checking...
      </span>
    )
  }

  const badge = STATUS_BADGES[status]
  return (
    <Badge variant="outline" className={cn(badge.className)} title={badge.title}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {STATUS_LABELS[status]}
    </Badge>
  )
}
