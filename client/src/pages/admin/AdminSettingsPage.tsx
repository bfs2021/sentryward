import { Loader2 } from "lucide-react"
import { Navigate } from "react-router"
import { PageHeader } from "@/components/PageHeader"
import { PageShell } from "@/components/PageShell"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { useAuth } from "@/features/auth/useAuth"
import { PrivacyPolicyForm } from "@/features/privacy/PrivacyPolicyForm"
import { useInstanceSettings, useSaveInstanceSettings } from "@/features/privacy/api"

export function AdminSettingsPage() {
  const { user } = useAuth()
  const { data, isPending, isError } = useInstanceSettings()
  const save = useSaveInstanceSettings()
  if (!user) return null
  if (user.role !== "admin") return <Navigate to="/home" replace />

  return (
    <PageShell>
      <PageHeader title="Instance settings" description="Privacy rules that apply to every workspace on this instance." />
      <Card>
        <CardHeader>
          <CardTitle>Privacy policy</CardTitle>
          <CardDescription>
            Workspaces can narrow these rules but never loosen them. A repository's .sentryward.yaml cannot change
            them either.
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
    </PageShell>
  )
}
