import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

type AdminUser = {
  name?: string
  phone?: string
}

export default function AdminSidebar() {
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)

  const user = useMemo(() => {
    const raw = localStorage.getItem('user') ?? sessionStorage.getItem('user')
    if (!raw) return null
    try {
      return JSON.parse(raw) as AdminUser
    } catch {
      return null
    }
  }, [])

  return (
    <>
      <header className="admin-mobile-topbar">
        <button
          type="button"
          className="menu-toggle"
          aria-label="Abrir menu admin"
          onClick={() => setMenuOpen(true)}
        >
          ☰
        </button>
        <div className="admin-mobile-user">
          <strong>Admin</strong>
          <small>{user?.name ?? 'Administrador'}</small>
        </div>
      </header>

      {menuOpen ? (
        <button
          type="button"
          className="dash-overlay"
          aria-label="Fechar menu admin"
          onClick={() => setMenuOpen(false)}
        />
      ) : null}

      <aside className={`dash-sidebar admin-dash-sidebar ${menuOpen ? 'open' : ''}`}>
        <div className="dash-brand">
          <div className="brand-logo">A</div>
          <div>
            <strong>Admin Panel</strong>
            <small>{user?.name ?? 'Administrador'}</small>
          </div>
        </div>

        <div className="admin-dash-user-chip">
          <span>{user?.phone ?? '-'}</span>
        </div>

        <nav className="dash-nav">
          <p className="dash-nav-group-title">Gestão</p>
          <button type="button" className="dash-nav-item" onClick={() => { navigate('/adf'); setMenuOpen(false) }}>Dashboard Admin</button>
          <button type="button" className="dash-nav-item" onClick={() => { navigate('/adf/users'); setMenuOpen(false) }}>Usuários</button>
          <button type="button" className="dash-nav-item" onClick={() => { navigate('/adf/withdraw-config'); setMenuOpen(false) }}>Configuração de Saque</button>
          <button type="button" className="dash-nav-item" onClick={() => { navigate('/adf/rankings'); setMenuOpen(false) }}>Ganhos e Saques</button>

          <p className="dash-nav-group-title">Sistema</p>
          <button type="button" className="dash-nav-item" onClick={() => { navigate('/adf/site-settings'); setMenuOpen(false) }}>Editar Site</button>
          <button type="button" className="dash-nav-item" onClick={() => { navigate('/adf/logs'); setMenuOpen(false) }}>Perfil</button>
        </nav>

        <button
          type="button"
          className="dash-logout side"
          onClick={() => {
            localStorage.removeItem('token')
            localStorage.removeItem('user')
            sessionStorage.removeItem('token')
            sessionStorage.removeItem('user')
            navigate('/')
          }}
        >
          Sair
        </button>
      </aside>
    </>
  )
}
