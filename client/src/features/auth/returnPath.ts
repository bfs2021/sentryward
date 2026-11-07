// The page a login was sent from (a protected page, an invite), read from
// router state. Only a path on this origin is honoured, so a crafted state
// cannot send the user to another site after signing in.
export function returnPath(state: unknown): string | null {
  const from = (state as { from?: unknown } | null)?.from
  if (typeof from !== "string") return null
  return from.startsWith("/") && !from.startsWith("//") && !from.includes("\\") ? from : null
}
