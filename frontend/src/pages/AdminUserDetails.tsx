import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import AdminSidebar from '../components/AdminSidebar'
import './Admin.css'
import './AdminUserDetails.css'

type UserLogItem = {
  id: number
  action: string
  old_balance: number | null
  new_balance: number | null
  amount: number | null
  metadata: string | null
  created_at: string | null
}

type PurchaseItem = {
  id: number
  planName: string
  amountPaid: number
  createdAt: string | null
}

type GiftCodeRedemptionItem = {
  id: number
  code: string
  rewardType: string
  rewardValue: number
  createdAt: string | null
}

type DailyCheckinRedemptionItem = {
  id: number
  checkinDay: number
  rewardAmount: number
  checkinDate: string | null
  createdAt: string | null
}

type ReferralItem = {
  id: number
  name: string
  phone: string
  createdAt: string | null
  hasDeposit: boolean
  totalDepositsPaid: number
}

type UserDetailsResponse = {
  ok?: boolean
  error?: string
  user?: {
    id: number
    name: string
    phone: string
    is_admin: number
    is_banned: number
    created_at?: string
    balance: number
    totalDepositsPaid: number
    totalWithdrawals: number
    totalCyclePlansBought: number
    totalVipPlansBought: number
    accountLogs?: UserLogItem[]
    vipPurchases?: PurchaseItem[]
    cyclePurchases?: PurchaseItem[]
    giftCodeRedemptions?: GiftCodeRedemptionItem[]
    dailyCheckinRedemptions?: DailyCheckinRedemptionItem[]
    referralsLevel1?: ReferralItem[]
    referralsLevel2?: ReferralItem[]
    referralsLevel3?: ReferralItem[]
  }
}

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3333'

