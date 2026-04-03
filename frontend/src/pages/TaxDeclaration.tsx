import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import AppSidebar from '../components/AppSidebar'
import './Tasks.css'
import './TaxDeclaration.css'

type StoredUser = {
  id: number
  name: string
  phone: string
}

type PaidTransaction = {
  id: number | string
  date: string
  description: string
  amount: number
  status: 'paid'
  type: 'deposit' | 'withdraw'
}

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3333'

const formatBRL = (value: number) =>
  Number(value ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

export default function TaxDeclaration() {
  const navigate = useNavigate()

  const user = useMemo(() => {
    const raw = localStorage.getItem('user') ?? sessionStorage.getItem('user')
    if (!raw) return null
    try {
      return JSON.parse(raw) as StoredUser
    } catch {
      return null
    }
  }, [])

  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [loadingTransactions, setLoadingTransactions] = useState(false)
  const [transactionsError, setTransactionsError] = useState('')
  const [paidTransactions, setPaidTransactions] = useState<PaidTransaction[]>([])

  const loadPaidTransactions = async () => {
    if (!user?.id) {
      setTransactionsError('Usuário não autenticado.')
      return
    }

    setLoadingTransactions(true)
    setTransactionsError('')

    try {
      const params = new URLSearchParams()
      if (fromDate) params.append('from', fromDate)
      if (toDate) params.append('to', toDate)

      const query = params.toString()
      const url = `${API_URL}/api/transactions/paid/${user.id}${query ? `?${query}` : ''}`

      const res = await fetch(url)
      const data = (await res.json()) as {
        ok?: boolean
        transactions?: Array<{
          id?: number | string
          createdAt?: string
          paidAt?: string
          description?: string
          amount?: number
          status?: string
          type?: 'deposit' | 'withdraw'
        }>
      }

      if (!res.ok || !data?.ok || !Array.isArray(data.transactions)) {
        setPaidTransactions([])
        setTransactionsError('Não foi possível carregar transações pagas no momento.')
        return
      }

      const normalized: PaidTransaction[] = data.transactions.map((tx, index) => {
        const type: PaidTransaction['type'] = tx.type === 'withdraw' ? 'withdraw' : 'deposit'
        return {
          id: tx.id ?? index + 1,
          date: String(tx.paidAt ?? tx.createdAt ?? ''),
          description: String(tx.description ?? (type === 'withdraw' ? 'Saque pago' : 'Depósito pago')),
          amount: Number(tx.amount ?? 0),
          status: 'paid' as const,
          type,
        }
      })

      setPaidTransactions(normalized)
    } catch {
      setPaidTransactions([])
      setTransactionsError('Endpoint de transações pagas indisponível.')
    } finally {
      setLoadingTransactions(false)
    }
  }

  const printPaidTransactionsPdf = () => {
    if (!paidTransactions.length) {
      setTransactionsError('Carregue ao menos uma transação paga antes de gerar PDF.')
      setTimeout(() => setTransactionsError(''), 2200)
      return
    }
    window.print()
  }

  const totalPaid = paidTransactions.reduce((sum, item) => sum + Number(item.amount ?? 0), 0)
  const issueDate = new Date().toLocaleString('pt-BR')
  const protocol = `IR-${user?.id ?? '0000'}-${new Date().getTime()}`

  return (
    <main className="tasks-page tax-page">
      <AppSidebar />
      <header className="tasks-header">
        <div>
          <p className="tasks-kicker">Fiscal</p>
          <h1>Declaração de Imposto de Renda</h1>
          <span className="tasks-subtitle">Relatório de depósitos e saques aprovados (paid) para declaração</span>
        </div>
        <div className="tasks-header-actions">
          <button className="btn ghost" type="button" onClick={() => navigate('/profile')}>
            Voltar
          </button>
        </div>
      </header>

      <section className="tax-card tax-report-card">
        <div className="tax-form">
          <h2>Relatório de Transações Pagas (Imposto de Renda)</h2>
          <p className="tax-report-subtitle">Filtre o período e gere um PDF com as transações pagas da conta.</p>

          <div className="tax-controls no-print">
            <div className="tax-grid">
              <label>
                De
                <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
              </label>
              <label>
                Até
                <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
              </label>
            </div>

            <div className="tax-actions tax-report-actions">
              <button type="button" className="tax-outline-btn" onClick={loadPaidTransactions} disabled={loadingTransactions}>
                {loadingTransactions ? 'Carregando...' : 'Buscar transações pagas'}
              </button>
              <button type="button" className="tax-submit-btn" onClick={printPaidTransactionsPdf}>
                Baixar PDF (Pagos)
              </button>
            </div>
          </div>

          {transactionsError ? <div className="tax-error no-print">{transactionsError}</div> : null}

          <div className="print-report-area" id="paid-transactions-report">
            <div className="report-header">
              <div className="company-header">
                <div>
                  <h3>PGLM SOLUCOES LTDA</h3>
                  <p className="company-sub">Comprovante Fiscal de Transações Aprovadas</p>
                  <p>CNPJ Nº 49.710.828/0001-22</p>
                  <p>Rua Arealva, nº 373, Bairro Vila Arizona, Itaquaquecetuba - SP, CEP: 08575-520</p>
                </div>
                <div className="company-meta">
                  <p><strong>Emissão:</strong> {issueDate}</p>
                  <p><strong>Protocolo:</strong> {protocol}</p>
                  <p><strong>Ano-base:</strong> {new Date().getFullYear()}</p>
                </div>
              </div>

              <div className="report-client-block">
                <p><strong>Período:</strong> {fromDate || '---'} até {toDate || '---'}</p>
                <p><strong>Titular da Conta:</strong> {user?.name ?? '-'}</p>
                <p><strong>Telefone:</strong> {user?.phone ?? '-'}</p>
                <p><strong>Natureza:</strong> Depósitos e saques aprovados (status paid)</p>
              </div>
            </div>

            <div className="tax-table-wrap">
              <table className="tax-table">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Data</th>
                    <th>Descrição</th>
                    <th>Tipo</th>
                    <th>Status</th>
                    <th>Valor</th>
                  </tr>
                </thead>
                <tbody>
                  {paidTransactions.length ? (
                    paidTransactions.map((tx, index) => (
                      <tr key={tx.id} className={index % 2 === 0 ? 'row-even' : 'row-odd'}>
                        <td>{tx.id}</td>
                        <td>{tx.date ? new Date(tx.date).toLocaleDateString('pt-BR') : '-'}</td>
                        <td>{tx.description}</td>
                        <td>{tx.type === 'withdraw' ? 'Saque' : 'Depósito'}</td>
                        <td><span className="status-paid">Pago</span></td>
                        <td>{formatBRL(tx.amount)}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={6} className="tax-empty">Sem transações aprovadas no período informado.</td>
                    </tr>
                  )}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={5}>Total pago no período</td>
                    <td>{formatBRL(totalPaid)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>

          </div>
        </div>
      </section>
    </main>
  )
}
