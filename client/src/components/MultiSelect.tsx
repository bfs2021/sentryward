import { useState } from "react"
import { ChevronsUpDown, X } from "lucide-react"
import { cn } from "cn"
import { Badge } from "@/components/ui/badge"
import { Command, CommandGroup, CommandItem, CommandList, CommandSeparator } from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import type { SelectOption } from "./SearchableSelect"

// Badges shown on the trigger before the rest collapse into "+N".
const MAX_SHOWN = 3

// Picks any number of options from a short list. The list stays open while
// toggling so several can be chosen in one go; an empty selection shows the
// placeholder, which callers use for "no restriction".
export function MultiSelect({
  id,
  values,
  onValuesChange,
  options,
  placeholder = "Select...",
  disabled,
  className,
  "aria-invalid": ariaInvalid,
}: {
  id?: string
  values: string[]
  onValuesChange: (values: string[]) => void
  options: SelectOption[]
  placeholder?: string
  disabled?: boolean
  className?: string
  "aria-invalid"?: boolean
}) {
  const [open, setOpen] = useState(false)
  // Kept in option order, whatever order they were picked in.
  const selected = options.filter((option) => values.includes(option.value))
  const shown = selected.slice(0, MAX_SHOWN)
  const hidden = selected.length - shown.length

  function toggle(value: string) {
    onValuesChange(values.includes(value) ? values.filter((v) => v !== value) : [...values, value])
  }

  return (
    <Popover open={open} onOpenChange={setOpen} modal>
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-invalid={ariaInvalid}
          disabled={disabled}
          data-placeholder={selected.length ? undefined : ""}
          className={cn(
            "flex min-h-8 w-full min-w-0 items-center gap-1 rounded-lg border border-input bg-transparent py-1 pr-2 pl-1.5 text-left text-sm transition-colors outline-none select-none hover:bg-muted/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-expanded:border-ring aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-placeholder:pl-2.5 data-placeholder:text-muted-foreground dark:bg-input/30 dark:hover:bg-input/50 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0",
            className,
          )}
        >
          {selected.length === 0 && <span className="truncate">{placeholder}</span>}
          <span className="flex min-w-0 flex-wrap gap-1">
            {shown.map((option) => (
              <Badge key={option.value} variant="secondary" className="font-normal">
                {option.icon && <option.icon />}
                {option.label}
              </Badge>
            ))}
            {hidden > 0 && (
              <Badge variant="secondary" className="font-normal">
                +{hidden}
              </Badge>
            )}
          </span>
          <ChevronsUpDown className="ml-auto size-4 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-(--radix-popover-trigger-width) min-w-56 p-0">
        <Command>
          <CommandList>
            <CommandGroup>
              {options.map((option) => (
                <CommandItem
                  key={option.value}
                  value={option.value}
                  keywords={[option.label, ...(option.keywords ?? [])]}
                  disabled={option.disabled}
                  data-checked={values.includes(option.value)}
                  onSelect={() => toggle(option.value)}
                >
                  {option.icon && <option.icon />}
                  <span className="truncate">{option.label}</span>
                  {option.description && <span className="truncate text-muted-foreground">{option.description}</span>}
                  {option.badge}
                </CommandItem>
              ))}
            </CommandGroup>
            {selected.length > 0 && (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem value="__clear" onSelect={() => onValuesChange([])}>
                    <X />
                    Clear selection
                  </CommandItem>
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
