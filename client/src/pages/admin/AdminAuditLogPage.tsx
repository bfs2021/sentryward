import { Navigate } from "react-router"
import { PageHeader } from "@/components/PageHeader"
import { PageShell } from "@/components/PageShell"
import { useAuth } from "@/features/auth/useAuth"
import { AuditLogTable } from "@/features/privacy/AuditLogTable"

export function AdminAuditLogPage() {
  const { user } = useAuth()
  if (!user) return null
  if (user.role !== "admin") return <Navigate to="/home" replace />

  return (
    <PageShell>
      <PageHeader title="Audit log" description="Outbound model requests across every workspace on this instance." />
      <AuditLogTable scope="instance" />
    </PageShell>
  )
}
