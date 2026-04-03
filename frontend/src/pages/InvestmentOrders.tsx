import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import './InvestmentOrders.css'

type StoredUser = {
  id: number
  name: string
  phone: string
}

type OrderItem = {
  id: number
  userId: number
  cycleProductId: number
  productName: string
  amountPaid: number
  expectedProfit: number
  cycleDays: number
  status: string
  uiStatus: 'ongoing' | 'completed'
  startedAt: string | null
  endsAt: string | null
}

type OrdersResponse = {
  ok?: boolean
  orders?: OrderItem[]
  error?: string
}

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3333'

const formatBRL = (value: number) =>
  Number(value ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

const formatDateTime = (value: string | null) => {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '-'
  return date.toLocaleString('pt-BR')
}

type FilterType = 'all' | 'ongoing' | 'completed'

export default function InvestmentOrders() {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(true)
  const [orders, setOrders] = useState<OrderItem[]>([])
  const [filter, setFilter] = useState<FilterType>('all')
  const [error, setError] = useState('')

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
    const loadOrders = async () => {
      if (!user?.id) {
        navigate('/')
        return
      }

      setLoading(true)
      setError('')

      try {
        const res = await fetch(`${API_URL}/api/cycles/orders/${user.id}`)
        const data = (await res.json()) as OrdersResponse

        if (!res.ok || !data?.ok) {
          setError(data?.error ?? 'Erro ao carregar pedidos.')
          setOrders([])
          return
        }

        setOrders(Array.isArray(data.orders) ? data.orders : [])
      } catch {
        setError('Erro de conexão ao carregar pedidos.')
        setOrders([])
      } finally {
        setLoading(false)
      }
    }

    loadOrders()
  }, [navigate, user?.id])

  const filteredOrders = useMemo(() => {
    if (filter === 'all') return orders
    if (filter === 'ongoing') return orders.filter((order) => order.uiStatus === 'ongoing')
    return orders.filter((order) => order.uiStatus === 'completed')
  }, [filter, orders])

  return (
    <div className="gradient-backdrop-shell lw-page-shell min-h-screen-safe theme-page-bg investment-orders-page">
      <div className="lw-gradient-fx layer-one" />
      <div className="lw-gradient-fx layer-two">
        <div className="orb orb-left" />
        <div className="orb orb-right" />
        <div className="orb orb-center" />
      </div>
      <div className="lw-gradient-fx layer-three">
        <div className="overlay-a" />
        <div className="overlay-b" />
      </div>

      <div className="relative-content">
        <div className="orders-sticky-header-wrap">
          <div className="orders-sticky-header">
            <button className="orders-back-btn" onClick={() => navigate('/profile')} type="button" aria-label="Voltar">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M5 12l14 0" />
                <path d="M5 12l6 6" />
                <path d="M5 12l6 -6" />
              </svg>
            </button>

            <div className="orders-title-wrap">
              <h1><span>Pedidos de Investimento</span></h1>
            </div>

            <div className="orders-header-right-space" />
          </div>
        </div>

        <div className="orders-filters-panel">
          <div className="orders-filters-row">
            <button
              className={filter === 'all' ? 'active' : ''}
              onClick={() => setFilter('all')}
              type="button"
            >
              Todos
            </button>
            <button
              className={filter === 'ongoing' ? 'active' : ''}
              onClick={() => setFilter('ongoing')}
              type="button"
            >
              Em Andamento
            </button>
            <button
              className={filter === 'completed' ? 'active' : ''}
              onClick={() => setFilter('completed')}
              type="button"
            >
              Concluído
            </button>
          </div>
        </div>

        <div className="orders-content">
          {loading ? (
            <div className="orders-empty">
              <div className="orders-empty-title">Carregando pedidos...</div>
            </div>
          ) : error ? (
            <div className="orders-empty">
              <div className="orders-empty-title">{error}</div>
            </div>
          ) : filteredOrders.length === 0 ? (
            <div className="orders-empty">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 3l8 4.5l0 9l-8 4.5l-8 -4.5l0 -9l8 -4.5" />
                <path d="M12 12l8 -4.5" />
                <path d="M12 12l0 9" />
                <path d="M12 12l-8 -4.5" />
                <path d="M16 5.25l-8 4.5" />
              </svg>
              <div className="orders-empty-title">Nenhum pedido de investimento</div>
              <div className="orders-empty-subtitle">Inicie seu primeiro investimento</div>
            </div>
          ) : (
            <div className="orders-list">
              {filteredOrders.map((order) => (
                <article key={order.id} className="order-card">
                  <header>
                    <h3>{order.productName}</h3>
                    <span className={`order-status ${order.uiStatus}`}>
                      {order.uiStatus === 'ongoing' ? 'Em Andamento' : 'Concluído'}
                    </span>
                  </header>

                  <div className="order-grid">
                    <p><strong>Pedido:</strong> #{order.id}</p>
                    <p><strong>Valor pago:</strong> {formatBRL(order.amountPaid)}</p>
                    <p><strong>Lucro esperado:</strong> {formatBRL(order.expectedProfit)}</p>
                    <p><strong>Duração:</strong> {order.cycleDays} dias</p>
                    <p><strong>Início:</strong> {formatDateTime(order.startedAt)}</p>
                    <p><strong>Término:</strong> {formatDateTime(order.endsAt)}</p>
                  </div>
                </article>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
