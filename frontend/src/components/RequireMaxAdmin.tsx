import { Navigate, useLocation } from 'react-router-dom'

type RequireMaxAdminProps = {
  children: React.ReactNode
}

type StoredUser = {
  id?: number
  name?: string
  phone?: string
  is_admin?: number | string
  isAdmin?: number | string | boolean
}

export default function RequireMaxAdmin({ children }: RequireMaxAdminProps) {
  const location = useLocation()

  const token = localStorage.getItem('token') ?? sessionStorage.getItem('token')
  const rawUser = localStorage.getItem('user') ?? sessionStorage.getItem('user')

  if (!token || !rawUser) {
    return <Navigate to="/" replace state={{ from: location.pathname }} />
  }

  try {
    const user = JSON.parse(rawUser) as StoredUser

    const normalizeToNumber = (value: unknown) => {
      if (typeof value === 'boolean') return value ? 1 : 0
      const asNumber = Number(value)
      return Number.isFinite(asNumber) ? asNumber : 0
    }

    const fromSnake = normalizeToNumber(user.is_admin)
    const fromCamel = normalizeToNumber(user.isAdmin)
    const isAdminNumeric = Math.max(fromSnake, fromCamel)

    if (isAdminNumeric >= 1) {
      return children
    }

    return <Navigate to="/dashboard" replace />
  } catch {
    localStorage.removeItem('token')
    localStorage.removeItem('user')
    sessionStorage.removeItem('token')
    sessionStorage.removeItem('user')
    return <Navigate to="/" replace state={{ from: location.pathname }} />
  }
}
