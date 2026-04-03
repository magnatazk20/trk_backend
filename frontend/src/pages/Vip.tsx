import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import './Vip.css'

type VipLevel = {
  id: number
  name: string
  price: number
  dailyTaskLimit: number
  taskRewardMultiplier: number
  benefits: string
}

type StoredUser = {
  id: number
  name: string
  phone: string
}

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3333'

const formatBRL = (value: number) =>
  value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

export default function Vip() {
  const [levels, setLevels] = useState<VipLevel[]>([])
  const [loading, setLoading] = useState(true)
  const [submittingId, setSubmittingId] = useState<number | null>(null)
  const [message, setMessage] = useState<string>('')
  const [currentVipLevelId, setCurrentVipLevelId] = useState<number | null>(null)

  const user = useMemo(() => {
    const raw = localStorage.getItem('user') ?? sessionStorage.getItem('user')
    if (!raw) return null
    try {
      return JSON.parse(raw) as StoredUser
    } catch {
      return null
    }
  }, [])

  const loadVipData = async () => {
    if (!user?.id) {
      setLoading(false)
      return
    }

    setLoading(true)
    try {
      const [levelsRes, userVipRes] = await Promise.all([
        fetch(`${API_URL}/api/vip/levels`),
        fetch(`${API_URL}/api/vip/user/${user.id}`),
      ])

      const levelsJson = await levelsRes.json()
      const userVipJson = await userVipRes.json()

      if (levelsRes.ok && levelsJson?.ok) {
        setLevels(Array.isArray(levelsJson.levels) ? levelsJson.levels : [])
      }

      if (userVipRes.ok && userVipJson?.ok && userVipJson?.hasVip && userVipJson?.vip) {
        setCurrentVipLevelId(Number(userVipJson.vip.vipLevelId))
      } else {
        setCurrentVipLevelId(null)
      }
    } catch {
      setMessage('Não foi possível carregar os planos VIP agora.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadVipData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleActivate = async (vipLevelId: number) => {
    if (!user?.id) {
      setMessage('Faça login para ativar um VIP.')
      return
    }

    setMessage('')
    setSubmittingId(vipLevelId)

    try {
      const response = await fetch(`${API_URL}/api/vip/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id, vipLevelId }),
      })

      const data = await response.json()

      if (!response.ok || !data?.ok) {
        setMessage(data?.error ?? 'Falha ao ativar VIP.')
        return
      }

      setMessage(data?.message ?? 'VIP ativado com sucesso.')
      setCurrentVipLevelId(vipLevelId)
    } catch {
      setMessage('Erro de conexão ao ativar VIP.')
    } finally {
      setSubmittingId(null)
    }
  }

  return (
    <main className="vip-page">
      <div className="vip-shell">
        <header className="vip-header">
          <div>
            <p className="vip-kicker">Planos Premium</p>
            <h1>Escolha seu VIP</h1>
            <p className="vip-subtitle">
              Para executar tarefas e aumentar ganhos, ative um dos 5 níveis VIP.
            </p>
          </div>
          <Link to="/dashboard" className="vip-back">
            Voltar
          </Link>
        </header>

        {message ? <div className="vip-message">{message}</div> : null}

        {loading ? (
          <div className="vip-loading">Carregando planos...</div>
        ) : (
          <section className="vip-grid">
            {levels.map((level) => {
              const active = currentVipLevelId === level.id
              return (
                <article key={level.id} className={`vip-card ${active ? 'active' : ''}`}>
                  <div className="vip-card-top">
                    <span className="vip-tag">{level.name}</span>
                    <strong>{formatBRL(level.price)}</strong>
                  </div>

                  <ul className="vip-features">
                    <li>Total: {level.dailyTaskLimit} tarefas</li>
                    <li>Multiplicador: x{Number(level.taskRewardMultiplier).toFixed(2)}</li>
                    <li>{level.benefits || 'Benefícios exclusivos VIP'}</li>
                  </ul>

                  <button
                    className="vip-btn"
                    onClick={() => handleActivate(level.id)}
                    disabled={active || submittingId === level.id}
                  >
                    {active ? 'VIP ativo' : submittingId === level.id ? 'Ativando...' : 'Ativar plano'}
                  </button>
                </article>
              )
            })}
          </section>
        )}
      </div>
    </main>
  )
}
