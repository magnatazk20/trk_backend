import { useLocation, useNavigate } from 'react-router-dom'
import './AppBottomNav.css'

function NavIcon({
  name,
  className = 'icon-sm',
}: {
  name: 'home' | 'tasks' | 'vjp' | 'invite' | 'user'
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
          <path d="M12 4v4M20 12h-4M12 20v-4M4 12h4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
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
    default:
      return null
  }
}

export default function AppBottomNav() {
  const navigate = useNavigate()
  const { pathname } = useLocation()

  const isActive = (route: string) => pathname === route

  return (
    <nav className="app-bottom-nav">
      <button className={isActive('/dashboard') ? 'active' : ''} onClick={() => navigate('/dashboard')}>
        <NavIcon name="home" />
        <small>Início</small>
      </button>
      <button className={isActive('/tasks') ? 'active' : ''} onClick={() => navigate('/tasks')}>
        <NavIcon name="tasks" />
        <small>Tarefas</small>
      </button>
      <button className={isActive('/vip') ? 'active' : ''} onClick={() => navigate('/vip')}>
        <NavIcon name="vjp" />
        <small>VIP</small>
      </button>
      <button className={isActive('/invite') ? 'active' : ''} onClick={() => navigate('/invite')}>
        <NavIcon name="invite" />
        <small>Convidar</small>
      </button>
      <button className={isActive('/profile') ? 'active' : ''} onClick={() => navigate('/profile')}>
        <NavIcon name="user" />
        <small>Perfil</small>
      </button>
    </nav>
  )
}
