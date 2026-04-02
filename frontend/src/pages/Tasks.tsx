import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import AppSidebar from '../components/AppSidebar'
import './Tasks.css'

type ApiTask = {
  id: number
  name: string
  description: string
  rewardAmount: number
  completedToday: number
  earnedToday: number
  remainingToday: number
  imageUrl?: string
}

type VipInfo = {
  vipName: string
  vipDailyTaskLimit: number
  vipMultiplier: number
}

type StoredUser = {
  id: number
  name: string
  phone: string
}

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3333'

const formatBRL = (value: number) =>
  value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

export default function Tasks() {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [tasks, setTasks] = useState<ApiTask[]>([])
  const [vip, setVip] = useState<VipInfo | null>(null)
  const [remainingByVip, setRemainingByVip] = useState(0)

  const user = useMemo(() => {
    const raw = localStorage.getItem('user') ?? sessionStorage.getItem('user')
    if (!raw) return null
    try {
      return JSON.parse(raw) as StoredUser
    } catch {
      return null
    }
  }, [])

  const loadTasks = async () => {
    if (!user?.id) {
      setError('Usuário não autenticado.')
      setLoading(false)
      return
    }

    setLoading(true)
    setError('')

    try {
      const response = await fetch(`${API_URL}/api/mining/tasks/${user.id}`)
      const data = await response.json()

      if (!response.ok || !data?.ok) {
        if (response.status === 403 || data?.code === 'VIP_REQUIRED') {
          setError('Você não possui VIP ativo. Ative um VIP para acessar as tarefas.')
        } else {
          setError(data?.error ?? 'Não foi possível carregar suas tarefas.')
        }
        setTasks([])
        setVip(null)
        setRemainingByVip(0)
        return
      }

      setTasks(Array.isArray(data.tasks) ? data.tasks : [])
      setVip(data.vip ?? null)
      setRemainingByVip(Number(data.remainingByVip ?? 0))
    } catch {
      setError('Erro de conexão ao carregar tarefas.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadTasks()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id])

  const totalEarned = useMemo(() => {
    return tasks.reduce((acc, t) => acc + Number(t.earnedToday ?? 0), 0)
  }, [tasks])

  return (
    <main className="tasks-page">
      <AppSidebar />
      <header className="tasks-header">
        <div>
          <p className="tasks-kicker">Central de tarefas</p>
          <h1>Tarefas</h1>
          <span className="tasks-subtitle">As tarefas disponíveis seguem seu nível VIP ativo</span>
        </div>
        <div className="tasks-header-actions">
          <button className="btn ghost" onClick={() => navigate('/dashboard')}>
            Voltar
          </button>
          <button className="btn ghost" onClick={() => loadTasks()}>
            Atualizar
          </button>
        </div>
      </header>

      {loading ? <div className="vip-inline-message">Carregando tarefas...</div> : null}

      {!loading && error ? (
        <section className="vip-required-box">
          <strong>Acesso bloqueado</strong>
          <p>{error}</p>
          <button className="btn ghost" onClick={() => navigate('/vip')}>
            Ativar VIP
          </button>
        </section>
      ) : null}

      {!loading && !error && vip ? (
        <>
          <section className="tasks-metrics">
            <article className="metric-card">
              <span>VIP ativo</span>
              <strong>{vip.vipName}</strong>
            </article>
            <article className="metric-card">
              <span>Limite diário VIP</span>
              <strong>{vip.vipDailyTaskLimit}</strong>
            </article>
            <article className="metric-card">
              <span>Restantes hoje</span>
              <strong>{remainingByVip}</strong>
            </article>
            <article className="metric-card">
              <span>Ganhos hoje</span>
              <strong>{formatBRL(totalEarned)}</strong>
            </article>
          </section>

          <section className="tasks-grid">
            {tasks.map((task) => {
              const jaConcluidaHoje = Number(task.completedToday ?? 0) > 0
              const bloquearInicio = remainingByVip <= 0 || jaConcluidaHoje

              return (
              <article key={task.id} className={`task-item ${jaConcluidaHoje ? 'status-done' : 'status-pending'}`}>
                <img
                  src={
                    task.imageUrl ||
                    `https://picsum.photos/seed/task-${task.id}/720/360`
                  }
                  alt={task.name}
                  style={{
                    width: '100%',
                    height: 140,
                    objectFit: 'cover',
                    borderRadius: 10,
                    marginBottom: 10,
                  }}
                />
                <div className="task-head">
                  <h3>{task.name}</h3>
                </div>
                <p className="task-meta">{task.description}</p>
                <div className="task-footer">
                  <strong>{formatBRL(task.rewardAmount)}</strong>
                  <button
                    onClick={() => navigate(`/tasks/mining/${task.id}`)}
                    disabled={bloquearInicio}
                    title={
                      jaConcluidaHoje
                        ? 'Tarefa já concluída hoje. Disponível novamente às 00:00 (São Paulo).'
                        : remainingByVip <= 0
                          ? 'Limite diário do VIP atingido.'
                          : 'Iniciar tarefa'
                    }
                  >
                    {jaConcluidaHoje ? 'Concluída hoje' : 'Iniciar tarefa'}
                  </button>
                </div>
              </article>
              )
            })}
          </section>
        </>
      ) : null}
    </main>
  )
}
