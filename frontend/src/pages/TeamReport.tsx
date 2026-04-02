import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import AppSidebar from '../components/AppSidebar'
import './TeamReport.css'
import './Tasks.css'

type StoredUser = {
  id: number
  name: string
  phone: string
}

type TeamReportResponse = {
  ok?: boolean
  summary?: {
    teamSize?: number
    depositedMembers?: number
    teamRecharge?: number
    teamWithdraw?: number
  }
  levels?: Array<{
    level?: number
    totalMembers?: number
    depositedMembers?: number
    rechargedAmount?: number
  }>
}

type TeamMember = {
  id: number
  name: string
  phone: string
  level: number
  createdAt?: string
  totalDeposits: number
  hasDeposit: boolean
}

type TeamMembersResponse = {
  ok?: boolean
  level?: number
  total?: number
  members?: TeamMember[]
}

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3333'

const formatBRL = (value: number) =>
  Number(value ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

export default function TeamReport() {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(true)
  const [fetching, setFetching] = useState(false)
  const [error, setError] = useState('')
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null)
  const [activeTab, setActiveTab] = useState<'reports' | 'team'>('reports')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [teamLevel, setTeamLevel] = useState<1 | 2 | 3>(1)
  const [teamSize, setTeamSize] = useState(0)
  const [depositedMembers, setDepositedMembers] = useState(0)
  const [teamRecharge, setTeamRecharge] = useState(0)
  const [teamWithdraw, setTeamWithdraw] = useState(0)
  const [levels, setLevels] = useState<Array<{ level: number; totalMembers: number; depositedMembers: number; rechargedAmount: number }>>([
    { level: 1, totalMembers: 0, depositedMembers: 0, rechargedAmount: 0 },
    { level: 2, totalMembers: 0, depositedMembers: 0, rechargedAmount: 0 },
    { level: 3, totalMembers: 0, depositedMembers: 0, rechargedAmount: 0 },
  ])
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([])

  const user = useMemo(() => {
    const raw = localStorage.getItem('user') ?? sessionStorage.getItem('user')
    if (!raw) return null
    try {
      return JSON.parse(raw) as StoredUser
    } catch {
      return null
    }
  }, [])

  const loadReport = async (params?: { startDate?: string; endDate?: string }) => {
    if (!user?.id) return
    setFetching(true)
    setError('')
    try {
      const query = new URLSearchParams()
      if (params?.startDate && params?.endDate) {
        query.set('startDate', params.startDate)
        query.set('endDate', params.endDate)
      }
      const qs = query.toString()
      const res = await fetch(`${API_URL}/api/team/report/${user.id}${qs ? `?${qs}` : ''}`)
      const data = (await res.json()) as TeamReportResponse & { error?: string }

      if (!res.ok || !data?.ok) {
        const msg = data?.error || 'Não foi possível carregar relatório.'
        setError(msg)
        setToast({ type: 'error', message: msg })
        setTimeout(() => setToast(null), 2200)
        return
      }

      setTeamSize(Number(data.summary?.teamSize ?? 0))
      setDepositedMembers(Number(data.summary?.depositedMembers ?? 0))
      setTeamRecharge(Number(data.summary?.teamRecharge ?? 0))
      setTeamWithdraw(Number(data.summary?.teamWithdraw ?? 0))

      const mapped = [1, 2, 3].map((lv) => {
        const found = data.levels?.find((r) => Number(r.level ?? 0) === lv)
        return {
          level: lv,
          totalMembers: Number(found?.totalMembers ?? 0),
          depositedMembers: Number(found?.depositedMembers ?? 0),
          rechargedAmount: Number(found?.rechargedAmount ?? 0),
        }
      })
      setLevels(mapped)
      if (!loading) {
        setToast({ type: 'success', message: 'Relatório atualizado com sucesso.' })
        setTimeout(() => setToast(null), 1800)
      }
    } catch {
      const msg = 'Erro de conexão ao carregar relatório.'
      setError(msg)
      setToast({ type: 'error', message: msg })
      setTimeout(() => setToast(null), 2200)
    } finally {
      setFetching(false)
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!user?.id) {
      navigate('/')
      return
    }
    loadReport()
  }, [navigate, user?.id])

  const loadTeamMembers = async (params?: { startDate?: string; endDate?: string; level?: 1 | 2 | 3 }) => {
    if (!user?.id) return
    setFetching(true)
    try {
      const query = new URLSearchParams()
      const lv = params?.level ?? teamLevel
      query.set('level', String(lv))
      if (params?.startDate && params?.endDate) {
        query.set('startDate', params.startDate)
        query.set('endDate', params.endDate)
      }
      const res = await fetch(`${API_URL}/api/team/members/${user.id}?${query.toString()}`)
      const data = (await res.json()) as TeamMembersResponse & { error?: string }
      if (!res.ok || !data?.ok) {
        const msg = data?.error || 'Não foi possível carregar membros da equipe.'
        setToast({ type: 'error', message: msg })
        setTimeout(() => setToast(null), 2200)
        return
      }
      setTeamMembers(Array.isArray(data.members) ? data.members : [])
      setToast({ type: 'success', message: 'Minha equipe atualizada com sucesso.' })
      setTimeout(() => setToast(null), 1800)
    } catch {
      const msg = 'Erro de conexão ao carregar membros da equipe.'
      setToast({ type: 'error', message: msg })
      setTimeout(() => setToast(null), 2200)
    } finally {
      setFetching(false)
      setLoading(false)
    }
  }

  const onSearch = () => {
    if ((startDate && !endDate) || (!startDate && endDate)) {
      const msg = 'Selecione data inicial e final.'
      setError(msg)
      setToast({ type: 'error', message: msg })
      setTimeout(() => setToast(null), 2200)
      return
    }
    if (startDate && endDate && startDate > endDate) {
      const msg = 'Data inicial não pode ser maior que a final.'
      setError(msg)
      setToast({ type: 'error', message: msg })
      setTimeout(() => setToast(null), 2200)
      return
    }
    if (activeTab === 'reports') {
      loadReport({ startDate, endDate })
    } else {
      loadTeamMembers({ startDate, endDate, level: teamLevel })
    }
  }

  return (
    <main className="tasks-page team-report-page">
      {toast ? (
        <div className={`team-toast ${toast.type}`} role="status" aria-live="polite">
          {toast.message}
        </div>
      ) : null}
      <AppSidebar />
      <header className="tasks-header">
        <div>
          <p className="tasks-kicker">Equipe</p>
          <h1>Relatório da Equipe</h1>
          <span className="tasks-subtitle">Cadastros e depósitos dos seus indicados</span>
        </div>
        <div className="tasks-header-actions">
          <button className="btn ghost" onClick={() => navigate('/profile')}>
            Voltar
          </button>
        </div>
      </header>

      <section className="team-tabs-card" role="tablist" aria-label="Relatórios da Equipe">
        <div className="team-tabs-row">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'reports'}
            id="teams-tab-reports"
            className={`team-tab-btn ${activeTab === 'reports' ? 'active' : ''}`}
            onClick={() => {
              setActiveTab('reports')
              loadReport()
            }}
          >
            Relatórios
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'team'}
            id="teams-tab-team"
            className={`team-tab-btn ${activeTab === 'team' ? 'active' : ''}`}
            onClick={() => {
              setActiveTab('team')
              loadTeamMembers({ level: teamLevel })
            }}
          >
            Minha Equipe
          </button>
        </div>
      </section>

      <section className="team-filter-card">
        <div className="team-filter-row">
          <label>
            <span>De</span>
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </label>
          <label>
            <span>Até</span>
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </label>
          <button type="button" onClick={onSearch} disabled={fetching}>
            {fetching ? 'Pesquisando...' : 'Pesquisar'}
          </button>
        </div>

        {activeTab === 'team' ? (
          <div className="team-level-switch">
            <button
              className={teamLevel === 1 ? 'active' : ''}
              onClick={() => {
                setTeamLevel(1)
                loadTeamMembers({ startDate, endDate, level: 1 })
              }}
              type="button"
            >
              Nível 1
            </button>
            <button
              className={teamLevel === 2 ? 'active' : ''}
              onClick={() => {
                setTeamLevel(2)
                loadTeamMembers({ startDate, endDate, level: 2 })
              }}
              type="button"
            >
              Nível 2
            </button>
            <button
              className={teamLevel === 3 ? 'active' : ''}
              onClick={() => {
                setTeamLevel(3)
                loadTeamMembers({ startDate, endDate, level: 3 })
              }}
              type="button"
            >
              Nível 3
            </button>
          </div>
        ) : null}
      </section>

      {loading ? (
        <div className="vip-inline-message">Carregando relatório...</div>
      ) : (
        <>
          {activeTab === 'reports' ? (
            <>
              <section className="team-kpis-grid">
                <article className="team-kpi-card">
                  <h3>Recarga da Equipe</h3>
                  <strong>{formatBRL(teamRecharge)}</strong>
                </article>
                <article className="team-kpi-card">
                  <h3>Saques da Equipe</h3>
                  <strong>{formatBRL(teamWithdraw)}</strong>
                </article>
                <article className="team-kpi-card">
                  <h3>Tamanho da Equipe</h3>
                  <strong>{teamSize}</strong>
                </article>
                <article className="team-kpi-card">
                  <h3>Membros que Depositaram</h3>
                  <strong>{depositedMembers}</strong>
                </article>
              </section>

              <section className="team-levels-card">
                <h2>Dados por Nível</h2>
                <div className="team-levels-grid">
                  {levels.map((lv) => (
                    <article key={lv.level} className="team-level-item">
                      <header>Nível {lv.level}</header>
                      <p><span>Cadastrados</span><strong>{lv.totalMembers}</strong></p>
                      <p><span>Depositaram</span><strong>{lv.depositedMembers}</strong></p>
                      <p><span>Valor Recarregado</span><strong>{formatBRL(lv.rechargedAmount)}</strong></p>
                    </article>
                  ))}
                </div>
              </section>
            </>
          ) : (
            <>
              <section className="team-kpi-card team-kpi-single">
                <h3>Minha Equipe - Nível {teamLevel}</h3>
                <strong>{teamMembers.length} membro(s)</strong>
              </section>

              <section className="team-members-list">
                {teamMembers.length === 0 ? (
                  <div className="team-empty">Nenhum membro da equipe</div>
                ) : (
                  teamMembers.map((member) => (
                    <article key={member.id} className="team-member-item">
                      <div>
                        <h4>{member.name}</h4>
                        <p>{member.phone}</p>
                        <small>{member.createdAt ? new Date(member.createdAt).toLocaleDateString('pt-BR') : '-'}</small>
                      </div>
                      <div className="team-member-right">
                        <strong>{formatBRL(member.totalDeposits)}</strong>
                        <span className={member.hasDeposit ? 'ok' : 'pending'}>
                          {member.hasDeposit ? 'Depositou' : 'Sem depósito'}
                        </span>
                      </div>
                    </article>
                  ))
                )}
              </section>
            </>
          )}
        </>
      )}
    </main>
  )
}
