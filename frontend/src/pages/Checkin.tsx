import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import './Checkin.css'

type StoredUser = {
  id: number
  name: string
  phone: string
}

type CheckinStatusResponse = {
  ok?: boolean
  canClaim?: boolean
  currentDay?: number
  claimedToday?: boolean
  rewards?: number[]
  history?: Array<{
    day?: number
    rewardAmount?: number
    checkinDate?: string
  }>
  error?: string
}

type CheckinClaimResponse = {
  ok?: boolean
  message?: string
  claim?: {
    day?: number
    rewardAmount?: number
    checkinDate?: string
  }
  balance?: number
  error?: string
}

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3333'

const formatBRL = (value: number) =>
  Number(value ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

export default function Checkin() {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(true)
  const [claiming, setClaiming] = useState(false)
  const [canClaim, setCanClaim] = useState(false)
  const [currentDay, setCurrentDay] = useState(1)
  const [rewards, setRewards] = useState<number[]>([2, 2, 3, 3, 4, 4, 5, 5, 6, 10])
  const [historyDays, setHistoryDays] = useState<number[]>([])
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

  const loadStatus = async () => {
    if (!user?.id) return

    try {
      const res = await fetch(`${API_URL}/api/checkin/status/${user.id}`)
      const data = (await res.json()) as CheckinStatusResponse

      if (!res.ok || !data?.ok) {
        setFeedback({ type: 'error', message: data?.error ?? 'Erro ao carregar check-in.' })
        return
      }

      setCanClaim(Boolean(data.canClaim))
      setCurrentDay(Math.min(Math.max(Number(data.currentDay ?? 1), 1), 10))
      if (Array.isArray(data.rewards) && data.rewards.length === 10) {
        setRewards(data.rewards.map((v) => Number(v ?? 0)))
      }

      const days = Array.isArray(data.history)
        ? data.history.map((item) => Number(item.day ?? 0)).filter((d) => d >= 1 && d <= 10)
        : []
      setHistoryDays(days)
    } catch {
      setFeedback({ type: 'error', message: 'Falha de conexão ao carregar check-in.' })
    }
  }

  useEffect(() => {
    if (!user?.id) {
      navigate('/')
      return
    }

    const run = async () => {
      setLoading(true)
      await loadStatus()
      setLoading(false)
    }

    run()
  }, [navigate, user?.id])

  const handleClaim = async () => {
    if (!user?.id || claiming || !canClaim) return
    setClaiming(true)
    setFeedback(null)

    try {
      const res = await fetch(`${API_URL}/api/checkin/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id }),
      })

      const data = (await res.json()) as CheckinClaimResponse

      if (!res.ok || !data?.ok) {
        setFeedback({ type: 'error', message: data?.error ?? 'Não foi possível resgatar.' })
        setClaiming(false)
        return
      }

      const rewardAmount = Number(data.claim?.rewardAmount ?? 0)
      setFeedback({
        type: 'success',
        message: `${data.message ?? 'Check-in realizado!'} (+${formatBRL(rewardAmount)})`,
      })

      await loadStatus()
    } catch {
      setFeedback({ type: 'error', message: 'Falha de conexão ao resgatar check-in.' })
    } finally {
      setClaiming(false)
    }
  }

  return (
    <main className="checkin-page">
      <header className="checkin-topbar">
        <button type="button" className="checkin-back" onClick={() => navigate('/profile')}>
          ←
        </button>
        <h1>Check-in Diário</h1>
        <div className="checkin-back-spacer" />
      </header>

      <section className="checkin-card">
        <div className="checkin-hero">
          <div className="checkin-calendar-icon-wrap" aria-hidden="true">
            <svg viewBox="0 0 24 24" className="checkin-calendar-icon">
              <rect x="3.5" y="5.5" width="17" height="15" rx="3" fill="none" stroke="currentColor" strokeWidth="1.9" />
              <path d="M7.5 3.5v4M16.5 3.5v4M3.5 9.5h17" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
              <circle cx="8" cy="13" r="1" fill="currentColor" />
              <circle cx="12" cy="13" r="1" fill="currentColor" />
              <circle cx="16" cy="13" r="1" fill="currentColor" />
            </svg>
          </div>

          <div>
            <h2>Ciclo de 10 dias</h2>
            <p>Faça check-in uma vez por dia para desbloquear recompensas progressivas.</p>
          </div>
        </div>

        <div className="checkin-meta">
          <span className="checkin-meta-pill">Dia atual: <strong>{currentDay}</strong>/10</span>
          <span className={`checkin-meta-pill ${canClaim ? 'ok' : 'blocked'}`}>
            {canClaim ? 'Disponível para resgatar' : 'Resgate de hoje concluído'}
          </span>
        </div>

        {feedback ? (
          <div className={`checkin-feedback ${feedback.type}`}>{feedback.message}</div>
        ) : null}

        {loading ? (
          <div className="checkin-loading">Carregando seu progresso...</div>
        ) : (
          <>
            <div className="checkin-grid">
              {Array.from({ length: 10 }).map((_, index) => {
                const day = index + 1
                const isDone = historyDays.includes(day)
                const isCurrent = currentDay === day
                return (
                  <article
                    key={day}
                    className={`checkin-day ${isDone ? 'done' : ''} ${isCurrent ? 'current' : ''}`}
                  >
                    <div className="checkin-day-head">
                      <span className="checkin-day-badge">Dia {day}</span>
                      {isDone ? <span className="checkin-status done">✓</span> : isCurrent ? <span className="checkin-status current">Hoje</span> : null}
                    </div>
                    <strong>{formatBRL(Number(rewards[index] ?? 0))}</strong>
                    <small>{isDone ? 'Resgatado' : isCurrent ? 'Disponível hoje' : 'Aguardando dia'}</small>
                  </article>
                )
              })}
            </div>

            <button
              type="button"
              className="checkin-claim-btn"
              onClick={handleClaim}
              disabled={!canClaim || claiming}
            >
              {claiming ? 'Resgatando recompensa...' : canClaim ? `Resgatar recompensa do Dia ${currentDay}` : 'Você já resgatou hoje'}
            </button>
          </>
        )}
      </section>
    </main>
  )
}
