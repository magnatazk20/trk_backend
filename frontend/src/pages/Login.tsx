import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import heroImage from '../assets/hero.png'

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3333'

interface AuthResponse {
  message?: string
  error?: string
  token?: string
  user?: { id: number; name: string; phone: string; is_admin?: number; isAdmin?: number | boolean }
}

export default function Login() {
  const navigate = useNavigate()
  const [phone, setPhone] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setLoading(true)
    setMessage('')
    setError('')

    try {
      const response = await fetch(`${API_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, password, remember }),
      })

      const data = (await response.json()) as AuthResponse

      if (!response.ok) {
        setError(data.error ?? 'Falha ao fazer login.')
        return
      }

      // Salvar token e dados do usuário
      const storage = remember ? localStorage : sessionStorage
      storage.setItem('token', data.token ?? '')
      storage.setItem('user', JSON.stringify(data.user ?? {}))

      setMessage(data.message ?? 'Login realizado com sucesso.')

      // Redirecionar para o dashboard após 800ms
      setTimeout(() => navigate('/dashboard'), 800)
    } catch {
      setError('Não foi possível conectar ao servidor.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-shell">
        <aside className="hero-panel">
          <img src={heroImage} alt="Imagem decorativa" />
          <div className="hero-overlay">
            <h2>Bem-vindo de volta</h2>
            <p>“Entre para continuar sua jornada com segurança e estilo”</p>
          </div>
        </aside>

        <section className="form-panel" aria-labelledby="login-title">
          <h1 id="login-title">Login</h1>
          <p className="subtitle">Use sua conta para acessar o painel.</p>

          <form className="auth-form" onSubmit={onSubmit}>
            <label htmlFor="phone">Telefone</label>
            <input
              id="phone"
              type="tel"
              placeholder="(11) 99999-9999"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              autoComplete="tel"
              required
            />

            <label htmlFor="password">Senha</label>
            <input
              id="password"
              type="password"
              placeholder="Digite sua senha"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />

            <div className="row">
              <label className="remember-me" htmlFor="remember">
                <input
                  id="remember"
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                />
                Lembrar-me
              </label>
              <a href="#" className="text-link">
                Esqueci minha senha
              </a>
            </div>

            <button type="submit" disabled={loading}>
              {loading ? 'Entrando...' : 'Entrar'}
            </button>
          </form>

          {message ? <p className="feedback success">{message}</p> : null}
          {error ? <p className="feedback error">{error}</p> : null}

          <p className="switch-page">
            Não tem conta?{' '}
            <Link to="/cadastro" className="text-link bold">
              Criar conta
            </Link>
          </p>
        </section>
      </section>
    </main>
  )
}
