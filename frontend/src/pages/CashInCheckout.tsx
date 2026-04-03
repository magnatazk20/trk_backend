import { useMemo, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import './CashInCheckout.css'

type CheckoutState = {
  amount?: number
  transactionId?: string | number | null
  qrCode?: string
  qrImage?: string
}

function formatBRL(value: number) {
  return value.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  })
}

export default function CashInCheckout() {
  const navigate = useNavigate()
  const location = useLocation()
  const [copied, setCopied] = useState(false)

  const data = (location.state ?? {}) as CheckoutState

  const amount = Number(data.amount ?? 0)
  const transactionId = data.transactionId ?? '-'
  const pixCode = (data.qrCode ?? '').trim()
  const qrImage = (data.qrImage ?? '').trim()

  const generatedQrUrl = useMemo(() => {
    if (!pixCode) return ''
    const encoded = encodeURIComponent(pixCode)
    return `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encoded}&color=000000&bgcolor=FFFFFF&margin=1`
  }, [pixCode])

  const hasData = useMemo(() => amount > 0 && pixCode.length > 0, [amount, pixCode])

  const handleCopy = async () => {
    if (!pixCode) return
    try {
      await navigator.clipboard.writeText(pixCode)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  if (!hasData) {
    return (
      <main className="cashin-checkout-page">
        <section className="bank-card">
          <h1>Pagamento PIX</h1>
          <p className="checkout-warning">
            Dados de cobrança não encontrados. Volte e gere um novo pagamento.
          </p>
          <div className="checkout-actions">
            <Link to="/cashin" className="btn secondary">Voltar para depósito</Link>
            <button type="button" className="btn primary" onClick={() => navigate('/dashboard')}>
              Ir para dashboard
            </button>
          </div>
        </section>
      </main>
    )
  }

  return (
    <main className="cashin-checkout-page">
      <section className="bank-card">
        <header className="bank-header">
          <div>
            <small className="bank-brand">NOOR BANK • PIX</small>
            <h1>Concluir depósito</h1>
            <p>Escaneie o QR Code no seu banco ou copie o código PIX para pagar.</p>
          </div>
          <span className="status-chip">Aguardando pagamento</span>
        </header>

        <div className="checkout-grid">
          <article className="qr-panel">
            <h2>QR Code PIX</h2>
            <div className="qr-box">
              {generatedQrUrl ? (
                <img src={generatedQrUrl} alt="QR Code PIX" />
              ) : qrImage ? (
                <img src={qrImage} alt="QR Code PIX" />
              ) : (
                <div className="qr-fallback">
                  <span>QR disponível via código PIX abaixo</span>
                </div>
              )}
            </div>
            <p className="hint">Valor: <strong>{formatBRL(amount)}</strong></p>
            <p className="hint">Transação: <strong>{String(transactionId)}</strong></p>
          </article>

          <article className="pix-panel">
            <h2>PIX Copia e Cola</h2>
            <textarea readOnly value={pixCode} />
            <button type="button" className="btn copy" onClick={handleCopy}>
              {copied ? 'Copiado ✅' : 'Copiar código PIX'}
            </button>

            <div className="checkout-actions">
              <Link to="/cashin" className="btn secondary">Gerar novo pagamento</Link>
              <button type="button" className="btn primary" onClick={() => navigate('/dashboard')}>
                Já paguei / Voltar ao dashboard
              </button>
            </div>
          </article>
        </div>
      </section>
    </main>
  )
}
