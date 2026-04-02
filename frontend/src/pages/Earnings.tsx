import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import './Tasks.css'
import './Earnings.css'

type EarningsApiResponse = {
  ok?: boolean
  summary?: {
    depositsPaid?: number
    depositsPending?: number
    withdrawalsPaid?: number
    withdrawalsPending?: number
  }
  records?: {
    deposits?: Array<{
      id: number
      amount: number
      status: 'paid' | 'pending'
      method?: string
      createdAt?: string
      type?: 'deposit'
    }>
    withdrawals?: Array<{
      id: number
      amount: number
      status: 'paid' | 'pending'
      createdAt?: string
      type?: 'withdraw'
    }>
  }
}

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3333'

const formatBRL = (value: number) =>
  Number(value ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

export default function Earnings() {
  const navigate = useNavigate()
  const [tab, setTab] = useState<'income' | 'expense'>('income')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [deposits, setDeposits] = useState<NonNullable<EarningsApiResponse['records']>['deposits']>([])
  const [withdrawals, setWithdrawals] = useState<NonNullable<EarningsApiResponse['records']>['withdrawals']>([])
  const [summary, setSummary] = useState({
    depositsPaid: 0,
    depositsPending: 0,
    withdrawalsPaid: 0,
    withdrawalsPending: 0,
  })

  useEffect(() => {
    const raw = localStorage.getItem('user') ?? sessionStorage.getItem('user')
    if (!raw) {
      navigate('/')
      return
    }

    let userId = 0
    try {
      userId = Number((JSON.parse(raw) as { id?: number })?.id ?? 0)
    } catch {
      userId = 0
    }

    if (!userId) {
      navigate('/')
      return
    }

    const load = async () => {
      setLoading(true)
      setError('')
      try {
        const res = await fetch(`${API_URL}/api/earnings/records/${userId}`)
        const data = (await res.json()) as EarningsApiResponse

        if (!res.ok || !data?.ok) {
          setError('Não foi possível carregar os registros.')
          return
        }

        setDeposits(data.records?.deposits ?? [])
        setWithdrawals(data.records?.withdrawals ?? [])
        setSummary({
          depositsPaid: Number(data.summary?.depositsPaid ?? 0),
          depositsPending: Number(data.summary?.depositsPending ?? 0),
          withdrawalsPaid: Number(data.summary?.withdrawalsPaid ?? 0),
          withdrawalsPending: Number(data.summary?.withdrawalsPending ?? 0),
        })
      } catch {
        setError('Erro de conexão ao carregar os registros.')
      } finally {
        setLoading(false)
      }
    }

    load()
  }, [navigate])

  const visibleRecords = useMemo(() => {
    return tab === 'income' ? (deposits ?? []) : (withdrawals ?? [])
  }, [tab, deposits, withdrawals])

  const title = tab === 'income' ? 'Registros de Receita' : 'Registros de Despesas'
  const emptyText = tab === 'income' ? 'Nenhum registro de receita' : 'Nenhum registro de despesa'

  return (
    <main className="gradient-backdrop-shell lw-page-shell min-h-screen-safe theme-page-bg earnings-page">
      <div className="lw-gradient-fx fixed inset-0 bg-gradient-to-t from-black via-gray-900 via-slate-800 via-blue-900/30 via-blue-900/20 to-cyan-900/40 pointer-events-none" />
      <div className="lw-gradient-fx fixed inset-0 pointer-events-none">
        <div className="absolute top-0 left-6 w-32 h-32 rounded-full blur-xl bg-[var(--primary-glow-30)] opacity-80" />
        <div className="absolute top-0 right-6 w-36 h-36 rounded-full blur-2xl bg-[var(--primary-glow-20)] opacity-90" />
        <div className="absolute top-0 left-1/3 -translate-x-1/2 w-20 h-20 rounded-full blur-lg bg-[var(--primary-glow-30)] opacity-70" />
      </div>
      <div className="lw-gradient-fx fixed inset-0 opacity-[0.06] pointer-events-none">
        <div className="absolute inset-0 bg-[var(--primary-glow-10)]" />
        <div className="absolute inset-0 bg-[color-mix(in_srgb,var(--primary-electric)_8%,transparent)]" />
      </div>

      <div className="relative z-10 pb-20">
        <div className="earnings-page-shell">
          <div className="earnings-header sticky top-0 z-50">
            <div className="earnings-header-row">
              <button
                className="earnings-icon-btn"
                onClick={() => navigate('/profile')}
                aria-label="Voltar"
                type="button"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="earnings-icon-btn-svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M5 12l14 0" />
                  <path d="M5 12l6 6" />
                  <path d="M5 12l6 -6" />
                </svg>
              </button>

              <div className="earnings-title-wrap">
                <h1 className="earnings-title">
                  <span className="earnings-title-text">{title}</span>
                </h1>
              </div>

              <div className="earnings-header-spacer" aria-hidden="true" />
            </div>
          </div>

          <div className="earnings-controls">
            <div className="earnings-tab-group">
              <button
                className={`earning-tab-btn ${tab === 'income' ? 'active' : ''}`}
                onClick={() => setTab('income')}
                type="button"
              >
                <div className="earning-tab-btn-inner">
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="earning-tab-icon"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M3 17l6 -6l4 4l8 -8" />
                    <path d="M14 7l7 0l0 7" />
                  </svg>
                  <span>Receita</span>
                </div>
              </button>

              <button
                className={`earning-tab-btn ${tab === 'expense' ? 'active' : ''}`}
                onClick={() => setTab('expense')}
                type="button"
              >
                <div className="earning-tab-btn-inner">
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="earning-tab-icon"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M7 7l10 10" />
                    <path d="M17 8l0 9l-9 0" />
                  </svg>
                  <span>Despesas</span>
                </div>
              </button>
            </div>
          </div>

          <div className="earnings-content">
            <section className="earnings-content-panel">
              <div className="earnings-filter-row">
                <div className="earnings-filter-scroll">
                  <button className="earnings-filter-btn active" type="button">
                    Todos
                  </button>
                </div>
              </div>

              <div className="earnings-summary-grid">
                <div className="summary-card">
                  <span>{tab === 'income' ? 'Depósito pago' : 'Saque pago'}</span>
                  <strong>{tab === 'income' ? formatBRL(summary.depositsPaid) : formatBRL(summary.withdrawalsPaid)}</strong>
                </div>
                <div className="summary-card">
                  <span>{tab === 'income' ? 'Depósito pendente' : 'Saque pendente'}</span>
                  <strong>{tab === 'income' ? formatBRL(summary.depositsPending) : formatBRL(summary.withdrawalsPending)}</strong>
                </div>
              </div>

              {loading ? (
                <div className="bg-[var(--surface-panel)] rounded-xl p-8 text-center border border-[color:var(--stroke-subtle)]">
                  <p className="text-[var(--text-secondary)]">Carregando registros...</p>
                </div>
              ) : error ? (
                <div className="bg-[var(--surface-panel)] rounded-xl p-8 text-center border border-[color:var(--stroke-subtle)]">
                  <p className="text-[var(--text-secondary)]">{error}</p>
                </div>
              ) : visibleRecords && visibleRecords.length > 0 ? (
                <div className="space-y-3">
                  {visibleRecords.map((item: NonNullable<(typeof visibleRecords)[number]>) => (
                    <article key={`${tab}-${item.id}`} className="record-card">
                      <div>
                        <h3>{tab === 'income' ? 'Depósito' : 'Saque'}</h3>
                        <p>{item.status === 'paid' ? 'Pago' : 'Pendente'}</p>
                      </div>
                      <strong>{formatBRL(Number(item.amount ?? 0))}</strong>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="earnings-empty-state">
                  <div className="earnings-empty-icon-wrap" aria-hidden="true">
                    <svg xmlns="http://www.w3.org/2000/svg" className="earnings-empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="5" width="18" height="14" rx="3" />
                      <path d="M3 9h18" />
                      <path d="M8 14h2" />
                    </svg>
                  </div>
                  <h3 className="earnings-empty-title">Sem movimentações</h3>
                  <p className="earnings-empty-text">{emptyText}</p>
                </div>
              )}
            </section>
          </div>
        </div>
      </div>
    </main>
  )
}
