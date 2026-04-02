import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import AppSidebar from '../components/AppSidebar'
import './Tasks.css'

type StoredUser = {
  id: number
  name: string
  phone: string
}

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:3333'
const REQUIRED_SECONDS = 30

const formatBRL = (value: number) =>
  value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

const VIDEO_LIST = [
  'https://www.youtube.com/embed/dQw4w9WgXcQ?enablejsapi=1',
  'https://www.youtube.com/embed/aqz-KE-bpKQ?enablejsapi=1',
  'https://www.youtube.com/embed/ysz5S6PUM-U?enablejsapi=1',
  'https://www.youtube.com/embed/jNQXAC9IVRw?enablejsapi=1',
  'https://www.youtube.com/embed/3JZ_D3ELwOQ?enablejsapi=1',
  'https://www.youtube.com/embed/LXb3EKWsInQ?enablejsapi=1',
  'https://www.youtube.com/embed/e-ORhEE9VVg?enablejsapi=1',
  'https://www.youtube.com/embed/kXYiU_JCYtU?enablejsapi=1',
  'https://www.youtube.com/embed/fJ9rUzIMcZQ?enablejsapi=1',
  'https://www.youtube.com/embed/hT_nvWreIhg?enablejsapi=1',
  'https://www.youtube.com/embed/09R8_2nJtjg?enablejsapi=1',
  'https://www.youtube.com/embed/CevxZvSJLk8?enablejsapi=1',
  'https://www.youtube.com/embed/pRpeEdMmmQ0?enablejsapi=1',
  'https://www.youtube.com/embed/YVkUvmDQ3HY?enablejsapi=1',
  'https://www.youtube.com/embed/SlPhMPnQ58k?enablejsapi=1',
  'https://www.youtube.com/embed/JGwWNGJdvx8?enablejsapi=1',
  'https://www.youtube.com/embed/2Vv-BfVoq4g?enablejsapi=1',
  'https://www.youtube.com/embed/OPf0YbXqDm0?enablejsapi=1',
  'https://www.youtube.com/embed/RgKAFK5djSk?enablejsapi=1',
  'https://www.youtube.com/embed/7wtfhZwyrcc?enablejsapi=1',
  'https://www.youtube.com/embed/60ItHLz5WEA?enablejsapi=1',
  'https://www.youtube.com/embed/kJQP7kiw5Fk?enablejsapi=1',
  'https://www.youtube.com/embed/3AtDnEC4zak?enablejsapi=1',
  'https://www.youtube.com/embed/9bZkp7q19f0?enablejsapi=1',
  'https://www.youtube.com/embed/rYEDA3JcQqw?enablejsapi=1',
  'https://www.youtube.com/embed/uelHwf8o7_U?enablejsapi=1',
  'https://www.youtube.com/embed/iS1g8G_njx8?enablejsapi=1',
  'https://www.youtube.com/embed/tVj0ZTS4WF4?enablejsapi=1',
  'https://www.youtube.com/embed/oRdxUFDoQe0?enablejsapi=1',
  'https://www.youtube.com/embed/Pkh8UtuejGw?enablejsapi=1',
]

