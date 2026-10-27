import { PageHeader } from "@/components/PageHeader"
import { PageShell } from "@/components/PageShell"
import { LlmConnectionsCard } from "@/features/llm-connections/LlmConnectionsCard"
import { ModelPricesCard } from "@/features/model-prices/ModelPricesCard"

export function LlmConnectionsPage() {
  return (
    <PageShell>
      <PageHeader
        title="LLM Connections"
        description="Provider credentials, custom API hosts and model prices that reviews run with."
      />
      <LlmConnectionsCard />
      <ModelPricesCard />
    </PageShell>
  )
}
