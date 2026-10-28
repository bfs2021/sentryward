import { useSearchParams } from "react-router"
import { Info, Loader2, ScrollText, ShieldCheck } from "lucide-react"
import { PageHeader } from "@/components/PageHeader"
import { PageShell } from "@/components/PageShell"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useAuth } from "@/features/auth/useAuth"
import { AuditLogTable } from "@/features/privacy/AuditLogTable"
import { PolicySummary } from "@/features/privacy/PolicySummary"
import { PrivacyPolicyForm } from "@/features/privacy/PrivacyPolicyForm"
import { usePrivacy, useSavePrivacy } from "@/features/privacy/api"

// The audit log tab is for workspace admins, as its API is.
const TAB_ITEMS = [
  { value: "policy", label: "Policy", icon: ShieldCheck, adminOnly: false },
  { value: "audit", label: "Audit log", icon: ScrollText, adminOnly: true },
] as const
type Tab = (typeof TAB_ITEMS)[number]["value"]

function PolicyTab({ canManage }: { canManage: boolean }) {
  const { data, isPending, isError } = usePrivacy()
  const save = useSavePrivacy()
  if (isPending) return <Loader2 className="animate-spin text-muted-foreground" />
  if (isError) return <p className="text-sm text-destructive">Could not load the privacy settings.</p>

  return (
    // Form on the left, the summary on the right (stacked first on narrow screens).
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] xl:grid-cols-[minmax(0,1fr)_26rem]">
      <Card className="lg:sticky lg:top-4 lg:order-last">
        <CardHeader>
          <CardTitle>In effect</CardTitle>
          <CardDescription>What reviews in this workspace run under: the stricter of the two policies.</CardDescription>
        </CardHeader>
        <CardContent>
          <PolicySummary data={data} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Workspace policy</CardTitle>
          <CardDescription>Narrows the instance policy for this workspace. It can never loosen it.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          {!canManage && (
            <Alert>
              <Info />
              <AlertDescription>Only workspace owners and admins can change these settings.</AlertDescription>
            </Alert>
          )}
          <PrivacyPolicyForm
            scope="workspace"
            values={data.workspace}
            instance={data.instance}
            readOnly={!canManage}
            onSave={({ auditRetentionDays: _audit, ...layer }) => save.mutateAsync(layer)}
          />
        </CardContent>
      </Card>
    </div>
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
          <PolicyTab canManage={canManage} />
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
