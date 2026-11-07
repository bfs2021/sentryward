import { Navigate, Outlet, useLocation } from "react-router"
import { useAuth } from "./useAuth"
import { FullPageSpinner } from "./FullPageSpinner"
import { returnPath } from "./returnPath"

export function PublicOnlyRoute() {
  const { user, isLoading } = useAuth()
  const location = useLocation()

  if (isLoading) {
    return <FullPageSpinner />
  }
  if (user) {
    // Logging in re-renders this before the login page can navigate, so the
    // page you were sent here from (a protected page, an invite) is honoured
    // here too.
    return <Navigate to={returnPath(location.state) ?? "/home"} replace />
  }
  return <Outlet />
}
