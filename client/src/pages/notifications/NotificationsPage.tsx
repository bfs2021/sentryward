import { PageHeader } from "@/components/PageHeader"
import { PageShell } from "@/components/PageShell"
import { NotificationTargets } from "@/features/notifications/NotificationTargets"

export function NotificationsPage() {
  return (
    <PageShell>
      <PageHeader
        title="Notifications"
        description="Webhooks, Slack channels and email that hear about blocked, failed or completed reviews."
      />
      <NotificationTargets />
    </PageShell>
  )
}
