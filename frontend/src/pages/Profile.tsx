import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import AppSidebar from '../components/AppSidebar'
import './Profile.css'
import './Tasks.css'

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
    vipPrice?: number
    expiresAt?: string | null
  } | null
  balance?: number
}

type SummaryResponse = {
  balance?: number
  totalDeposits?: number
}

type ProfileMetricsResponse = {
  ok?: boolean
  metrics?: {
    teamTotal?: number
    withdrawableBalance?: number
    hasActiveCyclePlan?: boolean
    activeCyclePlan?: {
      id?: number
      productName?: string
      amountPaid?: number
      expectedProfit?: number
      cycleDays?: number
      startedAt?: string | null
      endsAt?: string | null
    } | null
  }
}

type MiningTasksResponse = {
  ok?: boolean
  tasks?: Array<{
    earnedToday?: number
  }>
}

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3333'

const formatBRL = (value: number) =>
  Number(value ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

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

function ProfileCardIcon({
  name,
  className = 'profile-card-icon',
}: {
  name: 'user' | 'vip' | 'finance' | 'team' | 'withdraw' | 'cycle'
  className?: string
}) {
  switch (name) {
    case 'user':
      return (
        <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="8" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <path d="M5 20c.8-3 3.4-5 7-5s6.2 2 7 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      )
    case 'vip':
      return (
        <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 8.5l3.2 8h9.6l3.2-8-4.2 2.7L12 5.5l-3.8 5.7L4 8.5Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
          <path d="M7 18h10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      )
    case 'finance':
      return (
        <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3.5" y="6.5" width="17" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <path d="M15 10h5v4h-5a2 2 0 0 1 0-4z" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <circle cx="16.8" cy="12" r="0.8" fill="currentColor" />
        </svg>
      )
    case 'team':
      return (
        <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="8" cy="9" r="2.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <circle cx="16" cy="9" r="2.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
          <path d="M3.8 19c.5-2.5 2.5-4 4.2-4s3.7 1.5 4.2 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          <path d="M11.8 19c.5-2.5 2.5-4 4.2-4s3.7 1.5 4.2 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      )
    case 'withdraw':
      return (
        <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 4v12M7.5 11.5L12 16l4.5-4.5" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
          <rect x="4.5" y="18" width="15" height="2.5" rx="1" fill="currentColor" />
        </svg>
      )
    case 'cycle':
      return (
        <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 4v3m0 10v3M4 12h3m10 0h3M6.3 6.3l2.1 2.1m7.2 7.2 2.1 2.1m0-11.4-2.1 2.1m-7.2 7.2-2.1 2.1" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
        </svg>
      )
    default:
      return null
  }
}

export default function Profile() {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(true)
  const [balance, setBalance] = useState(0)
  const [totalDeposits, setTotalDeposits] = useState(0)
  const [vipName, setVipName] = useState('Sem VIP')
  const [vipExpiresAt, setVipExpiresAt] = useState<string | null>(null)
  const [teamTotal, setTeamTotal] = useState(0)
  const [withdrawableBalance, setWithdrawableBalance] = useState(0)
  const [todayIncome, setTodayIncome] = useState(0)
  const [hasActiveCyclePlan, setHasActiveCyclePlan] = useState(false)
  const [activeCyclePlanName, setActiveCyclePlanName] = useState('Nenhum')
  const [copyFeedback, setCopyFeedback] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [giftCodeInput, setGiftCodeInput] = useState('')
  const [redeemLoading, setRedeemLoading] = useState(false)
  const [redeemFeedback, setRedeemFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const [showRedeemSuccessModal, setShowRedeemSuccessModal] = useState(false)
  const [redeemSuccessData, setRedeemSuccessData] = useState<{ message: string; rewardValue: number; code: string } | null>(null)

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
    if (!user?.id) {
      navigate('/')
      return
    }

    const loadProfile = async () => {
      setLoading(true)
      try {
        const [summaryRes, vipRes, metricsRes, miningRes] = await Promise.all([
          fetch(`${API_URL}/api/user/summary/${user.id}`),
          fetch(`${API_URL}/api/vip/user/${user.id}`),
          fetch(`${API_URL}/api/profile/metrics/${user.id}`),
          fetch(`${API_URL}/api/mining/tasks/${user.id}`),
        ])

        if (summaryRes.ok) {
          const summaryData = (await summaryRes.json()) as SummaryResponse
          setBalance(Number(summaryData.balance ?? 0))
          setTotalDeposits(Number(summaryData.totalDeposits ?? 0))
        }

        if (vipRes.ok) {
          const vipData = (await vipRes.json()) as VipResponse
          if (vipData?.ok && vipData?.hasVip && vipData.vip) {
            setVipName(vipData.vip.levelName || 'VIP Ativo')
            setVipExpiresAt(vipData.vip.expiresAt ?? null)
            if (typeof vipData.balance === 'number') {
              setBalance(Number(vipData.balance))
            }
          } else {
            setVipName('Sem VIP')
            setVipExpiresAt(null)
          }
        }

        if (metricsRes.ok) {
          const metricsData = (await metricsRes.json()) as ProfileMetricsResponse
          const metrics = metricsData?.metrics
          if (metrics) {
            setTeamTotal(Number(metrics.teamTotal ?? 0))
            setWithdrawableBalance(Number(metrics.withdrawableBalance ?? 0))
            setHasActiveCyclePlan(Boolean(metrics.hasActiveCyclePlan))
            setActiveCyclePlanName(
              metrics.hasActiveCyclePlan
                ? String(metrics.activeCyclePlan?.productName ?? 'Plano ativo')
                : 'Nenhum'
            )
          }
        }

        if (miningRes.ok) {
          const miningData = (await miningRes.json()) as MiningTasksResponse
          if (miningData?.ok && Array.isArray(miningData.tasks)) {
            const earnedToday = miningData.tasks.reduce((sum, task) => sum + Number(task?.earnedToday ?? 0), 0)
            setTodayIncome(Number(earnedToday.toFixed(2)))
          } else {
            setTodayIncome(0)
          }
        } else {
          setTodayIncome(0)
        }

        const referralRes = await fetch(`${API_URL}/api/referral/${user.id}`)
        const referralData = await referralRes.json()
        if (referralRes.ok && referralData?.ok) {
          setInviteCode(String(referralData.referralCode ?? ''))
        } else {
          setInviteCode('')
        }
      } finally {
        setLoading(false)
      }
    }

    loadProfile()
  }, [navigate, user?.id])

  const copyInviteCode = async () => {
    try {
      if (!inviteCode) {
        setCopyFeedback('Sem código')
        setTimeout(() => setCopyFeedback(''), 1500)
        return
      }
      await navigator.clipboard.writeText(inviteCode)
      setCopyFeedback('Copiado!')
      setTimeout(() => setCopyFeedback(''), 1500)
    } catch {
      setCopyFeedback('Erro ao copiar')
      setTimeout(() => setCopyFeedback(''), 1500)
    }
  }

  const handleLogout = () => {
    localStorage.removeItem('token')
    localStorage.removeItem('user')
    sessionStorage.removeItem('token')
    sessionStorage.removeItem('user')
    navigate('/')
  }

  const redeemGiftCode = async () => {
    if (!user?.id) {
      setRedeemFeedback({ type: 'error', message: 'Usuário não autenticado.' })
      return
    }

    const code = giftCodeInput.trim().toUpperCase()
    if (!code) {
      setRedeemFeedback({ type: 'error', message: 'Informe um código válido.' })
      return
    }

    setRedeemLoading(true)
    setRedeemFeedback(null)

    try {
      const res = await fetch(`${API_URL}/api/gift-codes/redeem`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: user.id,
          code,
        }),
      })

      const data = await res.json() as {
        ok?: boolean
        error?: string
        message?: string
        balance?: number
        rewardValue?: number
      }

      if (!res.ok || !data?.ok) {
        setRedeemFeedback({
          type: 'error',
          message: data?.error || 'Não foi possível resgatar o código.',
        })
        setTimeout(() => setRedeemFeedback(null), 2500)
        return
      }

      if (typeof data.balance === 'number') {
        setBalance(Number(data.balance))
      }

      setGiftCodeInput('')
      const rewardValue = typeof data.rewardValue === 'number' ? Number(data.rewardValue) : 0
      const successMessage = data?.message || 'Código resgatado com sucesso!'
      setRedeemSuccessData({
        message: successMessage,
        rewardValue,
        code,
      })
      setShowRedeemSuccessModal(true)
    } catch {
      setRedeemFeedback({
        type: 'error',
        message: 'Erro de conexão ao resgatar código.',
      })
      setTimeout(() => setRedeemFeedback(null), 2500)
    } finally {
      setRedeemLoading(false)
    }
  }

  return (
    <main className="tasks-page profile-page">
      {redeemFeedback ? (
        <div className={`gift-toast ${redeemFeedback.type === 'success' ? 'success' : 'error'}`} role="status" aria-live="polite">
          {redeemFeedback.message}
        </div>
      ) : null}
      {showRedeemSuccessModal && redeemSuccessData ? (
        <div className="redeem-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="redeem-success-title">
          <div className="redeem-modal-confetti-layer" aria-hidden="true">
            {Array.from({ length: 28 }).map((_, i) => (
              <span key={i} className={`confetti confetti-${(i % 7) + 1}`} />
            ))}
          </div>

          <div className="redeem-modal-card">
            <div className="redeem-modal-badge">🎉 Sucesso</div>
            <h2 id="redeem-success-title">Código resgatado!</h2>
            <p className="redeem-modal-message">{redeemSuccessData.message}</p>
            <div className="redeem-modal-highlight">
              <span>Valor resgatado</span>
              <strong>{formatBRL(redeemSuccessData.rewardValue)}</strong>
            </div>
            <p className="redeem-modal-code">Código: <b>{redeemSuccessData.code}</b></p>
            <button
              type="button"
              className="redeem-modal-btn"
              onClick={() => setShowRedeemSuccessModal(false)}
            >
              Continuar
            </button>
          </div>
        </div>
      ) : null}
      <AppSidebar />
      <header className="tasks-header">
        <div>
          <p className="tasks-kicker">Conta</p>
          <h1>Perfil</h1>
          <span className="tasks-subtitle">Informações da sua conta e status VIP</span>
        </div>
        <div className="tasks-header-actions">
          <button className="btn ghost" onClick={() => navigate('/dashboard')}>
            Voltar
          </button>
        </div>
      </header>

      {loading ? (
        <div className="vip-inline-message">Carregando perfil...</div>
      ) : (
        <>
          <section className="profile-header-modern">
            <div className="profile-header-row">
              <button type="button" className="profile-avatar-btn" aria-label="Selecionar Avatar">
                <div className="profile-avatar-frame">
                  <img
                    alt="Avatar do usuário"
                    className="profile-avatar-img"
                    src="https://api.dicebear.com/7.x/personas/svg?seed=avatar-user"
                  />
                </div>
              </button>

              <div className="profile-header-info">
                <div className="profile-header-topline">
                  <h2 className="profile-header-name">{user?.phone ?? user?.name ?? 'Usuário'}</h2>
                  <button
                    type="button"
                    className="profile-vip-pill"
                    aria-label="View VIP benefits"
                  >
                    <span className="profile-vip-pill-text">Usuários regulares</span>
                    <svg viewBox="0 0 24 24" className="profile-vip-pill-icon" aria-hidden="true">
                      <path d="M9 6l6 6l-6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                </div>

                <div className="profile-invite-row">
                  <span>Código de Convite:</span>
                  <span className="profile-invite-code">{inviteCode}</span>
                  <button
                    type="button"
                    className="profile-copy-btn"
                    aria-label="Copiar código de convite"
                    onClick={copyInviteCode}
                  >
                    <svg viewBox="0 0 24 24" className="profile-copy-icon" aria-hidden="true">
                      <path d="M7 7m0 2.667a2.667 2.667 0 0 1 2.667 -2.667h8.666a2.667 2.667 0 0 1 2.667 2.667v8.666a2.667 2.667 0 0 1 -2.667 2.667h-8.666a2.667 2.667 0 0 1 -2.667 -2.667z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="M4.012 16.737a2.005 2.005 0 0 1 -1.012 -1.737v-10c0 -1.1 .9 -2 2 -2h10c.75 0 1.158 .385 1.5 1" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                  {copyFeedback ? <span className="profile-copy-feedback">{copyFeedback}</span> : null}
                </div>
              </div>
            </div>
          </section>

          <section className="profile-summary-top">
            <div className="profile-summary-grid">
              <div className="profile-summary-item" role="presentation">
                <div className="profile-summary-value">
                  {formatBRL(balance)}
                </div>
                <div className="profile-summary-label">Saldo Total</div>
              </div>
              <div className="profile-summary-item profile-summary-item-border">
                <div className="profile-summary-value">
                  {formatBRL(totalDeposits)}
                </div>
                <div className="profile-summary-label">Receita Total</div>
              </div>
            </div>
          </section>

          <section className="home-shortcuts-sky-bg">
            <div className="home-shortcuts-grid">
              <div className="shortcut-cell">
                <div className="shortcut-value">{formatBRL(totalDeposits)}</div>
                <div className="shortcut-label">Conta de Recarga</div>
              </div>
              <div className="shortcut-cell shortcut-cell-left-border">
                <div className="shortcut-value">{formatBRL(withdrawableBalance)}</div>
                <div className="shortcut-label">Conta de Recompensas</div>
              </div>
              <div className="shortcut-cell shortcut-cell-top-border">
                <div className="shortcut-value">{formatBRL(0)}</div>
                <div className="shortcut-label">Total Sacado</div>
              </div>
              <div className="shortcut-cell shortcut-cell-left-border shortcut-cell-top-border">
                <div className="shortcut-value">{formatBRL(todayIncome)}</div>
                <div className="shortcut-label">Receita de Hoje</div>
              </div>
            </div>
          </section>

          <section className="gift-redeem-card">
            <div className="gift-redeem-head">
              <div className="gift-redeem-icon-wrap">
                <svg viewBox="0 0 24 24" className="gift-redeem-icon" aria-hidden="true">
                  <path d="M3 9a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M12 8v13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  <path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  <path d="M7.5 8a2.5 2.5 0 0 1 0-5A4.8 8 0 0 1 12 8a4.8 8 0 0 1 4.5-5a2.5 2.5 0 0 1 0 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              </div>
              <div className="gift-redeem-copy">
                <h3>Resgatar Código de Presente</h3>
                <p>Informe o código para reivindicar recompensas</p>
              </div>
              <svg viewBox="0 0 24 24" className="gift-redeem-spark" aria-hidden="true">
                <path d="M16 18a2 2 0 0 1 2 2a2 2 0 0 1 2-2a2 2 0 0 1-2-2a2 2 0 0 1-2 2zm0-12a2 2 0 0 1 2 2a2 2 0 0 1 2-2a2 2 0 0 1-2-2a2 2 0 0 1-2 2zm-7 12a6 6 0 0 1 6-6a6 6 0 0 1-6-6a6 6 0 0 1-6 6a6 6 0 0 1 6 6z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>

            <div className="gift-redeem-actions">
              <div className="gift-redeem-input-wrap">
                <input
                  placeholder="Informe o código do presente"
                  className="gift-redeem-input"
                  maxLength={20}
                  type="text"
                  value={giftCodeInput}
                  onChange={(e) => setGiftCodeInput(e.target.value.toUpperCase())}
                />
              </div>
              <button
                type="button"
                disabled={redeemLoading || !giftCodeInput.trim()}
                className="gift-redeem-btn"
                onClick={redeemGiftCode}
              >
                {redeemLoading ? 'Resgatando...' : 'Reivindicar'}
              </button>
            </div>
          </section>

          <section className="profile-shortcuts-grid">
            <button type="button" className="profile-shortcut-btn" onClick={() => navigate('/investment-orders')}>
              <svg className="profile-shortcut-icon" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M14 3v4a1 1 0 0 0 1 1h4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                <path d="M17 21h-10a2 2 0 0 1-2-2v-14a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                <path d="M9 13h6M9 17h6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              <span className="profile-shortcut-label">Pedidos de Investimento</span>
            </button>
            <button type="button" className="profile-shortcut-btn" onClick={() => navigate('/earnings')}>
              <svg className="profile-shortcut-icon" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M3 20h18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                <rect x="4" y="12" width="4" height="7" rx="1" fill="none" stroke="currentColor" strokeWidth="2" />
                <rect x="10" y="5" width="4" height="14" rx="1" fill="none" stroke="currentColor" strokeWidth="2" />
                <rect x="16" y="9" width="4" height="10" rx="1" fill="none" stroke="currentColor" strokeWidth="2" />
              </svg>
              <span className="profile-shortcut-label">Ganhos</span>
            </button>
            <button type="button" className="profile-shortcut-btn" onClick={() => navigate('/bank-cards')}>
              <svg className="profile-shortcut-icon" viewBox="0 0 24 24" aria-hidden="true">
                <rect x="3" y="5" width="18" height="14" rx="3" fill="none" stroke="currentColor" strokeWidth="2" />
                <path d="M3 10h18" fill="none" stroke="currentColor" strokeWidth="2" />
                <path d="M7 15h.01M11 15h2" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              <span className="profile-shortcut-label">Cartões Bancários</span>
            </button>
            <button type="button" className="profile-shortcut-btn" onClick={() => navigate('/team-report')}>
              <svg className="profile-shortcut-icon" viewBox="0 0 24 24" aria-hidden="true">
                <rect x="5" y="4" width="14" height="17" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
                <path d="M9 8h6M9 12h6M9 16h4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              <span className="profile-shortcut-label">Relatório da Equipe</span>
            </button>
            <button type="button" className="profile-shortcut-btn" onClick={() => navigate('/invite')}>
              <svg className="profile-shortcut-icon" viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="9" cy="8" r="3" fill="none" stroke="currentColor" strokeWidth="2" />
                <circle cx="16.5" cy="9" r="2.5" fill="none" stroke="currentColor" strokeWidth="2" />
                <path d="M4 19a5 5 0 0 1 10 0M14 19a4.5 4.5 0 0 1 6 0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              <span className="profile-shortcut-label">Convidar</span>
            </button>
            <button type="button" className="profile-shortcut-btn" onClick={() => navigate('/community')}>
              <svg className="profile-shortcut-icon" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M21 12a8.5 8.5 0 0 1-8.5 8.5A8.6 8.6 0 0 1 8 19l-5 1.5L4.5 16A8.5 8.5 0 1 1 21 12z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
              </svg>
              <span className="profile-shortcut-label">Comunidade</span>
            </button>
            <button type="button" className="profile-shortcut-btn" onClick={() => navigate('/checkin')}>
              <svg className="profile-shortcut-icon" viewBox="0 0 24 24" aria-hidden="true">
                <rect x="3" y="8" width="18" height="4" rx="1" fill="none" stroke="currentColor" strokeWidth="2" />
                <path d="M12 8v13M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" fill="none" stroke="currentColor" strokeWidth="2" />
                <path d="M7.5 8a2.5 2.5 0 0 1 0-5A5 5 0 0 1 12 8a5 5 0 0 1 4.5-5a2.5 2.5 0 0 1 0 5" fill="none" stroke="currentColor" strokeWidth="2" />
              </svg>
              <span className="profile-shortcut-label">Check-in</span>
            </button>
            <button type="button" className="profile-shortcut-btn" onClick={() => navigate('/withdraw-password')}>
              <svg className="profile-shortcut-icon" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 3a11 11 0 0 0 8 3.5c0 6-2.8 11.2-8 14.5c-5.2-3.3-8-8.5-8-14.5A11 11 0 0 0 12 3z" fill="none" stroke="currentColor" strokeWidth="2" />
              </svg>
              <span className="profile-shortcut-label">Senha do Fundo</span>
            </button>
            <button type="button" className="profile-shortcut-btn">
              <svg className="profile-shortcut-icon" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M18 10a6 6 0 1 0-12 0v4a3 3 0 0 1-2 2h16a3 3 0 0 1-2-2v-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                <path d="M9.5 19a2.5 2.5 0 0 0 5 0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              <span className="profile-shortcut-label">Notificações</span>
            </button>
            <button type="button" className="profile-shortcut-btn" onClick={() => navigate('/tax-declaration')}>
              <svg className="profile-shortcut-icon" viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth="2" />
                <circle cx="12" cy="12" r="4.5" fill="none" stroke="currentColor" strokeWidth="2" />
                <circle cx="12" cy="12" r="1.5" fill="currentColor" />
              </svg>
              <span className="profile-shortcut-label">Imposto de Renda</span>
            </button>
            <button type="button" className="profile-shortcut-btn">
              <svg className="profile-shortcut-icon" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 4v12M7 11l5 5l5-5M4 20h16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="profile-shortcut-label">Baixar APP</span>
            </button>
            <button type="button" className="profile-shortcut-btn">
              <svg className="profile-shortcut-icon" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 20h4l10-10a2.1 2.1 0 1 0-3-3L5 17v3z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
                <path d="M13.5 6.5l3 3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
              <span className="profile-shortcut-label">Alterar Senha</span>
            </button>
            <button type="button" className="profile-shortcut-btn logout" onClick={handleLogout}>
              <svg className="profile-shortcut-icon" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M14 4h-7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                <path d="M10 12h10M17 8l4 4l-4 4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="profile-shortcut-label">Sair</span>
            </button>
          </section>
        </>
      )}

    </main>
  )
}
