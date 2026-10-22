import type { ReactNode } from "react"
import { Navigate, useSearchParams } from "react-router"
import { KeyRound, LockKeyhole, TriangleAlert, UserRound } from "lucide-react"
import { PageHeader } from "@/components/PageHeader"
import { PageShell } from "@/components/PageShell"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useAuth } from "@/features/auth/useAuth"
import { ApiTokens } from "@/features/settings/ApiTokens"
import { AvatarForm } from "@/features/settings/AvatarForm"
import { DeleteAccount } from "@/features/settings/DeleteAccount"
import { PasswordForm } from "@/features/settings/PasswordForm"
import { ProfileForm } from "@/features/settings/ProfileForm"

const TAB_ITEMS = [
  { value: "profile", label: "Profile", icon: UserRound },
  { value: "password", label: "Password", icon: LockKeyhole },
  { value: "tokens", label: "API tokens", icon: KeyRound },
  { value: "account", label: "Account", icon: TriangleAlert },
] as const
type Tab = (typeof TAB_ITEMS)[number]["value"]
const TABS: readonly string[] = TAB_ITEMS.map((item) => item.value)

function Section({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

export function SettingsPage() {
  const { user } = useAuth()
  // ?tab= keeps the open tab linkable, e.g. /settings?tab=password.
  const [params, setParams] = useSearchParams()
  const requested = params.get("tab")
  const tab = requested && TABS.includes(requested) ? (requested as Tab) : "profile"

  // LLM connections moved to their own page; keep old bookmarks working.
  if (requested === "api-keys") return <Navigate to="/llm-connections" replace />
  if (!user) return null

  return (
    <PageShell>
      <PageHeader title="Settings" description="Manage your profile, password, API tokens and account." />
      <Tabs className="max-w-3xl" value={tab} onValueChange={(value) => setParams({ tab: value }, { replace: true })}>
        <TabsList>
          {TAB_ITEMS.map((item) => (
            <TabsTrigger key={item.value} value={item.value}>
              <item.icon />
              <span>{item.label}</span>
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="profile">
          <div className="flex flex-col gap-6">
            <Section title="Profile picture" description="Shown next to your name across Sentryward.">
              <AvatarForm user={user} />
            </Section>
            <Section title="Profile" description="Your name and the email you sign in with.">
              <ProfileForm user={user} />
            </Section>
          </div>
        </TabsContent>
        <TabsContent value="password">
          <Section
            title="Password"
            description="Choose a new password of at least 8 characters. Changing it signs you out on other devices."
          >
            <PasswordForm />
          </Section>
        </TabsContent>
        <TabsContent value="tokens">
          <Section
            title="API tokens"
            description="Personal tokens for scripts and CI. Revoke any you no longer use."
          >
            <ApiTokens />
          </Section>
        </TabsContent>
        <TabsContent value="account">
          <Section title="Delete account" description="Remove your account and everything it owns.">
            <DeleteAccount />
          </Section>
        </TabsContent>
      </Tabs>
    </PageShell>
  )
}
