import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import './Sinuca.css'

type BallType = 'solid' | 'stripe' | 'eight' | 'cue'

interface Ball {
  id: number
  x: number
  y: number
  vx: number
  vy: number
  r: number
  color: string
  type: BallType
  number: number
  pocketed: boolean
}

interface PocketedBallView {
  key: string
  number: number
  type: BallType
  color: string
}

const TABLE_W = 1280
const TABLE_H = 720
const CUSHION = 34
const BALL_R = 11
const FRICTION = 0.995
const MIN_V = 0.02
const RESTITUTION = 0.965
const BALL_BALL_RESTITUTION = 0.985
const TANGENTIAL_DAMPING = 0.985
const MAX_SPEED = 28
const SUB_STEPS = 2

const POCKETS = [
  { x: CUSHION, y: CUSHION, r: 24 },
  { x: TABLE_W / 2, y: CUSHION - 4, r: 22 },
  { x: TABLE_W - CUSHION, y: CUSHION, r: 24 },
  { x: CUSHION, y: TABLE_H - CUSHION, r: 24 },
  { x: TABLE_W / 2, y: TABLE_H - CUSHION + 4, r: 22 },
  { x: TABLE_W - CUSHION, y: TABLE_H - CUSHION, r: 24 },
]

const COLORS: Record<number, string> = {
  1: '#facc15',
  2: '#2563eb',
  3: '#dc2626',
  4: '#7c3aed',
  5: '#f97316',
  6: '#16a34a',
  7: '#a16207',
  8: '#111827',
  9: '#facc15',
  10: '#2563eb',
  11: '#dc2626',
  12: '#7c3aed',
  13: '#f97316',
  14: '#16a34a',
  15: '#a16207',
}

function createRack(): Ball[] {
  const balls: Ball[] = []
  const startX = TABLE_W * 0.7
  const startY = TABLE_H / 2
  const rowGap = BALL_R * 2 * 0.89
  const colGap = BALL_R * 2 * 1.02

  const nums = [1, 9, 2, 10, 8, 3, 11, 4, 12, 5, 13, 6, 14, 7, 15]
  let idx = 0

  for (let row = 0; row < 5; row++) {
    for (let col = 0; col <= row; col++) {
      const x = startX + row * colGap
      const y = startY - (row * rowGap) / 2 + col * rowGap
      const n = nums[idx++]
      balls.push({
        id: n,
        number: n,
        x,
        y,
        vx: 0,
        vy: 0,
        r: BALL_R,
        color: COLORS[n],
        type: n === 8 ? 'eight' : n <= 7 ? 'solid' : 'stripe',
        pocketed: false,
      })
    }
  }

  balls.unshift({
    id: 0,
    number: 0,
    x: TABLE_W * 0.22,
    y: TABLE_H / 2,
    vx: 0,
    vy: 0,
    r: BALL_R,
    color: '#ffffff',
    type: 'cue',
    pocketed: false,
  })

  return balls
}

