import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import './BankCards.css'

type StoredUser = {
  id: number
  name: string
  phone: string
}

type PixKeyType = 'CPF' | 'CNPJ' | 'EMAIL' | 'TELEFONE' | 'CHAVE_ALEATORIA'

type PixKeyResponse = {
  ok?: boolean
  hasPixKey?: boolean
  pixKey?: {
    userId: number
    holderName: string
    holderCpf: string
    pixKeyType: PixKeyType
    pixKey: string
  } | null
  error?: string
}

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3333'

export default function BankCards() {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState<{ show: boolean; type: 'success' | 'error'; message: string }>({
    show: false,
    type: 'success',
    message: '',
  })
  const [holderName, setHolderName] = useState('')
  const [holderCpf, setHolderCpf] = useState('')
  const [pixKeyType, setPixKeyType] = useState<PixKeyType>('CPF')
  const [pixKey, setPixKey] = useState('')
  const [isDefaultCard, setIsDefaultCard] = useState(true)

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
    const loadPixData = async () => {
      if (!user?.id) {
        navigate('/')
        return
      }

      setLoading(true)
      try {
        const res = await fetch(`${API_URL}/api/user/pix-key/${user.id}`)
        const data = (await res.json()) as PixKeyResponse

        if (!res.ok || !data?.ok) {
          setToast({ show: true, type: 'error', message: data?.error ?? 'Erro ao carregar dados PIX.' })
          setTimeout(() => setToast((prev) => ({ ...prev, show: false })), 2200)
          return
        }

        if (data.hasPixKey && data.pixKey) {
          setHolderName(String(data.pixKey.holderName ?? ''))
          setHolderCpf(String(data.pixKey.holderCpf ?? ''))
          setPixKeyType((data.pixKey.pixKeyType as PixKeyType) ?? 'CPF')
          setPixKey(String(data.pixKey.pixKey ?? ''))
        }
      } catch {
        setToast({ show: true, type: 'error', message: 'Erro de conexão ao carregar chave PIX.' })
        setTimeout(() => setToast((prev) => ({ ...prev, show: false })), 2200)
      } finally {
        setLoading(false)
      }
    }

    loadPixData()
  }, [navigate, user?.id])

  const onSave = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!user?.id) return

    const payload = {
      userId: user.id,
      holderName: holderName.trim(),
      holderCpf: holderCpf.replace(/\D/g, ''),
      pixKeyType,
      pixKey: pixKey.trim(),
    }

    if (!payload.holderName || !payload.holderCpf || !payload.pixKey) {
      setToast({ show: true, type: 'error', message: 'Preencha todos os campos obrigatórios.' })
      setTimeout(() => setToast((prev) => ({ ...prev, show: false })), 2200)
      return
    }

    setSaving(true)

    try {
      const res = await fetch(`${API_URL}/api/user/pix-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })

      const data = (await res.json()) as { ok?: boolean; error?: string; message?: string }

      if (!res.ok || !data?.ok) {
        const msg = data?.error ?? 'Erro ao salvar chave PIX.'
        setToast({ show: true, type: 'error', message: msg })
        setTimeout(() => {
          setToast((prev) => ({ ...prev, show: false }))
        }, 2200)
        return
      }

      const msg = data?.message ?? 'Chave PIX salva com sucesso.'
      setToast({ show: true, type: 'success', message: msg })
      setTimeout(() => {
        setToast((prev) => ({ ...prev, show: false }))
      }, 2200)
    } catch {
      const msg = 'Erro de conexão ao salvar chave PIX.'
      setToast({ show: true, type: 'error', message: msg })
      setTimeout(() => {
        setToast((prev) => ({ ...prev, show: false }))
      }, 2200)
    } finally {
      setSaving(false)
    }
  }

  return (
    <main className="bankcards-page">
      {toast.show ? (
        <div className={`bankcards-toast ${toast.type}`} role="status" aria-live="polite">
          {toast.message}
        </div>
      ) : null}
      <header className="bankcards-topbar">
        <button className="bankcards-back" type="button" onClick={() => navigate('/profile')} aria-label="Voltar">
          ←
        </button>
        <h1>Cartões Bancários</h1>
        <span />
      </header>

      <div className="bankcards-wrap">
        <div className="bankcards-type-section">
          <label className="bankcards-label">Tipo de Cartão</label>
          <div className="bankcards-type-grid">
            <button type="button" className="bankcards-type-btn active">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M3 5m0 3a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v8a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3z" />
                <path d="M3 10l18 0" />
                <path d="M7 15l.01 0" />
                <path d="M11 15l2 0" />
              </svg>
              <span>Cartão Bancário</span>
            </button>
          </div>
        </div>

        {loading ? (
          <div className="bankcards-loading">Carregando dados...</div>
        ) : (
          <form className="bankcards-form" onSubmit={onSave}>
            <div>
              <label className="bankcards-label">Tipo PIX <span>*</span></label>
              <div className="bankcards-select-wrap">
                <select
                  className="bankcards-select"
                  value={pixKeyType}
                  onChange={(e) => setPixKeyType(e.target.value as PixKeyType)}
                >
                  <option value="CPF">CPF</option>
                  <option value="CNPJ">CNPJ</option>
                  <option value="EMAIL">EMAIL</option>
                  <option value="TELEFONE">TELEFONE</option>
                  <option value="CHAVE_ALEATORIA">CHAVE ALEATÓRIA</option>
                </select>
              </div>
            </div>

            <div>
              <label className="bankcards-label">Nome da Conta <span>*</span></label>
              <input
                className="bankcards-input"
                placeholder="Informe o nome do titular da conta"
                value={holderName}
                onChange={(e) => setHolderName(e.target.value)}
              />
            </div>

            <div>
              <label className="bankcards-label">Número do Cartão <span>*</span></label>
              <input
                className="bankcards-input mono"
                placeholder="CPF/CNPJ/Email/Chave PIX"
                value={pixKey}
                onChange={(e) => setPixKey(e.target.value)}
              />
            </div>

            <div>
              <label className="bankcards-label">CPF do titular <span>*</span></label>
              <input
                className="bankcards-input"
                placeholder="Digite o CPF do titular"
                value={holderCpf}
                onChange={(e) => setHolderCpf(e.target.value)}
              />
            </div>

            <button type="button" className="bankcards-toggle-row" onClick={() => setIsDefaultCard((v) => !v)}>
              <span>Definir como Cartão Padrão</span>
              <span className={`toggle ${isDefaultCard ? 'on' : ''}`}>
                <span className="dot" />
              </span>
            </button>

            <button type="submit" className="bankcards-submit" disabled={saving}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M3 5m0 3a3 3 0 0 1 3 -3h12a3 3 0 0 1 3 3v8a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3z" />
                <path d="M3 10l18 0" />
                <path d="M7 15l.01 0" />
                <path d="M11 15l2 0" />
              </svg>
              <span>{saving ? 'Salvando...' : 'Adicionar Cartão Bancário'}</span>
            </button>
          </form>
        )}

        <div className="bankcards-security-box">
          <p>Suas informações de cartão bancário serão criptografadas com segurança</p>
        </div>
      </div>
    </main>
  )
}
