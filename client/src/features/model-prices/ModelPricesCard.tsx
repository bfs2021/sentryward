import { useState } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { AlertTriangle, Loader2, Pencil, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { z } from "zod"
import { Alert, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { TextField } from "@/features/auth/TextField"
import { applyServerErrors } from "@/features/auth/applyServerErrors"
import { useAuth } from "@/features/auth/useAuth"
import { useDeleteModelPrice, useModelPrices, useSaveModelPrice, type ModelPrice, type SavedModelPrice } from "./api"

const rate = (required: boolean) =>
  z
    .string()
    .trim()
    .refine((value) => !required || value !== "", "Enter a price")
    .refine((value) => value === "" || (Number.isFinite(Number(value)) && Number(value) >= 0), "Enter a price of 0 or more")

const priceSchema = z.object({
  model: z.string().trim().min(1, "Enter a model").regex(/^\S+$/, "A model id has no spaces"),
  input: rate(true),
  output: rate(true),
  cached: rate(false),
  cacheWrite: rate(false),
  reasoning: rate(false),
})
type PriceForm = z.infer<typeof priceSchema>

const asText = (value: number | undefined) => (value === undefined ? "" : String(value))
const asRate = (value: string) => (value === "" ? null : Number(value))

const perMillion = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 4 })

function rateCell(value: number | undefined) {
  return value === undefined ? <span className="text-muted-foreground">-</span> : perMillion.format(value)
}

// What the dialog opens on: a saved price to change, or a model (maybe
// prefilled from one the workspace used) to price.
type Editing = { model: string; price?: ModelPrice }

function PriceDialog({ editing, onOpenChange }: { editing: Editing | null; onOpenChange: (open: boolean) => void }) {
  const save = useSaveModelPrice()
  const form = useForm<PriceForm>({
    resolver: zodResolver(priceSchema),
    values: {
      model: editing?.model ?? "",
      input: asText(editing?.price?.input),
      output: asText(editing?.price?.output),
      cached: asText(editing?.price?.cached),
      cacheWrite: asText(editing?.price?.cacheWrite),
      reasoning: asText(editing?.price?.reasoning),
    },
  })

  async function onSubmit(values: PriceForm) {
    try {
      await save.mutateAsync({
        model: values.model,
        input: Number(values.input),
        output: Number(values.output),
        cached: asRate(values.cached),
        cacheWrite: asRate(values.cacheWrite),
        reasoning: asRate(values.reasoning),
      })
      toast.success(`Saved the price for ${values.model}`)
      onOpenChange(false)
    } catch (error) {
      applyServerErrors(error, form.setError)
    }
  }

  return (
    <Dialog open={editing !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Model price</DialogTitle>
            <DialogDescription>
              USD per million tokens. Applies to reviews from now on; past reviews keep the cost they recorded.
            </DialogDescription>
          </DialogHeader>
          <TextField
            control={form.control}
            name="model"
            label="Model"
            placeholder="openai/gpt-5.6"
            autoComplete="off"
            className="font-mono"
          />
          <div className="grid grid-cols-2 gap-4">
            <TextField control={form.control} name="input" label="Input" inputMode="decimal" />
            <TextField control={form.control} name="output" label="Output" inputMode="decimal" />
            <TextField control={form.control} name="cached" label="Cache read" inputMode="decimal" placeholder="As input" />
            <TextField control={form.control} name="cacheWrite" label="Cache write" inputMode="decimal" placeholder="As input" />
            <TextField control={form.control} name="reasoning" label="Reasoning" inputMode="decimal" placeholder="As output" />
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting && <Loader2 className="animate-spin" />}
              Save price
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function RemoveButton({ price }: { price: SavedModelPrice }) {
  const remove = useDeleteModelPrice()
  async function onRemove() {
    try {
      await remove.mutateAsync(price.id)
      toast.success(`Removed the price for ${price.model}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not remove the price")
    }
  }
  return (
    <Button variant="ghost" size="icon" aria-label={`Remove the price for ${price.model}`} onClick={onRemove} disabled={remove.isPending}>
      <Trash2 />
    </Button>
  )
}

// The workspace's own model prices, which reviews' costs are worked out at
// instead of the built-in table. Members see them; admins change them.
export function ModelPricesCard() {
  const { workspace } = useAuth()
  const canManage = workspace?.role === "owner" || workspace?.role === "admin"
  const { data, isPending, isError } = useModelPrices()
  const [editing, setEditing] = useState<Editing | null>(null)

  const priced = new Set(data?.prices.map((p) => p.model))
  const unknown = (data?.models ?? []).filter((m) => m.builtIn === null && !priced.has(m.model))

  return (
    <Card>
      <CardHeader>
        <CardTitle>Model prices</CardTitle>
        <CardDescription>
          What review costs are estimated at. A model with no price here or in the built-in table shows its cost as
          unknown.
        </CardDescription>
        {canManage && (
          <CardAction>
            <Button size="sm" onClick={() => setEditing({ model: "" })}>
              <Plus />
              Add price
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : isError ? (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>Could not load model prices.</AlertTitle>
          </Alert>
        ) : (
          <>
            {unknown.length > 0 && (
              <Alert>
                <AlertTriangle />
                <AlertTitle>
                  {unknown.length === 1 ? "1 model" : `${unknown.length} models`} used recently {unknown.length === 1 ? "has" : "have"} no price
                </AlertTitle>
                <div className="col-start-2 flex flex-wrap gap-2 pt-1">
                  {unknown.map(({ model }) =>
                    canManage ? (
                      <Button key={model} variant="outline" size="sm" className="font-mono text-xs" onClick={() => setEditing({ model })}>
                        {model}
                      </Button>
                    ) : (
                      <Badge key={model} variant="outline" className="font-mono">
                        {model}
                      </Badge>
                    ),
                  )}
                </div>
              </Alert>
            )}
            <Table aria-label="Model prices">
              <TableHeader>
                <TableRow>
                  <TableHead>Model</TableHead>
                  <TableHead className="text-right">Input</TableHead>
                  <TableHead className="text-right">Output</TableHead>
                  <TableHead className="text-right">Cache read</TableHead>
                  <TableHead className="text-right">Cache write</TableHead>
                  <TableHead className="text-right">Reasoning</TableHead>
                  {canManage && (
                    <TableHead className="w-0">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.prices.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-mono text-xs">{row.model}</TableCell>
                    <TableCell className="text-right tabular-nums">{rateCell(row.price.input)}</TableCell>
                    <TableCell className="text-right tabular-nums">{rateCell(row.price.output)}</TableCell>
                    <TableCell className="text-right tabular-nums">{rateCell(row.price.cached)}</TableCell>
                    <TableCell className="text-right tabular-nums">{rateCell(row.price.cacheWrite)}</TableCell>
                    <TableCell className="text-right tabular-nums">{rateCell(row.price.reasoning)}</TableCell>
                    {canManage && (
                      <TableCell>
                        <div className="flex justify-end">
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Edit the price for ${row.model}`}
                            onClick={() => setEditing({ model: row.model, price: row.price })}
                          >
                            <Pencil />
                          </Button>
                          <RemoveButton price={row} />
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
                {data.prices.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={canManage ? 7 : 6} className="py-6 text-center text-muted-foreground">
                      No prices of your own. Reviews use the built-in prices.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </>
        )}
      </CardContent>
      <PriceDialog editing={editing} onOpenChange={(open) => !open && setEditing(null)} />
    </Card>
  )
}
