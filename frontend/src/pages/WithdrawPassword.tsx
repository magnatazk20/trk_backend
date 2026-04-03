import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import AppSidebar from '../components/AppSidebar'
import './Tasks.css'
import './WithdrawPassword.css'

type StoredUser = {
  id: number
  name: string
  phone: string
}

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3333'

export default function WithdrawPassword() {
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [statusLoading, setStatusLoading] = useState(true)
  const [hasWithdrawPassword, setHasWithdrawPassword] = useState<boolean | null>(null)
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null)

  const user = useMemo(() => {
    const raw = localStorage.getItem('user') ?? sessionStorage.getItem('user')
    if (!raw) return null
    try {
      return JSON.parse(raw) as StoredUser
    } catch {
      return null
    }
  }, [])

  useEffect(() => {
    const loadStatus = async () => {
      if (!user?.id) {
        setStatusLoading(false)
        return
      }

      try {
        const res = await fetch(`${API_URL}/api/user/withdraw-password/status/${user.id}`)
        const data = await res.json() as { ok?: boolean; hasWithdrawPassword?: boolean }

        if (res.ok && data?.ok) {
          setHasWithdrawPassword(Boolean(data.hasWithdrawPassword))
        } else {
          setHasWithdrawPassword(null)
        }
      } catch {
        setHasWithdrawPassword(null)
      } finally {
        setStatusLoading(false)
      }
    }

    loadStatus()
  }, [user?.id])

  const saveWithdrawPassword = async () => {
    if (!user?.id) {
      setFeedback({ type: 'error', message: 'Usuário não autenticado.' })
      return
    }

    if (!password || password.length < 6) {
      setFeedback({ type: 'error', message: 'A senha de saque deve ter no mínimo 6 caracteres.' })
      return
    }

    if (password !== confirmPassword) {
      setFeedback({ type: 'error', message: 'As senhas não conferem.' })
      return
    }

    setLoading(true)
    setFeedback(null)

    try {
      const res = await fetch(`${API_URL}/api/user/withdraw-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id, password }),
      })

      const data = await res.json() as { ok?: boolean; error?: string; message?: string }

      if (!res.ok || !data?.ok) {
        setFeedback({ type: 'error', message: data?.error ?? 'Não foi possível salvar a senha.' })
        return
      }

      setPassword('')
      setConfirmPassword('')
      setHasWithdrawPassword(true)
      setFeedback({ type: 'success', message: data?.message ?? 'Senha de saque salva com sucesso.' })
    } catch {
      setFeedback({ type: 'error', message: 'Erro de conexão ao salvar senha.' })
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="tasks-page withdraw-password-page">
      <AppSidebar />

      <header className="tasks-header">
        <div>
          <p className="tasks-kicker">Segurança</p>
          <h1>Senha de Saque</h1>
          <span className="tasks-subtitle">Defina a senha usada para confirmar saques</span>
        </div>
        <div className="tasks-header-actions">
          <button className="btn ghost" type="button" onClick={() => navigate('/profile')}>
            Voltar
          </button>
        </div>
      </header>

      <section className="withdraw-password-card">
        <h2>Definir Senha do Fundo</h2>
        <p className="withdraw-password-subtitle">
          Essa senha será solicitada para autorizar saques da sua conta.
        </p>

        <div className={`withdraw-password-status ${hasWithdrawPassword ? 'ok' : 'warn'}`}>
          {statusLoading
            ? 'Verificando status da senha de saque...'
            : hasWithdrawPassword
              ? 'Senha de saque já cadastrada.'
              : 'Senha de saque ainda não cadastrada.'}
        </div>

        <div className="withdraw-password-form">
          <label>
            Nova senha de saque
            <input
              type="password"
              value={password}
              placeholder="Digite sua nova senha"
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>

          <label>
            Confirmar senha de saque
            <input
              type="password"
              value={confirmPassword}
              placeholder="Confirme sua senha"
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
          </label>

          <button type="button" className="withdraw-password-btn" onClick={saveWithdrawPassword} disabled={loading}>
            {loading ? 'Salvando...' : 'Salvar senha de saque'}
          </button>

          {feedback ? (
            <div className={`withdraw-password-feedback ${feedback.type}`}>
              {feedback.message}
            </div>
          ) : null}
        </div>

        <p className="withdraw-password-note">
          A senha de saque é usada para confirmar e proteger retiradas de saldo da sua conta.
        </p>
      </section>
    </main>
  )
}
