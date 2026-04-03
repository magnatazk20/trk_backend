import { useEffect, useMemo, useState } from 'react'
import AdminSidebar from '../components/AdminSidebar'
import './Admin.css'

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3333'

type RankedReferralUser = {
  id: number
  name: string
  phone: string
  level1Count: number
  level2Count: number
  level3Count: number
  totalReferrals: number
}

type RankedBalanceUser = {
  id: number
  name: string
  phone: string
  balance: number
}

type RankingsApiResponse = {
  ok?: boolean
  rankings?: {
    referrals?: RankedReferralUser[]
    balances?: RankedBalanceUser[]
  }
  error?: string
}

const formatBRL = (value: number) =>
  Number(value ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

export default function AdminRankings() {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [referralRanking, setReferralRanking] = useState<RankedReferralUser[]>([])
  const [balanceRanking, setBalanceRanking] = useState<RankedBalanceUser[]>([])

  const token = useMemo(
    () => localStorage.getItem('token') ?? sessionStorage.getItem('token') ?? '',
    []
  )

  useEffect(() => {
    const loadRankings = async () => {
      setLoading(true)
      setError('')

      try {
        const res = await fetch(`${API_URL}/api/admin/rankings`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        })

        const data = (await res.json()) as RankingsApiResponse

        if (!res.ok || !data?.ok) {
          setError(data?.error ?? 'Não foi possível carregar os rankings.')
          setReferralRanking([])
          setBalanceRanking([])
          return
        }

        setReferralRanking(Array.isArray(data.rankings?.referrals) ? data.rankings!.referrals! : [])
        setBalanceRanking(Array.isArray(data.rankings?.balances) ? data.rankings!.balances! : [])
      } catch {
        setError('Erro de conexão ao carregar rankings.')
        setReferralRanking([])
        setBalanceRanking([])
      } finally {
        setLoading(false)
      }
    }

    loadRankings()
  }, [token])

  return (
    <main className="admin-page">
      <AdminSidebar />
      <section className="admin-content admin-users-page">
        <header className="admin-header">
          <div>
            <h1>Ranking de Usuários</h1>
            <p className="admin-subtitle">Top convites por níveis e top 5 maiores saldos</p>
          </div>
        </header>

        {loading ? <p className="admin-kpi-error">Carregando rankings...</p> : null}
        {error ? <p className="admin-kpi-error">{error}</p> : null}

        <section className="admin-panel admin-panel-wide">
          <div className="admin-panel-head">
            <h2>Ranking de Convites (Níveis 1, 2 e 3)</h2>
            <span>Top 5 usuários</span>
          </div>

          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Usuário</th>
                  <th>Telefone</th>
                  <th>Nível 1</th>
                  <th>Nível 2</th>
                  <th>Nível 3</th>
                  <th>Total</th>
                </tr>
              </thead>
              <tbody>
                {referralRanking.length ? (
                  referralRanking.map((row, index) => (
                    <tr key={row.id}>
                      <td>{index + 1}</td>
                      <td>{row.name}</td>
                      <td>{row.phone}</td>
                      <td>{row.level1Count}</td>
                      <td>{row.level2Count}</td>
                      <td>{row.level3Count}</td>
                      <td>{row.totalReferrals}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={7}>Sem dados de convites para exibir.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="admin-panel admin-panel-wide" style={{ marginTop: 16 }}>
          <div className="admin-panel-head">
            <h2>Ranking de Maior Saldo</h2>
            <span>Top 5 usuários</span>
          </div>

          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Usuário</th>
                  <th>Telefone</th>
                  <th>Saldo</th>
                </tr>
              </thead>
              <tbody>
                {balanceRanking.length ? (
                  balanceRanking.map((row, index) => (
                    <tr key={row.id}>
                      <td>{index + 1}</td>
                      <td>{row.name}</td>
                      <td>{row.phone}</td>
                      <td>{formatBRL(row.balance)}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={4}>Sem dados de saldo para exibir.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </section>
    </main>
  )
}
