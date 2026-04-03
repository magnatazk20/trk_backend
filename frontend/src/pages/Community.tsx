import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import AppSidebar from '../components/AppSidebar'
import './Community.css'
import './Tasks.css'

type CommunityLinksResponse = {
  ok?: boolean
  links?: {
    whatsappGroupUrl?: string
    managerContact?: string
  }
}

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3333'

export default function Community() {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(true)
  const [whatsappGroupUrl, setWhatsappGroupUrl] = useState('')
  const [managerContact, setManagerContact] = useState('')
  const [feedback, setFeedback] = useState('')

  useEffect(() => {
    const loadLinks = async () => {
      setLoading(true)
      try {
        const res = await fetch(`${API_URL}/api/community-links`)
        const data = (await res.json()) as CommunityLinksResponse

        if (res.ok && data?.ok) {
          setWhatsappGroupUrl(String(data.links?.whatsappGroupUrl ?? ''))
          setManagerContact(String(data.links?.managerContact ?? ''))
        }
      } catch {
        setFeedback('Erro ao carregar dados da comunidade.')
      } finally {
        setLoading(false)
      }
    }

    loadLinks()
  }, [])

  const normalizeManagerContactToLink = (value: string) => {
    const trimmed = value.trim()
    if (!trimmed) return ''

    if (/^https?:\/\//i.test(trimmed) || /^mailto:/i.test(trimmed) || /^tel:/i.test(trimmed)) {
      return trimmed
    }

    const onlyDigits = trimmed.replace(/\D/g, '')
    if (onlyDigits.length >= 10) {
      return `https://wa.me/${onlyDigits}`
    }

    return `mailto:${trimmed}`
  }

  const openExternal = (url: string, emptyMessage: string) => {
    if (!url) {
      setFeedback(emptyMessage)
      setTimeout(() => setFeedback(''), 1800)
      return
    }
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  return (
    <main className="tasks-page community-page">
      <AppSidebar />

      <header className="tasks-header">
        <div>
          <p className="tasks-kicker">Perfil</p>
          <h1>Comunidade</h1>
          <span className="tasks-subtitle">Acesse o grupo oficial e fale com o gerente</span>
        </div>
        <div className="tasks-header-actions">
          <button className="btn ghost" onClick={() => navigate('/profile')}>
            Voltar
          </button>
        </div>
      </header>

      <section className="community-card">
        {loading ? (
          <div className="community-inline-message">Carregando links...</div>
        ) : (
          <>
            <p className="community-description">
              Entre na comunidade para receber novidades e suporte rápido.
            </p>

            <div className="community-actions">
              <button
                type="button"
                className="community-btn whatsapp"
                onClick={() => openExternal(whatsappGroupUrl, 'Link do grupo ainda não configurado.')}
              >
                Grupo do WhatsApp
              </button>

              <button
                type="button"
                className="community-btn manager"
                onClick={() =>
                  openExternal(
                    normalizeManagerContactToLink(managerContact),
                    'Contato do gerente ainda não configurado.'
                  )
                }
              >
                Contato do gerente
              </button>
            </div>

            {feedback ? <div className="community-feedback">{feedback}</div> : null}
          </>
        )}
      </section>
    </main>
  )
}
