import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import AppSidebar from '../components/AppSidebar'
import './Tasks.css'
import './Invite.css'

type StoredUser = {
  id: number
  name: string
  phone: string
}

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3333'

export default function Invite() {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refCode, setRefCode] = useState('')
  const [copied, setCopied] = useState(false)

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
    const loadReferral = async () => {
      if (!user?.id) {
        setError('Usuário não autenticado.')
        setLoading(false)
        return
      }

      try {
        const response = await fetch(`${API_URL}/api/referral/${user.id}`)
        const data = await response.json()

        if (!response.ok || !data?.ok) {
          setError(data?.error ?? 'Não foi possível carregar seu link de convite.')
          setLoading(false)
          return
        }

        setRefCode(String(data.referralCode ?? ''))
      } catch {
        setError('Erro de conexão ao carregar convite.')
      } finally {
        setLoading(false)
      }
    }

    loadReferral()
  }, [user?.id])

  const referralLink = useMemo(() => {
    const origin = window.location.origin
    if (!refCode) return ''
    return `${origin}/cadastro?ref=${encodeURIComponent(refCode)}`
  }, [refCode])

  const inviteMessage = useMemo(() => {
    if (!referralLink) return ''
    return `🚀 Cadastre-se com meu link exclusivo e entre agora:\n${referralLink}`
  }, [referralLink])

  const whatsappLink = useMemo(() => {
    if (!inviteMessage) return ''
    return `https://wa.me/?text=${encodeURIComponent(inviteMessage)}`
  }, [inviteMessage])

  const copyLink = async () => {
    if (!referralLink) return
    try {
      await navigator.clipboard.writeText(referralLink)
      setCopied(true)
      setTimeout(() => setCopied(false), 2200)
    } catch {
      setError('Não foi possível copiar o link.')
    }
  }

  return (
    <main className="tasks-page invite-page">
      <AppSidebar />
      <header className="tasks-header">
        <div>
          <p className="tasks-kicker">Convidar</p>
          <h1>Central de Convites</h1>
          <span className="tasks-subtitle">Compartilhe seu link exclusivo e acompanhe seu código de indicação</span>
        </div>
        <div className="tasks-header-actions">
          <button className="btn ghost" onClick={() => navigate('/dashboard')}>
            Voltar
          </button>
        </div>
      </header>

      <section className="progress-card">
        <div className="progress-top">
          <span>Como funciona</span>
          <strong>3 passos simples</strong>
        </div>
        <ul className="invite-list">
          <li>Copie seu link exclusivo.</li>
          <li>Envie para amigos pelo WhatsApp, Telegram ou redes sociais.</li>
          <li>Quando a pessoa se cadastrar com seu link, ela entra como sua indicação.</li>
        </ul>
      </section>

      <section className="progress-card">
        {loading ? <p>Carregando link...</p> : null}
        {!loading && error ? <p className="feedback error">{error}</p> : null}

        {!loading && !error ? (
          <>
            <div className="progress-top">
              <span>Código de convite</span>
              <strong>{refCode || '-'}</strong>
            </div>

            <div style={{ marginTop: 12 }}>
              <label htmlFor="invite-link" className="invite-input-label">
                Link de cadastro
              </label>
              <input
                id="invite-link"
                type="text"
                value={referralLink}
                readOnly
                className="invite-input"
              />
            </div>

            <div className="task-footer" style={{ marginTop: 12, gap: 8, display: 'flex', flexWrap: 'wrap' }}>
              <button onClick={copyLink} disabled={!referralLink}>
                {copied ? 'Copiado!' : 'Copiar link'}
              </button>

              <a
                href={whatsappLink}
                target="_blank"
                rel="noreferrer"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  textDecoration: 'none',
                  padding: '10px 14px',
                  borderRadius: 10,
                  border: '1px solid #16a34a',
                  color: '#166534',
                  background: '#f0fdf4',
                  fontWeight: 600,
                }}
              >
                Enviar no WhatsApp
              </a>
            </div>

            {copied ? <p className="feedback ok">Link copiado com sucesso. Agora é só compartilhar.</p> : null}
          </>
        ) : null}
      </section>

      <section className="progress-card">
        <div className="progress-top">
          <span>Comissões por nível</span>
          <strong>Ganhos do convite</strong>
        </div>
        <div
          style={{
            marginTop: 10,
            border: '1px solid #e5e7eb',
            borderRadius: 12,
            overflow: 'hidden',
            background: '#fff',
          }}
        >
          <div className="invite-level-row" style={{ background: '#f9fafb' }}>
            <span className="invite-level-label">NÍVEL 1</span>
            <strong style={{ color: '#16a34a' }}>15%</strong>
          </div>
          <div className="invite-level-row">
            <span className="invite-level-label">NÍVEL 2</span>
            <strong style={{ color: '#2563eb' }}>5%</strong>
          </div>
          <div className="invite-level-row">
            <span className="invite-level-label">NÍVEL 3</span>
            <strong style={{ color: '#7c3aed' }}>3%</strong>
          </div>
        </div>
      </section>

      <section className="progress-card">
        <div className="progress-top">
          <span>Informações importantes</span>
          <strong>Leia antes de compartilhar</strong>
        </div>
        <ul className="invite-list">
          <li>Seu link já inclui seu código automaticamente (`?ref=`).</li>
          <li>Não altere o link para não perder o rastreamento da indicação.</li>
          <li>Se a página mostrar erro, verifique se você está logado e tente novamente.</li>
          <li>Seu código fica salvo no banco na tabela <strong>users.referral_code</strong>.</li>
        </ul>
      </section>
    </main>
  )
}
