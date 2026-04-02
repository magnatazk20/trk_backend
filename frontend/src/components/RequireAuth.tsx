import { Navigate, useLocation } from 'react-router-dom'

type RequireAuthProps = {
  children: React.ReactNode
}

export default function RequireAuth({ children }: RequireAuthProps) {
  const location = useLocation()

  const token = localStorage.getItem('token') ?? sessionStorage.getItem('token')
  const rawUser = localStorage.getItem('user') ?? sessionStorage.getItem('user')

  if (!token || !rawUser) {
    return <Navigate to="/" replace state={{ from: location.pathname }} />
  }

  try {
    JSON.parse(rawUser)
  } catch {
    localStorage.removeItem('token')
    localStorage.removeItem('user')
    sessionStorage.removeItem('token')
    sessionStorage.removeItem('user')
    return <Navigate to="/" replace state={{ from: location.pathname }} />
  }

  return children
}