const formatBRL = (value: number) =>
  Number(value ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

export default function AdminUserDetails() {
  const { id } = useParams()
  const navigate = useNavigate()

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [user, setUser] = useState<UserDetailsResponse['user'] | null>(null)

  const [adjustAmount, setAdjustAmount] = useState('')
  const [adjustOperation, setAdjustOperation] = useState<'add' | 'subtract'>('add')
  const [adjustReason, setAdjustReason] = useState('')
  const [adjustLoading, setAdjustLoading] = useState(false)
  const [adjustFeedback, setAdjustFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null)

  const [showAllLevel1, setShowAllLevel1] = useState(false)
  const [showAllLevel2, setShowAllLevel2] = useState(false)
  const [showAllLevel3, setShowAllLevel3] = useState(false)

  const token = useMemo(
    () => localStorage.getItem('token') ?? sessionStorage.getItem('token') ?? '',
    []
  )

  const loadUserDetails = async () => {
    if (!id) {
      setError('ID de usuário inválido.')
      return
    }

    setLoading(true)
    setError('')
    try {
      const res = await fetch(`${API_URL}/api/admin/users/${id}/details`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })

      const data = (await res.json()) as UserDetailsResponse
      if (!res.ok || !data?.ok || !data.user) {
        setError(data?.error ?? 'Falha ao carregar detalhes do usuário.')
        setUser(null)
        return
      }

      setUser(data.user)
    } catch {
      setError('Erro de conexão ao carregar detalhes do usuário.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadUserDetails()
  }, [id])

  const handleBalanceAdjust = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!id) return

    const parsedAmount = Number(String(adjustAmount).replace(',', '.'))
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      setAdjustFeedback({ type: 'error', message: 'Informe um valor válido maior que zero.' })
      return
    }

    setAdjustLoading(true)
    setAdjustFeedback(null)

    try {
      const res = await fetch(`${API_URL}/api/admin/users/${id}/balance`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          amount: parsedAmount,
          operation: adjustOperation,
          reason: adjustReason.trim() || undefined,
        }),
      })

      const data = (await res.json()) as { ok?: boolean; error?: string; message?: string }
      if (!res.ok || !data?.ok) {
        setAdjustFeedback({ type: 'error', message: data?.error ?? 'Falha ao ajustar saldo.' })
        return
      }

      setAdjustFeedback({ type: 'success', message: data?.message ?? 'Saldo ajustado com sucesso.' })
      setAdjustAmount('')
      setAdjustReason('')
      await loadUserDetails()
    } catch {
      setAdjustFeedback({ type: 'error', message: 'Erro de conexão ao ajustar saldo.' })
    } finally {
      setAdjustLoading(false)
    }
  }

  const renderReferralLevel = (
    title: string,
    items: ReferralItem[] | undefined,
    showAll: boolean,
    onToggle: () => void
  ) => {
    const safeItems = items ?? []
    const visibleItems = showAll ? safeItems : safeItems.slice(0, 5)

    return (
      <section className="admin-panel admin-user-list-panel">
        <div className="admin-log-header">
          <h3>{title}</h3>
        </div>

        {safeItems.length > 0 ? (
          <>
            <div className="admin-user-list">
              {visibleItems.map((member) => (
                <article key={member.id} className="admin-user-list-item">
                  <div>
                    <strong>{member.name}</strong>
                    <p>#{member.id} · {member.phone}</p>
                    <p>Cadastro: {member.createdAt ? new Date(member.createdAt).toLocaleString('pt-BR') : '-'}</p>
                  </div>
                  <div>
                    <p><strong>Status depósito:</strong> {member.hasDeposit ? 'Depositou' : 'Não depositou'}</p>
                    <p><strong>Total depositado:</strong> {formatBRL(member.totalDepositsPaid)}</p>
                  </div>
                </article>
              ))}
            </div>

            {safeItems.length > 5 ? (
              <button type="button" className="admin-toggle-logs-btn" onClick={onToggle}>
                {showAll ? 'Mostrar menos' : `Ver mais (${safeItems.length - 5} restantes)`}
              </button>
            ) : null}
          </>
        ) : (
          <p className="admin-log-hint">Nenhum convidado neste nível.</p>
        )}
      </section>
    )
  }

  return (
    <main className="admin-page">
      <AdminSidebar />
      <section className="admin-content admin-user-details-page">
        <header className="admin-header">
          <div>
            <h1>Detalhes do Usuário</h1>
            <p className="admin-subtitle">Informações completas para gestão administrativa.</p>
          </div>
          <button type="button" className="admin-back-btn" onClick={() => navigate('/adf/users')}>
            Voltar
          </button>
        </header>

        {error ? <p className="admin-kpi-error">{error}</p> : null}

        {loading ? (
          <section className="admin-panel">
            <p>Carregando detalhes...</p>
          </section>
        ) : user ? (
          <>
            <section className="admin-panel admin-user-identity">
              <h2>{user.name}</h2>
              <p><strong>ID:</strong> #{user.id}</p>
              <p><strong>Telefone:</strong> {user.phone}</p>
              <p><strong>Admin:</strong> {user.is_admin ? 'Sim' : 'Não'}</p>
              <p><strong>Status:</strong> {user.is_banned ? 'Banido' : 'Ativo'}</p>
              <p><strong>Cadastrado em:</strong> {user.created_at ? new Date(user.created_at).toLocaleString('pt-BR') : '-'}</p>
            </section>

            <section className="admin-panel admin-user-list-panel">
              <div className="admin-log-header">
                <h3>Ajuste de saldo (admin)</h3>
              </div>

              <form className="admin-balance-adjust-form" onSubmit={handleBalanceAdjust}>
                <div className="admin-balance-adjust-grid">
                  <label>
                    <span>Valor</span>
                    <input
                      type="text"
                      value={adjustAmount}
                      onChange={(e) => setAdjustAmount(e.target.value)}
                      placeholder="0,00"
                      inputMode="decimal"
                    />
                  </label>

                  <label>
                    <span>Operação</span>
                    <select
                      value={adjustOperation}
                      onChange={(e) => setAdjustOperation(e.target.value as 'add' | 'subtract')}
                    >
                      <option value="add">Adicionar saldo</option>
                      <option value="subtract">Retirar saldo</option>
                    </select>
                  </label>

                  <label className="admin-balance-adjust-reason">
                    <span>Motivo (opcional)</span>
                    <input
                      type="text"
                      value={adjustReason}
                      onChange={(e) => setAdjustReason(e.target.value)}
                      placeholder="Ex: correção manual"
                    />
                  </label>
                </div>

                <button type="submit" className="admin-toggle-logs-btn" disabled={adjustLoading}>
                  {adjustLoading ? 'Salvando...' : 'Confirmar ajuste'}
                </button>

                {adjustFeedback ? (
                  <p className={adjustFeedback.type === 'success' ? 'admin-balance-feedback-success' : 'admin-balance-feedback-error'}>
                    {adjustFeedback.message}
                  </p>
                ) : null}
              </form>
            </section>

            <section className="admin-user-metrics-grid">
              <article className="admin-kpi-card">
                <p>Saldo atual</p>
                <strong>{formatBRL(user.balance)}</strong>
              </article>
              <article className="admin-kpi-card">
                <p>Total depósitos pagos</p>
                <strong>{formatBRL(user.totalDepositsPaid)}</strong>
              </article>
              <article className="admin-kpi-card">
                <p>Total saques</p>
                <strong>{formatBRL(user.totalWithdrawals)}</strong>
              </article>
              <article className="admin-kpi-card">
                <p>Total planos ciclo comprados</p>
                <strong>{user.totalCyclePlansBought}</strong>
              </article>
              <article className="admin-kpi-card">
                <p>Total planos VIP comprados</p>
                <strong>{user.totalVipPlansBought}</strong>
              </article>
            </section>

            <section className="admin-panel admin-user-list-panel">
              <div className="admin-log-header">
                <h3>Histórico detalhado</h3>
              </div>
              <p className="admin-log-hint">
                Clique no botão abaixo para abrir a página com: Planos VIP, planos de ciclo, gift codes, check-ins e logs da conta.
              </p>
              <button
                type="button"
                className="admin-toggle-logs-btn"
                onClick={() => navigate(`/adf/users/${user.id}/history`)}
              >
                Abrir histórico detalhado
              </button>
            </section>

            {renderReferralLevel('Convites Nível 1', user.referralsLevel1, showAllLevel1, () => setShowAllLevel1((prev) => !prev))}
            {renderReferralLevel('Convites Nível 2', user.referralsLevel2, showAllLevel2, () => setShowAllLevel2((prev) => !prev))}
            {renderReferralLevel('Convites Nível 3', user.referralsLevel3, showAllLevel3, () => setShowAllLevel3((prev) => !prev))}
          </>
        ) : null}
      </section>
    </main>
  )
}
