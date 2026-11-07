import type { ComponentType } from "react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export interface SegmentedOption<T extends string> {
  value: T
  label: string
  icon?: ComponentType<{ className?: string }>
}

// A few options side by side, one click each. Toggle buttons rather than a
// radio group: `value` may match none of them (e.g. a preset the form no
// longer matches), and aria-pressed says which one is current.
export function SegmentedControl<T extends string>(props: {
  label: string
  options: SegmentedOption<T>[]
  value: T | undefined
  onChange: (value: T) => void
  disabled?: boolean
  className?: string
}) {
  return (
    <div
      role="group"
      aria-label={props.label}
      className={cn("inline-flex w-fit flex-wrap gap-0.5 rounded-lg border bg-muted p-0.5", props.className)}
    >
      {props.options.map((option) => {
        const pressed = option.value === props.value
        return (
          <Button
            key={option.value}
            type="button"
            variant="ghost"
            size="sm"
            aria-pressed={pressed}
            disabled={props.disabled}
            onClick={() => props.onChange(option.value)}
            className={cn("h-7 px-2.5", pressed && "bg-background shadow-xs hover:bg-background")}
          >
            {option.icon && <option.icon className="size-3.5" />}
            {option.label}
          </Button>
        )
      })}
    </div>
  )
}
