import { useSearchParams } from "react-router"
import { CircleDollarSign, KeyRound } from "lucide-react"
import { PageHeader } from "@/components/PageHeader"
import { PageShell } from "@/components/PageShell"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { LlmConnectionsCard } from "@/features/llm-connections/LlmConnectionsCard"
import { ModelPricesCard } from "@/features/model-prices/ModelPricesCard"

const TAB_ITEMS = [
  { value: "connections", label: "Connections", icon: KeyRound },
  { value: "prices", label: "Model prices", icon: CircleDollarSign },
] as const
type Tab = (typeof TAB_ITEMS)[number]["value"]
const TABS: readonly string[] = TAB_ITEMS.map((item) => item.value)

export function LlmConnectionsPage() {
  // ?tab= keeps the open tab linkable, e.g. /llm-connections?tab=prices.
  const [params, setParams] = useSearchParams()
  const requested = params.get("tab")
  const tab = requested && TABS.includes(requested) ? (requested as Tab) : "connections"

  return (
    <PageShell>
      <PageHeader
        title="LLM Connections"
        description="Provider credentials, custom API hosts and model prices that reviews run with."
      />
      <Tabs value={tab} onValueChange={(value) => setParams({ tab: value }, { replace: true })}>
        <TabsList>
          {TAB_ITEMS.map((item) => (
            <TabsTrigger key={item.value} value={item.value}>
              <item.icon />
              <span>{item.label}</span>
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="connections">
          <LlmConnectionsCard />
        </TabsContent>
        <TabsContent value="prices">
          <ModelPricesCard />
        </TabsContent>
      </Tabs>
    </PageShell>
  )
}
