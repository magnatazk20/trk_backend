import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import './AppSidebar.css'

type StoredUser = {
  id: number
  name: string
  phone: string
}

type VipResponse = {
  ok?: boolean
  hasVip?: boolean
  vip?: {
    levelName?: string
  } | null
}

function SideIcon({
  name,
  className = 'icon-sm',
}: {
  name: 'home' | 'tasks' | 'vjp' | 'invite' | 'user' | 'menu' | 'logout' | 'extract' | 'withdraw' | 'deposit'
  className?: string
}) {
  switch (name) {
    case 'home':
      return (
        <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3 10.5L12 3l9 7.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <path d="M6 9.5V20h12V9.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      )
    case 'tasks':
      return (
        <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
          <path d="M8 7h11M8 12h11M8 17h11" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <circle cx="5" cy="7" r="1.2" fill="currentColor" />
          <circle cx="5" cy="12" r="1.2" fill="currentColor" />
          <circle cx="5" cy="17" r="1.2" fill="currentColor" />
        </svg>
      )
    case 'vjp':
      return (
        <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <circle cx="12" cy="12" r="2" fill="currentColor" />
          <path d="M12 4v4M20 12h-4M12 20v-4M4 12h4M17.7 6.3l-2.8 2.8M17.7 17.7l-2.8-2.8M6.3 17.7l2.8-2.8M6.3 6.3l2.8 2.8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      )
    case 'invite':
      return (
        <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3.5" y="6.5" width="17" height="11" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <circle cx="9" cy="12" r="2.3" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <circle cx="15.5" cy="12" r="1.7" fill="currentColor" />
        </svg>
      )
    case 'user':
      return (
        <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="8" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <path d="M5 20c.8-3 3.4-5 7-5s6.2 2 7 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      )
    case 'menu':
      return (
        <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 7h16M4 12h16M4 17h16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      )
    case 'logout':
      return (
        <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
          <path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <path d="M14 8l4 4-4 4M18 12H9" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )
    case 'extract':
      return (
        <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
          <rect x="4" y="3.5" width="16" height="17" rx="2.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <path d="M8 8h8M8 12h8M8 16h5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
        </svg>
      )
    case 'withdraw':
      return (
        <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 4v12M7.5 11.5L12 16l4.5-4.5" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
          <rect x="4.5" y="18" width="15" height="2.5" rx="1" fill="currentColor" />
        </svg>
      )
    case 'deposit':
      return (
        <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 20V8M16.5 12.5 12 8l-4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
          <rect x="4.5" y="3.5" width="15" height="2.5" rx="1" fill="currentColor" />
        </svg>
      )
    default:
      return null
  }
}

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3333'

export default function AppSidebar() {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [menuOpen, setMenuOpen] = useState(false)
  const [vipLabel, setVipLabel] = useState('Sem VIP')

  const raw = localStorage.getItem('user') ?? sessionStorage.getItem('user')
  let user: StoredUser | null = null
  if (raw) {
    try {
      user = JSON.parse(raw) as StoredUser
    } catch {
      user = null
    }
  }

  useEffect(() => {
    const loadVip = async () => {
      if (!user?.id) {
        setVipLabel('Sem VIP')
        return
      }

      try {
        const res = await fetch(`${API_URL}/api/vip/user/${user.id}`)
        if (!res.ok) {
          setVipLabel('Sem VIP')
          return
        }

        const data = await res.json() as VipResponse
        if (data?.ok && data?.hasVip && data.vip?.levelName) {
          setVipLabel(String(data.vip.levelName))
        } else {
          setVipLabel('Sem VIP')
        }
      } catch {
        setVipLabel('Sem VIP')
      }
    }

    loadVip()
  }, [user?.id])

  const go = (route: string) => {
    navigate(route)
    setMenuOpen(false)
  }

  const isActive = (route: string) => pathname === route

  const logout = () => {
    localStorage.removeItem('token')
    localStorage.removeItem('user')
    sessionStorage.removeItem('token')
    sessionStorage.removeItem('user')
    setMenuOpen(false)
    navigate('/')
  }

  return (
    <>
      <header className="dash-topbar app-sidebar-topbar">
        <button
          className="menu-toggle"
          onClick={() => setMenuOpen((v) => !v)}
          aria-label="Abrir menu"
          type="button"
        >
          <SideIcon name="menu" className="icon" />
        </button>
        <div className="user-chip app-sidebar-chip">
          <div className="avatar">{(user?.name?.[0] ?? 'U').toUpperCase()}</div>
          <div>
            <strong>{user?.name ?? 'Usuário'}</strong>
            <p>{user?.phone ?? '-'} • VIP: {vipLabel}</p>
          </div>
        </div>
      </header>

      {menuOpen ? (
        <button className="dash-overlay" onClick={() => setMenuOpen(false)} aria-label="Fechar menu" />
      ) : null}

      <aside className={`dash-sidebar ${menuOpen ? 'open' : ''}`}>
        <div className="dash-brand">
          <span className="brand-logo">N</span>
          <div>
            <strong>{user?.name ?? 'Usuário'}</strong>
            <small>{user?.phone ?? '-'} • VIP: {vipLabel}</small>
          </div>
        </div>

        <nav className="dash-nav">
          <p className="dash-nav-group-title">Principal</p>
          <button className={`dash-nav-item ${isActive('/dashboard') ? 'active' : ''}`} onClick={() => go('/dashboard')}>
            <SideIcon name="home" className="icon-sm" />
            <span>Início</span>
          </button>
          <button className={`dash-nav-item ${isActive('/tasks') ? 'active' : ''}`} onClick={() => go('/tasks')}>
            <SideIcon name="tasks" className="icon-sm" />
            <span>Tarefas</span>
          </button>
          <button className={`dash-nav-item ${isActive('/vip') ? 'active' : ''}`} onClick={() => go('/vip')}>
            <SideIcon name="vjp" className="icon-sm" />
            <span>VJP</span>
          </button>
          <button className={`dash-nav-item ${isActive('/invite') ? 'active' : ''}`} onClick={() => go('/invite')}>
            <SideIcon name="invite" className="icon-sm" />
            <span>Convidar</span>
          </button>
          <button className={`dash-nav-item ${isActive('/profile') ? 'active' : ''}`} onClick={() => go('/profile')}>
            <SideIcon name="user" className="icon-sm" />
            <span>Perfil</span>
          </button>

          <p className="dash-nav-group-title">Financeiro</p>
          <button className={`dash-nav-item ${isActive('/extrato') ? 'active' : ''}`} onClick={() => go('/extrato')}>
            <SideIcon name="extract" className="icon-sm" />
            <span>Extrato</span>
          </button>
          <button className={`dash-nav-item ${isActive('/saque') ? 'active' : ''}`} onClick={() => go('/saque')}>
            <SideIcon name="withdraw" className="icon-sm" />
            <span>Saque</span>
          </button>
          <button className={`dash-nav-item ${isActive('/cashin') ? 'active' : ''}`} onClick={() => go('/cashin')}>
            <SideIcon name="deposit" className="icon-sm" />
            <span>Depositar</span>
          </button>
        </nav>

        <button className="dash-logout side" onClick={logout}>
          <SideIcon name="logout" className="icon-sm" />
          <span>Sair da conta</span>
        </button>
      </aside>

      <nav className="dash-bottom-nav">
        <button className={isActive('/dashboard') ? 'active' : ''} onClick={() => go('/dashboard')}>
          <SideIcon name="home" className="icon-sm" />
          <small>Início</small>
        </button>
        <button className={isActive('/tasks') ? 'active' : ''} onClick={() => go('/tasks')}>
          <SideIcon name="tasks" className="icon-sm" />
          <small>Tarefas</small>
        </button>
        <button className={isActive('/vip') ? 'active' : ''} onClick={() => go('/vip')}>
          <SideIcon name="vjp" className="icon-sm" />
          <small>VIP</small>
        </button>
        <button className={isActive('/invite') ? 'active' : ''} onClick={() => go('/invite')}>
          <SideIcon name="invite" className="icon-sm" />
          <small>Convidar</small>
        </button>
        <button className={isActive('/profile') ? 'active' : ''} onClick={() => go('/profile')}>
          <SideIcon name="user" className="icon-sm" />
          <small>Perfil</small>
        </button>
      </nav>
    </>
  )
}