const formatTime = (totalSeconds: number) => {
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export default function MiningTask() {
  const navigate = useNavigate()
  const { taskId } = useParams()

  const [loading, setLoading] = useState(false)
  const [checkingStatus, setCheckingStatus] = useState(true)
  const [alreadyCompletedToday, setAlreadyCompletedToday] = useState(false)
  const [message, setMessage] = useState('')
  const [reward, setReward] = useState<number | null>(null)
  const [toastMessage, setToastMessage] = useState('')
  const [rating, setRating] = useState<number>(0)
  const [ratingSent, setRatingSent] = useState(false)

  const [watchedSeconds, setWatchedSeconds] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [videoStarted, setVideoStarted] = useState(false)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)

  const selectedVideoUrl = useMemo(() => {
    if (!taskId) return VIDEO_LIST[Math.floor(Math.random() * VIDEO_LIST.length)]
    const taskSeed = Math.abs(Number(taskId))
    const randomOffset = Math.floor(Math.random() * VIDEO_LIST.length)
    const idx = (taskSeed + randomOffset) % VIDEO_LIST.length
    return VIDEO_LIST[idx]
  }, [taskId])

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
    if (!user?.id) {
      setMessage('Usuário não autenticado.')
      setCheckingStatus(false)
      return
    }

    const checkTaskStatus = async () => {
      if (!taskId) {
        setCheckingStatus(false)
        return
      }

      try {
        const response = await fetch(`${API_URL}/api/mining/tasks/${user.id}`)
        const data = await response.json()

        if (!response.ok || !data?.ok) {
          setCheckingStatus(false)
          return
        }

        const currentTask = Array.isArray(data.tasks)
          ? data.tasks.find((t: { id: number; completedToday: number }) => Number(t.id) === Number(taskId))
          : null

        const done = Number(currentTask?.completedToday ?? 0) > 0
        setAlreadyCompletedToday(done)

        if (done) {
          setIsPlaying(false)
          setWatchedSeconds(REQUIRED_SECONDS)
          setMessage('Você já concluiu esta tarefa hoje. Disponível novamente às 00:00.')
        }
      } catch {
        // noop
      } finally {
        setCheckingStatus(false)
      }
    }

    checkTaskStatus()
  }, [user?.id, taskId])

  useEffect(() => {
    if (alreadyCompletedToday) return
    if (!isPlaying) return
    if (watchedSeconds >= REQUIRED_SECONDS) {
      setIsPlaying(false)
      return
    }

    const interval = window.setInterval(() => {
      setWatchedSeconds((prev) => Math.min(REQUIRED_SECONDS, prev + 1))
    }, 1000)

    return () => window.clearInterval(interval)
  }, [isPlaying, watchedSeconds])

  const percent = Math.min(100, (watchedSeconds / REQUIRED_SECONDS) * 100)
  const remainingSeconds = Math.max(0, REQUIRED_SECONDS - watchedSeconds)
  const podeConcluir = watchedSeconds >= REQUIRED_SECONDS

  const concluirTarefaVideo = async () => {
    if (alreadyCompletedToday) {
      setMessage('Você já concluiu esta tarefa hoje. Disponível novamente às 00:00.')
      return
    }

    if (!podeConcluir) {
      setMessage('Assista ao vídeo por 00:30 para concluir a tarefa.')
      return
    }

    if (!ratingSent || rating < 1) {
      setMessage('Avalie a tarefa antes de receber a comissão.')
      return
    }

    if (!user?.id || !taskId) {
      setMessage('Dados inválidos para concluir a tarefa.')
      return
    }

    setLoading(true)
    setMessage('')

    try {
      const response = await fetch(`${API_URL}/api/mining/tasks/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: user.id, taskId: Number(taskId) }),
      })

      const data = await response.json()

      if (!response.ok || !data?.ok) {
        setMessage(data?.error ?? 'Falha ao concluir tarefa de vídeo.')
        return
      }

      setReward(Number(data.rewardAmount ?? 0))
      setMessage(data?.message ?? 'Tarefa concluída com sucesso.')
    } catch {
      setMessage('Erro de conexão ao concluir tarefa.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (reward === null) return
    setToastMessage(`Comissão recebida: ${formatBRL(reward)}`)
    const timeout = window.setTimeout(() => {
      setToastMessage('')
    }, 3200)

    return () => window.clearTimeout(timeout)
  }, [reward])

  return (
    <main className="tasks-page">
      <AppSidebar />
      <header className="tasks-header">
        <div>
          <p className="tasks-kicker">Tarefa</p>
          <h1>Tarefa #{taskId}</h1>
          <span className="tasks-subtitle">Assista ao vídeo por 30 segundos e avalie para receber a comissão</span>
        </div>
        <div className="tasks-header-actions">
          <button className="btn ghost" onClick={() => navigate('/tasks')}>
            Voltar
          </button>
        </div>
      </header>

      <section className="progress-card">
        <div className="progress-top">
          <span>Vídeo da tarefa</span>
          <strong>{isPlaying ? 'Assistindo...' : 'Pausado'}</strong>
        </div>

        <div
          style={{ borderRadius: 12, overflow: 'hidden', marginBottom: 12, cursor: 'pointer' }}
          onClick={() => {
            if (podeConcluir) return
            if (!videoStarted) {
              setVideoStarted(true)
            }
            if (!isPlaying) {
              setIsPlaying(true)
            }
          }}
        >
          <iframe
            ref={iframeRef}
            title="Vídeo da tarefa"
            width="100%"
            height="260"
            src={selectedVideoUrl}
            allow="autoplay; encrypted-media; picture-in-picture"
            allowFullScreen
            style={{ border: 0, display: 'block' }}
          />
        </div>

        <div className="progress-top" style={{ marginBottom: 6 }}>
          <span>Tempo assistido</span>
          <strong>{formatTime(watchedSeconds)} / 00:30</strong>
        </div>
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${percent}%` }} />
        </div>

        <div className="task-footer" style={{ marginTop: 12 }}>
          <button
            className="btn ghost"
            onClick={() => {
              if (podeConcluir) return
              const next = !isPlaying
              if (next && !videoStarted) {
                setVideoStarted(true)
              }
              setIsPlaying(next)

              const iframeWin = iframeRef.current?.contentWindow
              if (iframeWin) {
                iframeWin.postMessage(
                  JSON.stringify({
                    event: 'command',
                    func: next ? 'playVideo' : 'pauseVideo',
                    args: [],
                  }),
                  '*',
                )
              }
            }}
            disabled={podeConcluir || alreadyCompletedToday || checkingStatus}
          >
            {alreadyCompletedToday
              ? 'Tarefa já concluída hoje'
              : podeConcluir
                ? 'Tempo concluído'
                : isPlaying
                  ? 'Pausar vídeo'
                  : 'Start vídeo'}
          </button>
          <strong>Faltam {formatTime(remainingSeconds)}</strong>
        </div>
      </section>

      <section className="progress-card">
        <div className="progress-top">
          <span>Avaliação da tarefa</span>
          <strong>
            {alreadyCompletedToday
              ? 'Tarefa já concluída hoje'
              : ratingSent
                ? `Avaliação enviada (${rating}/5)`
                : 'Avalie para liberar a comissão'}
          </strong>
        </div>

        <div className="task-footer" style={{ marginTop: 12, gap: 8 }}>
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              className="btn ghost"
              disabled={alreadyCompletedToday || ratingSent || !podeConcluir}
              onClick={() => setRating(n)}
              style={{
                minWidth: 42,
                opacity: rating === n ? 1 : 0.75,
                border: rating === n ? '2px solid #2563eb' : undefined,
              }}
            >
              {n}★
            </button>
          ))}
        </div>

        <div className="task-footer" style={{ marginTop: 12 }}>
          <button
            className="btn ghost"
            disabled={alreadyCompletedToday || ratingSent || !podeConcluir || rating < 1}
            onClick={() => {
              if (!podeConcluir) {
                setMessage('Assista ao vídeo por 00:30 antes de avaliar.')
                return
              }
              if (rating < 1) {
                setMessage('Selecione uma nota de 1 a 5.')
                return
              }
              setRatingSent(true)
              setMessage(`Avaliação ${rating}/5 enviada. Processando comissão...`)
              void concluirTarefaVideo()
            }}
          >
            {ratingSent ? 'Avaliação enviada' : 'Enviar avaliação'}
          </button>
        </div>

        <div className="progress-top" style={{ marginTop: 14 }}>
          <span>Status da tarefa</span>
          <strong>
            {alreadyCompletedToday
              ? 'Tarefa já concluída hoje'
              : !podeConcluir
                ? 'Assistindo vídeo...'
                : !ratingSent
                  ? 'Aguardando avaliação'
                  : loading
                    ? 'Creditando comissão...'
                    : 'Comissão processada automaticamente após avaliação'}
          </strong>
        </div>
      </section>

      {message ? <div className="vip-inline-message">{message}</div> : null}
      {toastMessage ? <div className="floating-toast">{toastMessage}</div> : null}
    </main>
  )
}