export default function Sinuca() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [balls, setBalls] = useState<Ball[]>(() => createRack())
  const ballsRef = useRef<Ball[]>(balls)
  const [isAiming, setIsAiming] = useState(false)
  const [isMoving, setIsMoving] = useState(false)
  const [power, setPower] = useState(0)
  const [status, setStatus] = useState('Posicione a mira e puxe para tacar.')
  const [mouse, setMouse] = useState({ x: 0, y: 0 })
  const [gameOver, setGameOver] = useState(false)
  const [pocketedView, setPocketedView] = useState<PocketedBallView[]>([])
  const pocketedIdsRef = useRef<Set<number>>(new Set())

  useEffect(() => {
    ballsRef.current = balls
  }, [balls])

  const cueBall = useMemo(() => balls.find((b) => b.type === 'cue')!, [balls])

  useEffect(() => {
    let raf = 0

    const loop = () => {
      const updated = ballsRef.current.map((b) => ({ ...b }))
      let anyMoving = false

      for (let step = 0; step < SUB_STEPS; step++) {
        for (const ball of updated) {
          if (ball.pocketed) continue

          ball.x += ball.vx / SUB_STEPS
          ball.y += ball.vy / SUB_STEPS
          ball.vx *= FRICTION
          ball.vy *= FRICTION

          const speed = Math.hypot(ball.vx, ball.vy)
          if (speed > MAX_SPEED) {
            const s = MAX_SPEED / speed
            ball.vx *= s
            ball.vy *= s
          }

          if (Math.abs(ball.vx) < MIN_V) ball.vx = 0
          if (Math.abs(ball.vy) < MIN_V) ball.vy = 0
          if (ball.vx !== 0 || ball.vy !== 0) anyMoving = true

          const left = CUSHION + ball.r
          const right = TABLE_W - CUSHION - ball.r
          const top = CUSHION + ball.r
          const bottom = TABLE_H - CUSHION - ball.r

          if (ball.x < left) {
            ball.x = left
            ball.vx *= -RESTITUTION
            ball.vy *= TANGENTIAL_DAMPING
          } else if (ball.x > right) {
            ball.x = right
            ball.vx *= -RESTITUTION
            ball.vy *= TANGENTIAL_DAMPING
          }

          if (ball.y < top) {
            ball.y = top
            ball.vy *= -RESTITUTION
            ball.vx *= TANGENTIAL_DAMPING
          } else if (ball.y > bottom) {
            ball.y = bottom
            ball.vy *= -RESTITUTION
            ball.vx *= TANGENTIAL_DAMPING
          }

          for (const p of POCKETS) {
            const dx = ball.x - p.x
            const dy = ball.y - p.y
            const d = Math.hypot(dx, dy)
            if (d < p.r) {
              ball.pocketed = true
              ball.vx = 0
              ball.vy = 0
            }
          }
        }

        for (let i = 0; i < updated.length; i++) {
          const a = updated[i]
          if (a.pocketed) continue
          for (let j = i + 1; j < updated.length; j++) {
            const b = updated[j]
            if (b.pocketed) continue
            const dx = b.x - a.x
            const dy = b.y - a.y
            const dist = Math.hypot(dx, dy)
            const minDist = a.r + b.r
            if (dist > 0 && dist < minDist) {
              const nx = dx / dist
              const ny = dy / dist
              const overlap = minDist - dist

              a.x -= nx * (overlap / 2)
              a.y -= ny * (overlap / 2)
              b.x += nx * (overlap / 2)
              b.y += ny * (overlap / 2)

              const rvx = b.vx - a.vx
              const rvy = b.vy - a.vy
              const relVelAlongNormal = rvx * nx + rvy * ny

              if (relVelAlongNormal < 0) {
                const jImpulse = (-(1 + BALL_BALL_RESTITUTION) * relVelAlongNormal) / 2
                const impX = jImpulse * nx
                const impY = jImpulse * ny

                a.vx -= impX
                a.vy -= impY
                b.vx += impX
                b.vy += impY

                const tx = -ny
                const ty = nx
                const relTangent = rvx * tx + rvy * ty
                const tangentImpulse = (relTangent * 0.5) * TANGENTIAL_DAMPING

                a.vx += tangentImpulse * tx
                a.vy += tangentImpulse * ty
                b.vx -= tangentImpulse * tx
                b.vy -= tangentImpulse * ty
              }
            }
          }
        }
      }

      const cue = updated.find((b) => b.type === 'cue')
      if (cue?.pocketed) {
        cue.pocketed = false
        cue.x = TABLE_W * 0.22
        cue.y = TABLE_H / 2
        cue.vx = 0
        cue.vy = 0
        setStatus('Falta! Bola branca caiu na caçapa e foi reposicionada.')
      }

      const eight = updated.find((b) => b.type === 'eight')
      if (eight?.pocketed && !gameOver) {
        setGameOver(true)
        setStatus('Fim de jogo: bola 8 encaçapada.')
      }

      if (!anyMoving && isMoving) {
        setIsMoving(false)
      } else if (anyMoving && !isMoving) {
        setIsMoving(true)
      }

      ballsRef.current = updated
      setBalls(updated)
      draw(updated)
      raf = requestAnimationFrame(loop)
    }

    const draw = (list: Ball[]) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return

      const dpr = window.devicePixelRatio || 1
      if (canvas.width !== TABLE_W * dpr || canvas.height !== TABLE_H * dpr) {
        canvas.width = TABLE_W * dpr
        canvas.height = TABLE_H * dpr
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, TABLE_W, TABLE_H)

      // Feltro realista com gradiente, textura e linhas de referência
      const felt = ctx.createRadialGradient(
        TABLE_W * 0.5,
        TABLE_H * 0.48,
        TABLE_W * 0.1,
        TABLE_W * 0.5,
        TABLE_H * 0.5,
        TABLE_W * 0.7
      )
      felt.addColorStop(0, '#1f9d62')
      felt.addColorStop(0.55, '#0f6b3f')
      felt.addColorStop(1, '#0a4d2f')
      ctx.fillStyle = felt
      ctx.fillRect(0, 0, TABLE_W, TABLE_H)

      // Vinheta para profundidade
      const vignette = ctx.createRadialGradient(
        TABLE_W * 0.5,
        TABLE_H * 0.5,
        TABLE_W * 0.22,
        TABLE_W * 0.5,
        TABLE_H * 0.5,
        TABLE_W * 0.72
      )
      vignette.addColorStop(0, 'rgba(0,0,0,0)')
      vignette.addColorStop(1, 'rgba(0,0,0,0.35)')
      ctx.fillStyle = vignette
      ctx.fillRect(0, 0, TABLE_W, TABLE_H)

      // Textura sutil no pano (ruído leve)
      for (let i = 0; i < 900; i++) {
        const x = (i * 97.13) % TABLE_W
        const y = (i * 53.77) % TABLE_H
        ctx.fillStyle = i % 2 === 0 ? 'rgba(255,255,255,0.015)' : 'rgba(0,0,0,0.02)'
        ctx.fillRect(x, y, 2, 2)
      }

      // Linhas de referência da mesa (diamonds / mira lateral)
      ctx.strokeStyle = 'rgba(255,255,255,0.18)'
      ctx.lineWidth = 1.2
      for (let i = 1; i <= 7; i++) {
        const x = (TABLE_W / 8) * i
        ctx.beginPath()
        ctx.moveTo(x, CUSHION + 6)
        ctx.lineTo(x, CUSHION + 16)
        ctx.stroke()

        ctx.beginPath()
        ctx.moveTo(x, TABLE_H - CUSHION - 6)
        ctx.lineTo(x, TABLE_H - CUSHION - 16)
        ctx.stroke()
      }

      // Madeira realista (bordas)
      const wood = ctx.createLinearGradient(0, 0, 0, TABLE_H)
      wood.addColorStop(0, '#7c4a27')
      wood.addColorStop(0.5, '#5a341b')
      wood.addColorStop(1, '#3d2312')
      ctx.fillStyle = wood
      ctx.fillRect(0, 0, TABLE_W, CUSHION)
      ctx.fillRect(0, TABLE_H - CUSHION, TABLE_W, CUSHION)
      ctx.fillRect(0, 0, CUSHION, TABLE_H)
      ctx.fillRect(TABLE_W - CUSHION, 0, CUSHION, TABLE_H)

      // Brilho no verniz da madeira
      ctx.strokeStyle = 'rgba(255,255,255,0.16)'
      ctx.lineWidth = 2
      ctx.strokeRect(4, 4, TABLE_W - 8, TABLE_H - 8)

      for (const p of POCKETS) {
        // sombra da caçapa
        ctx.beginPath()
        ctx.fillStyle = 'rgba(0,0,0,0.65)'
        ctx.arc(p.x + 1, p.y + 2, p.r + 2.5, 0, Math.PI * 2)
        ctx.fill()

        // interior
        const pocketGrad = ctx.createRadialGradient(p.x - 3, p.y - 3, 2, p.x, p.y, p.r + 2)
        pocketGrad.addColorStop(0, '#1f2937')
        pocketGrad.addColorStop(1, '#05070b')
        ctx.beginPath()
        ctx.fillStyle = pocketGrad
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2)
        ctx.fill()
      }

      for (const b of list) {
        if (b.pocketed) continue
        // Sombra da bola
        ctx.beginPath()
        ctx.fillStyle = 'rgba(0,0,0,0.25)'
        ctx.ellipse(b.x + 2.5, b.y + 3.5, b.r * 0.95, b.r * 0.72, 0.35, 0, Math.PI * 2)
        ctx.fill()

        // Corpo com shading radial
        const ballGrad = ctx.createRadialGradient(
          b.x - b.r * 0.35,
          b.y - b.r * 0.45,
          b.r * 0.15,
          b.x,
          b.y,
          b.r * 1.05
        )
        if (b.type === 'cue') {
          ballGrad.addColorStop(0, '#ffffff')
          ballGrad.addColorStop(0.55, '#f3f4f6')
          ballGrad.addColorStop(1, '#cbd5e1')
        } else {
          ballGrad.addColorStop(0, '#ffffff')
          ballGrad.addColorStop(0.15, b.color)
          ballGrad.addColorStop(1, '#101828')
        }

        ctx.beginPath()
        ctx.fillStyle = ballGrad
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2)
        ctx.fill()

        // Reflexo especular
        ctx.beginPath()
        ctx.fillStyle = 'rgba(255,255,255,0.6)'
        ctx.arc(b.x - b.r * 0.32, b.y - b.r * 0.34, b.r * 0.28, 0, Math.PI * 2)
        ctx.fill()

        if (b.type !== 'cue') {
          if (b.type === 'stripe') {
            ctx.save()
            ctx.beginPath()
            ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2)
            ctx.clip()
            ctx.fillStyle = '#ffffff'
            ctx.fillRect(b.x - b.r, b.y - 4.3, b.r * 2, 8.6)
            ctx.restore()
          }

          ctx.beginPath()
          ctx.fillStyle = '#f8fafc'
          ctx.arc(b.x, b.y, b.r * 0.46, 0, Math.PI * 2)
          ctx.fill()

          ctx.fillStyle = '#0b1020'
          ctx.font = 'bold 10px Inter, sans-serif'
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(String(b.number), b.x, b.y + 0.3)
        }
      }

      if (!isMoving && !gameOver) {
        const dx = cueBall.x - mouse.x
        const dy = cueBall.y - mouse.y
        const len = Math.hypot(dx, dy) || 1
        const nx = dx / len
        const ny = dy / len

        const stickLen = 150 + power * 0.6
        const backOffset = 22 + power * 0.25
        const sx = cueBall.x + nx * backOffset
        const sy = cueBall.y + ny * backOffset
        const ex = sx + nx * stickLen
        const ey = sy + ny * stickLen

        const cueGrad = ctx.createLinearGradient(sx, sy, ex, ey)
        cueGrad.addColorStop(0, '#f8ecd1')
        cueGrad.addColorStop(0.35, '#d4a373')
        cueGrad.addColorStop(0.8, '#8b5e34')
        cueGrad.addColorStop(1, '#5c3a1e')

        ctx.beginPath()
        ctx.strokeStyle = cueGrad
        ctx.lineWidth = 7
        ctx.lineCap = 'round'
        ctx.moveTo(sx, sy)
        ctx.lineTo(ex, ey)
        ctx.stroke()

        ctx.beginPath()
        ctx.strokeStyle = 'rgba(60,35,15,0.6)'
        ctx.lineWidth = 2
        ctx.moveTo(ex - nx * 28, ey - ny * 28)
        ctx.lineTo(ex, ey)
        ctx.stroke()

        ctx.beginPath()
        ctx.strokeStyle = 'rgba(255,255,255,0.35)'
        ctx.lineWidth = 1.8
        ctx.setLineDash([10, 8])
        ctx.moveTo(cueBall.x, cueBall.y)
        ctx.lineTo(cueBall.x - nx * 220, cueBall.y - ny * 220)
        ctx.stroke()
        ctx.setLineDash([])
      }
    }

    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [cueBall.x, cueBall.y, gameOver, isAiming, isMoving, mouse.x, mouse.y, power])

  const getMousePos = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const scaleX = TABLE_W / rect.width
    const scaleY = TABLE_H / rect.height
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    }
  }

  const onMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (isMoving || gameOver) return
    setIsAiming(true)
    setStatus('Mire e solte para tacar.')
    const p = getMousePos(e)
    setMouse(p)
    setPower(0)
  }

  const onMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isAiming || isMoving || gameOver) return
    const p = getMousePos(e)
    setMouse(p)

    const dx = cueBall.x - p.x
    const dy = cueBall.y - p.y
    const dist = Math.hypot(dx, dy)
    setPower(Math.min(140, dist))
  }

  const onMouseUp = () => {
    if (!isAiming || isMoving || gameOver) return
    setIsAiming(false)

    const dx = cueBall.x - mouse.x
    const dy = cueBall.y - mouse.y
    const len = Math.hypot(dx, dy) || 1
    const nx = dx / len
    const ny = dy / len

    const force = Math.min(22, power * 0.16)
    const updated = ballsRef.current.map((b) => ({ ...b }))
    const cue = updated.find((b) => b.type === 'cue')
    if (!cue) return

    cue.vx = nx * force
    cue.vy = ny * force
    ballsRef.current = updated
    setBalls(updated)
    setStatus('Tacada executada. Aguarde as bolas pararem.')
  }

  const resetGame = () => {
    const fresh = createRack()
    ballsRef.current = fresh
    setBalls(fresh)
    setGameOver(false)
    setIsAiming(false)
    setIsMoving(false)
    setPower(0)
    setPocketedView([])
    pocketedIdsRef.current.clear()
    setStatus('Novo jogo iniciado. Mire e jogue!')
  }

  return (
    <main className="sinuca-page">
      <div className="sinuca-shell">
        <header className="sinuca-header">
          <div>
            <h1>8 Ball Pool - Modo Profissional</h1>
            <p>Física realista, mira de precisão e experiência premium local.</p>
          </div>
          <div className="sinuca-actions">
            <Link to="/dashboard" className="sinuca-link">
              Dashboard
            </Link>
            <button onClick={resetGame} className="sinuca-reset">
              Reiniciar partida
            </button>
          </div>
        </header>

        <section className="sinuca-board">
          <div className="sinuca-table-area">
            <canvas
              ref={canvasRef}
              width={TABLE_W}
              height={TABLE_H}
              onMouseDown={onMouseDown}
              onMouseMove={onMouseMove}
              onMouseUp={onMouseUp}
              onMouseLeave={() => setIsAiming(false)}
            />

            <div className="hud">
              <p><strong>Status:</strong> {status}</p>
              <p><strong>Potência:</strong> {Math.round((power / 140) * 100)}%</p>
              <p><strong>Movimento:</strong> {isMoving ? 'Bolas em jogo' : 'Mesa parada'}</p>
            </div>
          </div>

          <aside className="pocket-lane" aria-live="polite">
            <h3>Bolas encaçapadas</h3>
            <p className="pocket-sub">Visualize cada bola “descendo” na lateral.</p>

            <div className="pocket-track">
              {pocketedView.length === 0 ? (
                <span className="pocket-empty">Nenhuma bola encaçapada ainda.</span>
              ) : (
                pocketedView.map((b, i) => (
                  <span
                    key={b.key}
                    className={`pocket-ball ${b.type === 'stripe' ? 'stripe' : ''}`}
                    style={{ ['--ball-color' as string]: b.color, animationDelay: `${Math.min(i * 0.04, 0.4)}s` }}
                    title={`Bola ${b.number}`}
                  >
                    {b.number}
                  </span>
                ))
              )}
            </div>
          </aside>
        </section>
      </div>
    </main>
  )
}
