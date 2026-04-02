import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import './CashIn.css'

type StorageUser = {
  id: number
  name: string
  phone: string
}

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3333'

export default function CashIn() {
  const navigate = useNavigate()
  const [amount, setAmount] = useState('')
  const method = 'pix'
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const user = useMemo(() => {
    const raw = localStorage.getItem('user') ?? sessionStorage.getItem('user')
    if (!raw) return null
    try {
      return JSON.parse(raw) as StorageUser
    } catch {
      return null
    }
  }, [])

  const submitCashIn = async (event: FormEvent) => {
    event.preventDefault()
    setMessage(null)

    if (!user?.id) {
      setMessage({ type: 'error', text: 'Usuário não autenticado. Faça login novamente.' })
      return
    }

    const normalized = Number(amount.replace(',', '.'))
    if (!Number.isFinite(normalized) || normalized <= 0) {
      setMessage({ type: 'error', text: 'Informe um valor válido maior que zero.' })
      return
    }

    try {
      setLoading(true)

      const response = await fetch(`${API_URL}/api/CASHIN/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id, amount: normalized, method }),
      })

      const data = (await response.json()) as {
        message?: string
        error?: string
        transactionId?: string | number | null
        qrCode?: string
        provider?: {
          data?: {
            payment_data?: {
              qr_code_base64?: string
              qr_code_image?: string
            }
          }
        }
      }

      if (!response.ok) {
        setMessage({ type: 'error', text: data.error ?? 'Falha ao processar depósito.' })
        return
      }

      const qrImage =
        data.provider?.data?.payment_data?.qr_code_image ??
        data.provider?.data?.payment_data?.qr_code_base64 ??
        ''

      setAmount('')

      navigate('/cashin/checkout', {
        state: {
          amount: normalized,
          transactionId: data.transactionId ?? null,
          qrCode: data.qrCode ?? '',
          qrImage,
        },
      })
    } catch {
      setMessage({ type: 'error', text: 'Erro de conexão com servidor.' })
    } finally {
      setLoading(false)
    }
  }

  const quickAmounts = [20, 50, 100, 200, 500]
  const normalized = Number(amount.replace(',', '.'))
  const displayValue = Number.isFinite(normalized) && normalized > 0 ? normalized : 0

  return (
    <main className="cashin-page">
      <section className="cashin-card">
        <header className="cashin-header">
          <div>
            <h1>Depositar saldo</h1>
            <p>Ambiente seguro com confirmação via PIX em segundos.</p>
          </div>
          <Link to="/dashboard" className="cashin-back-link">
            Voltar
          </Link>
        </header>

        <div className="cashin-layout">
          <form className="cashin-form" onSubmit={submitCashIn}>
            <div className="cashin-label-row">
              <span>Valor do depósito</span>
              <small>mín. R$ 1,00 • máx. R$ 1.000,00</small>
            </div>

            <label>
              <input
                type="text"
                inputMode="decimal"
                placeholder="Ex.: 50,00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </label>

            <div className="cashin-quick-values">
              {quickAmounts.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={`quick-chip ${displayValue === value ? 'active' : ''}`}
                  onClick={() => setAmount(String(value))}
                >
                  R$ {value}
                </button>
              ))}
            </div>

            <label>
              Método de pagamento
              <input type="text" value="PIX (instantâneo)" disabled />
            </label>

            <button type="submit" className="cashin-submit" disabled={loading}>
              {loading ? 'Gerando cobrança...' : 'Gerar cobrança PIX'}
            </button>

            <button type="button" className="cashin-dashboard-btn" onClick={() => navigate('/dashboard')}>
              Ir para dashboard
            </button>

            {message ? (
              <p className={`cashin-message ${message.type}`} role="status" aria-live="polite">
                {message.text}
              </p>
            ) : null}
          </form>

          <aside className="cashin-side-panel">
            <h2>Resumo da operação</h2>
            <div className="summary-row">
              <span>Valor digitado</span>
              <strong>
                {displayValue.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
              </strong>
            </div>
            <div className="summary-row">
              <span>Taxa</span>
              <strong>R$ 0,00</strong>
            </div>
            <div className="summary-row total">
              <span>Total a pagar</span>
              <strong>
                {displayValue.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
              </strong>
            </div>

            <div className="cashin-security">
              <p>🔒 Transação protegida e criptografada</p>
              <p>⚡ Compensação rápida via PIX</p>
              <p>🏦 Checkout com QR Code e copia e cola</p>
            </div>
          </aside>
        </div>
      </section>
    </main>
  )
}
