import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import AppSidebar from '../components/AppSidebar'
import './Tasks.css'
import './Withdraw.css'

type StoredUser = {
  id: number
  name: string
  phone: string
}

type PixType = 'CPF' | 'CNPJ' | 'EMAIL' | 'TELEFONE' | 'CHAVE_ALEATORIA'

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3333'

const formatBRL = (value: number) =>
  Number(value ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

export default function Withdraw() {
  const navigate = useNavigate()
  const token = useMemo(
    () => localStorage.getItem('token') ?? sessionStorage.getItem('token'),
    []
  )

  const user = useMemo(() => {
    const raw = localStorage.getItem('user') ?? sessionStorage.getItem('user')
    if (!raw) return null
    try {
      return JSON.parse(raw) as StoredUser
    } catch {
      return null
    }
  }, [])

  const [amount, setAmount] = useState('')
  const [holderName, setHolderName] = useState('')
  const [holderCpf, setHolderCpf] = useState('')
  const [pixType, setPixType] = useState<PixType>('CHAVE_ALEATORIA')
  const [pixKey, setPixKey] = useState('')
  const [withdrawPassword, setWithdrawPassword] = useState('')
  const [loadingPixData, setLoadingPixData] = useState(false)

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const [lastRequest, setLastRequest] = useState<{
    amount: number
    status: string
    transactionId?: string | null
    externalId?: string | null
  } | null>(null)

  const normalizeCpf = (value: string) => value.replace(/\D/g, '')

  useEffect(() => {
    if (!token || !user?.id) {
      localStorage.removeItem('token')
      localStorage.removeItem('user')
      sessionStorage.removeItem('token')
      sessionStorage.removeItem('user')
      navigate('/')
      return
    }

    const loadStoredPix = async () => {
      if (!user?.id || !token) return

      setLoadingPixData(true)
      try {
        const res = await fetch(`${API_URL}/api/user/pix-key/${user.id}`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        })
        const data = (await res.json()) as {
          ok?: boolean
          hasPixKey?: boolean
          pixKey?: {
            holderName?: string
            holderCpf?: string
            pixKeyType?: PixType
            pixKey?: string
          } | null
        }

        if (res.status === 401 || res.status === 403) {
          localStorage.removeItem('token')
          localStorage.removeItem('user')
          sessionStorage.removeItem('token')
          sessionStorage.removeItem('user')
          navigate('/')
          return
        }

        if (!res.ok || !data?.ok || !data.hasPixKey || !data.pixKey) return

        setHolderName(String(data.pixKey.holderName ?? ''))
        setHolderCpf(String(data.pixKey.holderCpf ?? ''))
        setPixType((data.pixKey.pixKeyType as PixType) ?? 'CHAVE_ALEATORIA')
        setPixKey(String(data.pixKey.pixKey ?? ''))
      } catch {
        // silencioso: usuário ainda pode preencher manualmente
      } finally {
        setLoadingPixData(false)
      }
    }

    loadStoredPix()
  }, [navigate, token, user?.id])

  const submitWithdraw = async () => {
    setError('')
    setSuccess('')

    if (!token || !user?.id) {
      setError('Usuário não autenticado.')
      localStorage.removeItem('token')
      localStorage.removeItem('user')
      sessionStorage.removeItem('token')
      sessionStorage.removeItem('user')
      navigate('/')
      return
    }

    const parsedAmount = Number(amount.replace(',', '.'))
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
      setError('Informe um valor de saque válido.')
      return
    }

    if (!holderName.trim()) {
      setError('Informe o nome do titular.')
      return
    }

    const cpf = normalizeCpf(holderCpf)
    if (cpf.length !== 11) {
      setError('CPF do titular inválido.')
      return
    }

    if (!pixKey.trim()) {
      setError('Informe a chave PIX.')
      return
    }

    if (!withdrawPassword || withdrawPassword.length < 6) {
      setError('Informe a senha de saque (mínimo 6 caracteres).')
      return
    }

    setLoading(true)
    try {
      const response = await fetch(`${API_URL}/api/withdraw/request`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          userId: user.id,
          amount: parsedAmount,
          holderName: holderName.trim(),
          holderCpf: cpf,
          pixKeyType: pixType,
          pixKey: pixKey.trim(),
          withdrawPassword,
        }),
      })

      const data = (await response.json()) as {
        ok?: boolean
        error?: string
        message?: string
        withdraw?: {
          amount?: number
          status?: string
          transactionId?: string | null
          externalId?: string | null
        }
      }

      if (response.status === 401 || response.status === 403) {
        localStorage.removeItem('token')
        localStorage.removeItem('user')
        sessionStorage.removeItem('token')
        sessionStorage.removeItem('user')
        navigate('/')
        return
      }

      if (!response.ok || !data?.ok) {
        setError(data?.error ?? 'Não foi possível solicitar saque.')
        return
      }

      const amountReturned = Number(data.withdraw?.amount ?? parsedAmount)
      const statusReturned = String(data.withdraw?.status ?? 'processing')

      setSuccess(data.message ?? 'Solicitação de saque enviada com sucesso.')
      setLastRequest({
        amount: amountReturned,
        status: statusReturned,
        transactionId: data.withdraw?.transactionId ?? null,
        externalId: data.withdraw?.externalId ?? null,
      })
    } catch {
      setError('Erro de conexão ao solicitar saque.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="tasks-page withdraw-page">
      <AppSidebar />

      <header className="tasks-header">
        <div>
          <p className="tasks-kicker">Financeiro</p>
          <h1>Saque</h1>
          <span className="tasks-subtitle">Solicite seu saque PIX e acompanhe o processamento pelo webhook.</span>
        </div>
        <div className="tasks-header-actions">
          <button className="btn ghost" type="button" onClick={() => navigate('/dashboard')}>
            Voltar
          </button>
        </div>
      </header>

      <section className="withdraw-card">
        <h2>Solicitação de Saque PIX</h2>
        <p className="withdraw-help">
          Seus dados PIX são carregados automaticamente e ficam bloqueados aqui.
          Para alterar a chave PIX, use o botão abaixo.
        </p>

        <div className="withdraw-grid">
          <label>
            Valor do saque (R$)
            <input
              type="text"
              inputMode="decimal"
              placeholder="0,00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>

          <label>
            Nome do titular
            <input
              type="text"
              placeholder="Nome completo"
              value={holderName}
              onChange={(e) => setHolderName(e.target.value)}
              disabled
            />
          </label>

          <label>
            CPF do titular
            <input
              type="text"
              inputMode="numeric"
              placeholder="Somente números"
              value={holderCpf}
              onChange={(e) => setHolderCpf(e.target.value)}
              disabled
            />
          </label>

          <label>
            Tipo da chave PIX
            <select value={pixType} onChange={(e) => setPixType(e.target.value as PixType)} disabled>
              <option value="CPF">CPF</option>
              <option value="CNPJ">CNPJ</option>
              <option value="EMAIL">E-mail</option>
              <option value="TELEFONE">Telefone</option>
              <option value="CHAVE_ALEATORIA">Chave aleatória</option>
            </select>
          </label>

          <label className="withdraw-full">
            Chave PIX
            <input
              type="text"
              placeholder="Digite sua chave PIX"
              value={pixKey}
              onChange={(e) => setPixKey(e.target.value)}
              disabled
            />
          </label>

          <label className="withdraw-full">
            Senha de saque
            <input
              type="password"
              placeholder="Senha de saque cadastrada"
              value={withdrawPassword}
              onChange={(e) => setWithdrawPassword(e.target.value)}
            />
          </label>
        </div>

        {loadingPixData ? <div className="withdraw-feedback">Carregando chave PIX salva...</div> : null}

        <div className="withdraw-bankcards-link-wrap">
          <button type="button" className="withdraw-bankcards-link" onClick={() => navigate('/bank-cards')}>
            Alterar chave PIX
          </button>
        </div>

        <div className="withdraw-actions">
          <button type="button" className="withdraw-submit" disabled={loading} onClick={submitWithdraw}>
            {loading ? 'Enviando...' : 'Solicitar saque'}
          </button>
        </div>

        {error ? <div className="withdraw-feedback error">{error}</div> : null}
        {success ? <div className="withdraw-feedback success">{success}</div> : null}

        {lastRequest ? (
          <div className="withdraw-status-card">
            <h3>Status da última solicitação</h3>
            <p><strong>Valor:</strong> {formatBRL(lastRequest.amount)}</p>
            <p><strong>Status:</strong> {lastRequest.status}</p>
            <p><strong>Transaction ID:</strong> {lastRequest.transactionId ?? '-'}</p>
            <p><strong>External ID:</strong> {lastRequest.externalId ?? '-'}</p>
          </div>
        ) : null}
      </section>
    </main>
  )
}
