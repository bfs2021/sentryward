import { useState } from "react"
import { describe, expect, it } from "vitest"
import { render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { MultiSelect } from "./MultiSelect"
import type { SelectOption } from "./SearchableSelect"

const fruits: SelectOption[] = [
  { value: "apple", label: "Apple" },
  { value: "banana", label: "Banana" },
  { value: "cherry", label: "Cherry", disabled: true, badge: <span>Out of season</span> },
]

function Harness({ initial = [] }: { initial?: string[] }) {
  const [values, setValues] = useState(initial)
  return (
    <>
      <label htmlFor="fruit">Fruit</label>
      <MultiSelect id="fruit" values={values} onValuesChange={setValues} options={fruits} placeholder="Any fruit" />
    </>
  )
}

// The open list is modal and hides the rest of the page from role queries, so
// tests grab the trigger before opening it.
const getTrigger = () => screen.getByRole("combobox", { name: "Fruit" })

describe("MultiSelect", () => {
  it("shows the placeholder when nothing is selected", () => {
    render(<Harness />)
    expect(getTrigger()).toHaveTextContent("Any fruit")
  })

  it("toggles several options without closing", async () => {
    render(<Harness />)
    const trigger = getTrigger()
    await userEvent.click(trigger)
    await userEvent.click(screen.getByRole("option", { name: "Banana" }))
    await userEvent.click(screen.getByRole("option", { name: "Apple" }))

    expect(screen.getByRole("option", { name: "Apple" })).toHaveAttribute("data-checked", "true")
    // Shown in option order, not pick order.
    expect(trigger).toHaveTextContent("AppleBanana")

    await userEvent.click(screen.getByRole("option", { name: "Banana" }))
    expect(trigger).toHaveTextContent(/^Apple$/)
  })

  it("clears the selection", async () => {
    render(<Harness initial={["apple", "banana"]} />)
    const trigger = getTrigger()
    await userEvent.click(trigger)
    await userEvent.click(screen.getByRole("option", { name: "Clear selection" }))

    expect(trigger).toHaveTextContent("Any fruit")
    expect(screen.queryByRole("option", { name: "Clear selection" })).not.toBeInTheDocument()
  })

  it("marks disabled options with their badge", async () => {
    render(<Harness />)
    await userEvent.click(getTrigger())
    const cherry = screen.getByRole("option", { name: /Cherry/ })
    expect(cherry).toHaveAttribute("aria-disabled", "true")
    expect(within(cherry).getByText("Out of season")).toBeInTheDocument()
  })
})
