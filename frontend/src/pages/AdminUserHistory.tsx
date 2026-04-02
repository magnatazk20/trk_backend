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

type UserDetailsResponse = {
  ok?: boolean
  error?: string
  user?: {
    id: number
    name: string
    phone: string
    vipPurchases?: PurchaseItem[]
    cyclePurchases?: PurchaseItem[]
    giftCodeRedemptions?: GiftCodeRedemptionItem[]
    dailyCheckinRedemptions?: DailyCheckinRedemptionItem[]
    accountLogs?: UserLogItem[]
  }
}

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3333'

const formatBRL = (value: number) =>
  Number(value ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

export default function AdminUserHistory() {
  const { id } = useParams()
  const navigate = useNavigate()

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [user, setUser] = useState<UserDetailsResponse['user'] | null>(null)
  const [showLogs, setShowLogs] = useState(false)
  const [showVipPurchases, setShowVipPurchases] = useState(false)
  const [showCyclePurchases, setShowCyclePurchases] = useState(false)
  const [showGiftCodeRedemptions, setShowGiftCodeRedemptions] = useState(false)
  const [showDailyCheckins, setShowDailyCheckins] = useState(false)

  const token = useMemo(
    () => localStorage.getItem('token') ?? sessionStorage.getItem('token') ?? '',
    []
  )

  useEffect(() => {
    const load = async () => {
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
          setError(data?.error ?? 'Falha ao carregar histórico do usuário.')
          setUser(null)
          return
        }

        setUser(data.user)
      } catch {
        setError('Erro de conexão ao carregar histórico do usuário.')
      } finally {
        setLoading(false)
      }
    }

    load()
  }, [id])

  return (
    <main className="admin-page">
      <AdminSidebar />
      <section className="admin-content admin-user-details-page">
        <header className="admin-header">
          <div>
            <h1>Histórico do Usuário</h1>
            <p className="admin-subtitle">VIP, ciclos, gift codes, check-ins e logs da conta.</p>
          </div>
          <button type="button" className="admin-back-btn" onClick={() => navigate(`/adf/users/${id}`)}>
            Voltar para detalhes
          </button>
        </header>

        {error ? <p className="admin-kpi-error">{error}</p> : null}

        {loading ? (
          <section className="admin-panel">
            <p>Carregando histórico...</p>
          </section>
        ) : user ? (
          <>
            <section className="admin-panel admin-user-list-panel">
              <div className="admin-log-header">
                <h3>Planos VIP comprados</h3>
                <button type="button" className="admin-toggle-logs-btn" onClick={() => setShowVipPurchases((prev) => !prev)}>
                  {showVipPurchases ? 'Ocultar planos VIP' : 'Mostrar planos VIP'}
                </button>
              </div>
              {showVipPurchases ? (
                (user.vipPurchases ?? []).length ? (
                  <div className="admin-user-list">
                    {(user.vipPurchases ?? []).map((item) => (
                      <article key={`vip-${item.id}`} className="admin-user-list-item">
                        <div>
                          <strong>{item.planName}</strong>
                          <p>{item.createdAt ? new Date(item.createdAt).toLocaleString('pt-BR') : '-'}</p>
                        </div>
                        <span>{formatBRL(item.amountPaid)}</span>
                      </article>
                    ))}
                  </div>
                ) : <p>Nenhuma compra VIP encontrada.</p>
              ) : <p className="admin-log-hint">Clique em “Mostrar planos VIP” para visualizar os planos comprados.</p>}
            </section>

            <section className="admin-panel admin-user-list-panel">
              <div className="admin-log-header">
                <h3>Planos de ciclo comprados</h3>
                <button type="button" className="admin-toggle-logs-btn" onClick={() => setShowCyclePurchases((prev) => !prev)}>
                  {showCyclePurchases ? 'Ocultar planos de ciclo' : 'Mostrar planos de ciclo'}
                </button>
              </div>
              {showCyclePurchases ? (
                (user.cyclePurchases ?? []).length ? (
                  <div className="admin-user-list">
                    {(user.cyclePurchases ?? []).map((item) => (
                      <article key={`cycle-${item.id}`} className="admin-user-list-item">
                        <div>
                          <strong>{item.planName}</strong>
                          <p>{item.createdAt ? new Date(item.createdAt).toLocaleString('pt-BR') : '-'}</p>
                        </div>
                        <span>{formatBRL(item.amountPaid)}</span>
                      </article>
                    ))}
                  </div>
                ) : <p>Nenhuma compra de ciclo encontrada.</p>
              ) : <p className="admin-log-hint">Clique em “Mostrar planos de ciclo” para visualizar os planos comprados.</p>}
            </section>

            <section className="admin-panel admin-user-list-panel">
              <div className="admin-log-header">
                <h3>Gift codes resgatados</h3>
                <button type="button" className="admin-toggle-logs-btn" onClick={() => setShowGiftCodeRedemptions((prev) => !prev)}>
                  {showGiftCodeRedemptions ? 'Ocultar gift codes' : 'Mostrar gift codes'}
                </button>
              </div>
              {showGiftCodeRedemptions ? (
                (user.giftCodeRedemptions ?? []).length ? (
                  <div className="admin-user-list">
                    {(user.giftCodeRedemptions ?? []).map((gift) => (
                      <article key={`gift-${gift.id}`} className="admin-user-list-item">
                        <div>
                          <strong>{gift.code}</strong>
                          <p>{gift.createdAt ? new Date(gift.createdAt).toLocaleString('pt-BR') : '-'}</p>
                        </div>
                        <span>{gift.rewardType} • {formatBRL(gift.rewardValue)}</span>
                      </article>
                    ))}
                  </div>
                ) : <p>Nenhum gift code resgatado.</p>
              ) : <p className="admin-log-hint">Clique em “Mostrar gift codes” para visualizar os resgates.</p>}
            </section>

            <section className="admin-panel admin-user-list-panel">
              <div className="admin-log-header">
                <h3>Resgates de check-in diário</h3>
                <button type="button" className="admin-toggle-logs-btn" onClick={() => setShowDailyCheckins((prev) => !prev)}>
                  {showDailyCheckins ? 'Ocultar check-ins' : 'Mostrar check-ins'}
                </button>
              </div>
              {showDailyCheckins ? (
                (user.dailyCheckinRedemptions ?? []).length ? (
                  <div className="admin-user-list">
                    {(user.dailyCheckinRedemptions ?? []).map((item) => (
                      <article key={`checkin-${item.id}`} className="admin-user-list-item">
                        <div>
                          <strong>Dia {item.checkinDay}</strong>
                          <p>{item.checkinDate ? new Date(item.checkinDate).toLocaleDateString('pt-BR') : '-'}</p>
                        </div>
                        <span>{formatBRL(item.rewardAmount)}</span>
                      </article>
                    ))}
                  </div>
                ) : <p>Nenhum resgate de check-in encontrado.</p>
              ) : <p className="admin-log-hint">Clique em “Mostrar check-ins” para visualizar os resgates.</p>}
            </section>

            <section className="admin-panel admin-user-list-panel">
              <div className="admin-log-header">
                <h3>Logs da conta</h3>
                <button type="button" className="admin-toggle-logs-btn" onClick={() => setShowLogs((prev) => !prev)}>
                  {showLogs ? 'Ocultar logs' : 'Mostrar logs'}
                </button>
              </div>
              {showLogs ? (
                (user.accountLogs ?? []).length ? (
                  <div className="admin-user-list">
                    {(user.accountLogs ?? []).map((log) => (
                      <article key={`log-${log.id}`} className="admin-user-log-item">
                        <div>
                          <strong>{log.action}</strong>
                          <p>{log.created_at ? new Date(log.created_at).toLocaleString('pt-BR') : '-'}</p>
                          <small>
                            anterior: {log.old_balance == null ? '-' : formatBRL(log.old_balance)} | novo:{' '}
                            {log.new_balance == null ? '-' : formatBRL(log.new_balance)} | valor:{' '}
                            {log.amount == null ? '-' : formatBRL(log.amount)}
                          </small>
                        </div>
                      </article>
                    ))}
                  </div>
                ) : <p>Nenhum log encontrado.</p>
              ) : <p className="admin-log-hint">Clique em “Mostrar logs” para visualizar o histórico da conta.</p>}
            </section>
          </>
        ) : null}
      </section>
    </main>
  )
}
