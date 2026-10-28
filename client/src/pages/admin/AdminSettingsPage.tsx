import { Navigate, useSearchParams } from "react-router"
import { Loader2, ScrollText, ShieldCheck } from "lucide-react"
import { PageHeader } from "@/components/PageHeader"
import { PageShell } from "@/components/PageShell"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useAuth } from "@/features/auth/useAuth"
import { AuditLogTable } from "@/features/privacy/AuditLogTable"
import { PrivacyPolicyForm } from "@/features/privacy/PrivacyPolicyForm"
import { useInstanceSettings, useSaveInstanceSettings } from "@/features/privacy/api"

const TAB_ITEMS = [
  { value: "policy", label: "Policy", icon: ShieldCheck },
  { value: "audit", label: "Audit log", icon: ScrollText },
] as const
type Tab = (typeof TAB_ITEMS)[number]["value"]

function PolicyCard() {
  const { data, isPending, isError } = useInstanceSettings()
  const save = useSaveInstanceSettings()
  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle>Privacy policy</CardTitle>
        <CardDescription>
          Workspaces can narrow these rules but never loosen them. A repository's .sentryward.yaml cannot change them
          either.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isPending ? (
          <Loader2 className="animate-spin text-muted-foreground" />
        ) : isError ? (
          <p className="text-sm text-destructive">Could not load the instance settings.</p>
        ) : (
          <PrivacyPolicyForm
            scope="instance"
            values={data.settings}
            envRetentionDays={data.env.reviewRetentionDays}
            onSave={(settings) => save.mutateAsync(settings)}
          />
        )}
      </CardContent>
    </Card>
  )
}

// The instance-wide counterpart of the Privacy page: the policy every
// workspace runs under and the audit log of every workspace.
export function AdminSettingsPage() {
  const { user } = useAuth()
  // ?tab= keeps the open tab linkable, e.g. /admin/settings?tab=audit.
  const [params, setParams] = useSearchParams()
  const requested = params.get("tab")
  const tab: Tab = TAB_ITEMS.find((item) => item.value === requested)?.value ?? "policy"
  if (!user) return null
  if (user.role !== "admin") return <Navigate to="/home" replace />

  return (
    <PageShell>
      <PageHeader
        title="Instance settings"
        description="Privacy rules for every workspace on this instance, and a log of every model request."
      />
      <Tabs className="flex-1" value={tab} onValueChange={(value) => setParams({ tab: value }, { replace: true })}>
        <TabsList>
          {TAB_ITEMS.map((item) => (
            <TabsTrigger key={item.value} value={item.value}>
              <item.icon />
              <span>{item.label}</span>
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="policy">
          <PolicyCard />
        </TabsContent>
        <TabsContent value="audit" className="flex flex-col gap-4">
          <AuditLogTable scope="instance" />
        </TabsContent>
      </Tabs>
    </PageShell>
  )
}
