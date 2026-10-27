import { Link } from "react-router"
import { formatUsd } from "@/features/usage/format"
import type { CostFigures } from "./types"

export function Dash() {
  return <span className="text-muted-foreground">-</span>
}

export function Rate({ value }: { value: number | null }) {
  return value === null ? <Dash /> : `${value}%`
}

// A cost no call had a price for is unknown, not $0; one only some calls had
// a price for is a floor.
export function Cost({ usd, partial }: { usd: number | null; partial: CostFigures["partial"] }) {
  if (usd === null) {
    return (
      <Link to="/llm-connections" className="text-muted-foreground underline underline-offset-2 hover:text-foreground">
        Unknown
      </Link>
    )
  }
  return (
    <span title={partial ? "Some calls had no price, so this is at least what they cost" : undefined}>
      {partial && "≥ "}
      {formatUsd(usd)}
    </span>
  )
}
