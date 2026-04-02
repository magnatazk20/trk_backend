import { useEffect, useMemo, useState } from 'react'
import AdminSidebar from '../components/AdminSidebar'
import './Admin.css'
import './AdminUsers.css'

type AdminUser = {
  id: number
  name: string
  phone: string
  is_admin: number
  is_banned: number
  created_at?: string
}

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3333'

export default function AdminUsers() {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [users, setUsers] = useState<AdminUser[]>([])
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editName, setEditName] = useState('')
  const [editPhone, setEditPhone] = useState('')
  const [saving, setSaving] = useState(false)

  const token = useMemo(
    () => localStorage.getItem('token') ?? sessionStorage.getItem('token') ?? '',
    []
  )

  const loadUsers = async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`${API_URL}/api/admin/users`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })

      const data = (await res.json()) as {
        ok?: boolean
        error?: string
        users?: AdminUser[]
      }

      if (!res.ok || !data?.ok) {
        setError(data?.error ?? 'Falha ao carregar usuários.')
        setUsers([])
        return
      }

      setUsers(Array.isArray(data.users) ? data.users : [])
    } catch {
      setError('Erro de conexão ao carregar usuários.')
      setUsers([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadUsers()
  }, [])

  const startEdit = (user: AdminUser) => {
    setEditingId(user.id)
    setEditName(user.name ?? '')
    setEditPhone(user.phone ?? '')
  }

  const cancelEdit = () => {
    setEditingId(null)
    setEditName('')
    setEditPhone('')
  }

  const saveEdit = async (id: number) => {
    if (!editName.trim() || !editPhone.trim()) {
      setError('Nome e telefone são obrigatórios.')
      return
    }

    setSaving(true)
    setError('')
    try {
      const res = await fetch(`${API_URL}/api/admin/users/${id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ name: editName.trim(), phone: editPhone.trim() }),
      })

      const data = (await res.json()) as { ok?: boolean; error?: string }

      if (!res.ok || !data?.ok) {
        setError(data?.error ?? 'Falha ao atualizar usuário.')
        return
      }

      await loadUsers()
      cancelEdit()
    } catch {
      setError('Erro de conexão ao atualizar usuário.')
    } finally {
      setSaving(false)
    }
  }

  const deleteUser = async (id: number) => {
    const confirmed = window.confirm('Deseja realmente apagar este usuário?')
    if (!confirmed) return

    setError('')
    try {
      const res = await fetch(`${API_URL}/api/admin/users/${id}`, {
        method: 'DELETE',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      const data = (await res.json()) as { ok?: boolean; error?: string }
      if (!res.ok || !data?.ok) {
        setError(data?.error ?? 'Falha ao apagar usuário.')
        return
      }
      await loadUsers()
    } catch {
      setError('Erro de conexão ao apagar usuário.')
    }
  }

  const toggleBan = async (user: AdminUser) => {
    setError('')
    try {
      const nextBanned = user.is_banned ? 0 : 1
      const res = await fetch(`${API_URL}/api/admin/users/${user.id}/ban`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ is_banned: nextBanned }),
      })

      const data = (await res.json()) as { ok?: boolean; error?: string }
      if (!res.ok || !data?.ok) {
        setError(data?.error ?? 'Falha ao alterar banimento.')
        return
      }

      await loadUsers()
    } catch {
      setError('Erro de conexão ao alterar banimento.')
    }
  }

  const totalUsers = users.length
  const usersCreatedToday = users.filter((user) => {
    if (!user.created_at) return false
    const created = new Date(user.created_at)
    const now = new Date()
    return (
      created.getFullYear() === now.getFullYear() &&
      created.getMonth() === now.getMonth() &&
      created.getDate() === now.getDate()
    )
  }).length

  return (
    <main className="admin-page">
      <AdminSidebar />
      <section className="admin-content admin-users-page">
        <header className="admin-header">
          <div>
            <h1>Usuários Cadastrados</h1>
            <p className="admin-subtitle">Gerencie contas: editar, apagar e banir/desbanir.</p>
          </div>
        </header>

        {error ? <p className="admin-kpi-error">{error}</p> : null}

        <section className="admin-users-summary-grid">
          <article className="admin-kpi-card">
            <p>Usuários no total</p>
            <strong>{totalUsers}</strong>
          </article>
          <article className="admin-kpi-card">
            <p>Cadastrados hoje</p>
            <strong>{usersCreatedToday}</strong>
          </article>
        </section>

        <section className="admin-panel admin-users-panel">
          {loading ? (
            <p>Carregando usuários...</p>
          ) : (
            <div className="admin-users-table-wrap">
              <table className="admin-table admin-users-table">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Nome</th>
                    <th>Telefone</th>
                    <th>Admin</th>
                    <th>Status</th>
                    <th>Criado em</th>
                    <th>Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {users.length ? (
                    users.map((user) => {
                      const isEditing = editingId === user.id
                      return (
                        <tr key={user.id}>
                          <td>#{user.id}</td>
                          <td>
                            {isEditing ? (
                              <input
                                className="admin-users-input"
                                value={editName}
                                onChange={(e) => setEditName(e.target.value)}
                              />
                            ) : (
                              user.name
                            )}
                          </td>
                          <td>
                            {isEditing ? (
                              <input
                                className="admin-users-input"
                                value={editPhone}
                                onChange={(e) => setEditPhone(e.target.value)}
                              />
                            ) : (
                              user.phone
                            )}
                          </td>
                          <td>{user.is_admin ? 'Sim' : 'Não'}</td>
                          <td>
                            <span className={`status ${user.is_banned ? 'pending' : 'paid'}`}>
                              {user.is_banned ? 'Banido' : 'Ativo'}
                            </span>
                          </td>
                          <td>{user.created_at ? new Date(user.created_at).toLocaleString('pt-BR') : '-'}</td>
                          <td>
                            <div className="admin-users-actions">
                              {isEditing ? (
                                <>
                                  <button type="button" onClick={() => saveEdit(user.id)} disabled={saving}>
                                    Salvar
                                  </button>
                                  <button type="button" className="soft" onClick={cancelEdit} disabled={saving}>
                                    Cancelar
                                  </button>
                                </>
                              ) : (
                                <>
                                  <button type="button" className="soft" onClick={() => window.location.assign(`/adf/users/${user.id}`)}>Ver</button>
                                  <button type="button" onClick={() => startEdit(user)}>Editar</button>
                                  <button type="button" className="warn" onClick={() => deleteUser(user.id)}>Apagar</button>
                                  <button type="button" className="soft" onClick={() => toggleBan(user)}>
                                    {user.is_banned ? 'Desbanir' : 'Banir'}
                                  </button>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      )
                    })
                  ) : (
                    <tr>
                      <td colSpan={7}>Nenhum usuário encontrado.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </section>
    </main>
  )
}
