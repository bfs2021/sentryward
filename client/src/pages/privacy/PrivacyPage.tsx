import { useSearchParams } from "react-router"
import { Loader2, ScrollText, ShieldCheck } from "lucide-react"
import { PageHeader } from "@/components/PageHeader"
import { PageShell } from "@/components/PageShell"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useAuth } from "@/features/auth/useAuth"
import { AuditLogTable } from "@/features/privacy/AuditLogTable"
import { PrivacyPolicyForm } from "@/features/privacy/PrivacyPolicyForm"
import { usePrivacy, useSavePrivacy } from "@/features/privacy/api"

// The audit log tab is for workspace admins, as its API is.
const TAB_ITEMS = [
  { value: "policy", label: "Policy", icon: ShieldCheck, adminOnly: false },
  { value: "audit", label: "Audit log", icon: ScrollText, adminOnly: true },
] as const
type Tab = (typeof TAB_ITEMS)[number]["value"]

function PolicyCard({ canManage }: { canManage: boolean }) {
  const { data, isPending, isError } = usePrivacy()
  const save = useSavePrivacy()
  return (
    <Card>
      <CardHeader>
        <CardTitle>Workspace policy</CardTitle>
        <CardDescription>
          Narrows the instance policy for this workspace. Reviews that would use a provider or host it does not allow
          fail with the reason, before anything is sent.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isPending ? (
          <Loader2 className="animate-spin text-muted-foreground" />
        ) : isError ? (
          <p className="text-sm text-destructive">Could not load the privacy settings.</p>
        ) : (
          <PrivacyPolicyForm
            scope="workspace"
            values={data.workspace}
            instance={data.instance}
            readOnly={!canManage}
            onSave={({ auditRetentionDays: _audit, ...layer }) => save.mutateAsync(layer)}
          />
        )}
      </CardContent>
    </Card>
  )
}

// The current workspace's privacy policy (everyone can see what their reviews
// run under; admins change it) and, for admins, its audit log.
export function PrivacyPage() {
  const { workspace } = useAuth()
  const canManage = workspace?.role === "owner" || workspace?.role === "admin"
  const tabs = TAB_ITEMS.filter((item) => canManage || !item.adminOnly)
  // ?tab= keeps the open tab linkable, e.g. /privacy?tab=audit.
  const [params, setParams] = useSearchParams()
  const requested = params.get("tab")
  const tab: Tab = tabs.find((item) => item.value === requested)?.value ?? "policy"

  return (
    <PageShell>
      <PageHeader
        title="Privacy"
        description="Which model providers and hosts reviews may send code to, how long review data is kept, and a log of every model request."
      />
      <Tabs className="flex-1" value={tab} onValueChange={(value) => setParams({ tab: value }, { replace: true })}>
        {tabs.length > 1 && (
          <TabsList>
            {tabs.map((item) => (
              <TabsTrigger key={item.value} value={item.value}>
                <item.icon />
                <span>{item.label}</span>
              </TabsTrigger>
            ))}
          </TabsList>
        )}
        <TabsContent value="policy">
          <PolicyCard canManage={canManage} />
        </TabsContent>
        {canManage && (
          <TabsContent value="audit" className="flex flex-col gap-4">
            <AuditLogTable scope="workspace" />
          </TabsContent>
        )}
      </Tabs>
    </PageShell>
  )
}
