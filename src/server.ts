import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import pool from './db'
import type { NextFunction, Request, Response } from 'express'
import type { RowDataPacket } from 'mysql2'

dotenv.config()

const app  = express()
const PORT = process.env.PORT     ?? 3333
const JWT_SECRET   = process.env.JWT_SECRET   ?? 'fallback_secret'
const JWT_EXPIRES  = process.env.JWT_EXPIRES_IN ?? '7d'
const LUMO_API_KEY = 'pk_69aa7a3d1a07dffe750eb533c92fabbe87974479ed791fb7ead328a56e67143d'
const LUMO_WEBHOOK_SECRET = 'sk_8910b90244b35ab56342bc3c019e569bb59abb9a90a7f69ad1dd59ce59ebd1065dc6240536d0a7b2e69496f8bac1dcdb739d22767183e2421b590f1fbfb77e39'
const LUMOPAY_TRANSFER_URL = 'https://api.lumopayment.com/api/payments/transfers/pix'
const SAO_PAULO_TZ = 'America/Sao_Paulo'

const getSaoPauloDateString = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: SAO_PAULO_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())

const normalizePixType = (pixTypeRaw: string) => {
  const type = String(pixTypeRaw ?? '').trim().toUpperCase()
  const allowed = ['CPF', 'CNPJ', 'EMAIL', 'TELEFONE', 'CHAVE_ALEATORIA'] as const
  if ((allowed as readonly string[]).includes(type)) return type
  return 'CHAVE_ALEATORIA'
}

const mapPixTypeToLumopay = (pixTypeRaw: string) => {
  const raw = String(pixTypeRaw ?? '').trim().toUpperCase()
  const mapped: Record<string, string> = {
    TELEFONE: 'PHONE',
    PHONE: 'PHONE',
    CPF: 'CPF',
    CNPJ: 'CNPJ',
    EMAIL: 'EMAIL',
    CHAVE_ALEATORIA: 'EVP',
    EVP: 'EVP',
    RANDOM: 'EVP',
    CRIPTO: 'EVP',
  }
  return mapped[raw] ?? 'EVP'
}

const normalizeLumopayPixKey = (pixKeyRaw: string, lumopayPixType: string) => {
  const key = String(pixKeyRaw ?? '').trim()
  switch (lumopayPixType) {
    case 'CPF':
    case 'CNPJ':
      return key.replace(/\D/g, '')
    case 'PHONE': {
      let numbers = key.replace(/\D/g, '')
      if (numbers.startsWith('55') && numbers.length > 11) numbers = numbers.slice(2)
      if (numbers.length === 10) {
        const ddd = numbers.slice(0, 2)
        const phone = numbers.slice(2)
        numbers = `${ddd}9${phone}`
      }
      return numbers
    }
    case 'EMAIL':
      return key.toLowerCase()
    case 'EVP':
    default:
      return key
  }
}

const normalizePixKey = (pixKeyRaw: string, pixType: string) => {
  const key = String(pixKeyRaw ?? '').trim()

  switch (pixType) {
    case 'CPF':
    case 'CNPJ':
      return key.replace(/\D/g, '')
    case 'EMAIL':
      return key.toLowerCase()
    case 'TELEFONE': {
      const numbers = key.replace(/\D/g, '')
      if (numbers.startsWith('55') && numbers.length > 11) return numbers.slice(2)
      return numbers
    }
    case 'CHAVE_ALEATORIA':
    default:
      return key
  }
}

type JwtPayload = {
  id: number
  phone?: string
  iat?: number
  exp?: number
}

type AuthenticatedRequest = Request & {
  authUser?: {
    id: number
    phone?: string
    isAdmin: boolean
  }
}

const resolveAuthUser = async (req: Request) => {
  const authHeader = String(req.headers.authorization ?? '')
  if (!authHeader.startsWith('Bearer ')) return null

  const token = authHeader.slice(7).trim()
  if (!token) return null

  try {
    await pool.query(
      `
      ALTER TABLE users
      ADD COLUMN is_admin TINYINT(1) NOT NULL DEFAULT 0
      `
    )
  } catch {
    // coluna já existe
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload
    const userId = Number(decoded?.id)
    if (!userId || Number.isNaN(userId)) return null

    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT id, phone, is_admin AS isAdmin FROM users WHERE id = ? LIMIT 1',
      [userId]
    )

    if (rows.length === 0) return null

    return {
      id: Number(rows[0].id),
      phone: String(rows[0].phone ?? decoded?.phone ?? ''),
      isAdmin: Number(rows[0].isAdmin ?? 0) >= 1,
    }
  } catch {
    return null
  }
}

const requireAuth = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const authUser = await resolveAuthUser(req)
  if (!authUser) {
    res.status(401).json({ ok: false, error: 'Não autorizado.' })
    return
  }
  req.authUser = authUser
  next()
}

const requireMaxAdmin = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const authUser = await resolveAuthUser(req)
  if (!authUser) {
    res.status(401).json({ ok: false, error: 'Não autorizado.' })
    return
  }

  if (!authUser.isAdmin) {
    res.status(403).json({ ok: false, error: 'Acesso restrito ao administrador máximo.' })
    return
  }

  req.authUser = authUser
  next()
}

const settleExpiredCyclesForUser = async (userId: number) => {
  if (!userId || Number.isNaN(userId)) return

  const conn = await pool.getConnection()
  try {
    await ensureGiftCodeTables()
    await conn.beginTransaction()

    const [expiredRows] = await conn.query<RowDataPacket[]>(
      `
      SELECT id, expected_profit AS expectedProfit
      FROM user_cycle_purchases
      WHERE user_id = ?
        AND status = 'active'
        AND ends_at IS NOT NULL
        AND ends_at <= NOW()
      FOR UPDATE
      `,
      [userId]
    )

    if (expiredRows.length === 0) {
      await conn.commit()
      return
    }

    let totalProfit = 0
    const purchaseIds: number[] = []

    for (const row of expiredRows) {
      const purchaseId = Number(row.id)
      const profit = Number(row.expectedProfit ?? 0)
      if (purchaseId > 0) purchaseIds.push(purchaseId)
      if (profit > 0) totalProfit += profit
    }

    if (totalProfit > 0) {
      await conn.query(
        `
        UPDATE users
        SET balance = COALESCE(balance, 0) + ?
        WHERE id = ?
        `,
        [Number(totalProfit.toFixed(2)), userId]
      )
    }

    if (purchaseIds.length > 0) {
      await conn.query(
        `
        UPDATE user_cycle_purchases
        SET status = 'completed', updated_at = NOW()
        WHERE user_id = ?
          AND status = 'active'
          AND ends_at IS NOT NULL
          AND ends_at <= NOW()
        `,
        [userId]
      )
    }

    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
}

app.use(cors())
app.use(express.json())

// ─── Health check ────────────────────────────────────────────────────────────
app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1')
    res.json({ ok: true, message: 'Backend + MySQL rodando 🚀' })
  } catch {
    res.status(500).json({ ok: false, message: 'Banco de dados indisponível' })
  }
})

// ─── Register ────────────────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
  const { name, phone, password, referralCode } = req.body as {
    name?: string
    phone?: string
    password?: string
    referralCode?: string
  }

  if (!name || !phone || !password) {
    res.status(400).json({ error: 'Nome, telefone e senha são obrigatórios.' })
    return
  }

  if (password.length < 6) {
    res.status(400).json({ error: 'A senha deve ter no mínimo 6 caracteres.' })
    return
  }

  try {
    // Verificar se telefone já existe
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM users WHERE phone = ?',
      [phone]
    )

    if (rows.length > 0) {
      res.status(409).json({ error: 'Telefone já cadastrado.' })
      return
    }

    // Hash da senha
    const hash = await bcrypt.hash(password, 10)

    const userReferralCode = `U${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 900 + 100)}`
    let referredByUserId: number | null = null

    if (referralCode) {
      const [refRows] = await pool.query<RowDataPacket[]>(
        'SELECT id FROM users WHERE referral_code = ? LIMIT 1',
        [referralCode]
      )
      if (refRows.length > 0) {
        referredByUserId = Number(refRows[0].id)
      }
    }

    // Inserir usuário com referral próprio
    const [result] = await pool.query(
      'INSERT INTO users (name, phone, password, referral_code, referred_by_user_id) VALUES (?, ?, ?, ?, ?)',
      [name, phone, hash, userReferralCode, referredByUserId]
    ) as any

    const userId = result.insertId

    // Gerar JWT
    const token = jwt.sign({ id: userId, phone }, JWT_SECRET, {
      expiresIn: JWT_EXPIRES as any,
    })

    res.status(201).json({
      message: `Conta criada com sucesso! Bem-vindo, ${name}.`,
      token,
      user: { id: userId, name, phone, is_admin: 0 },
    })
  } catch (err) {
    console.error('[register]', err)
    res.status(500).json({ error: 'Erro interno no servidor.' })
  }
})

// ─── Login ───────────────────────────────────────────────────────────────────
app.get('/api/user/summary/:id', async (req, res) => {
  const userId = Number(req.params.id)

  if (!userId || Number.isNaN(userId)) {
    res.status(400).json({ error: 'ID de usuário inválido.' })
    return
  }

  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT balance, total_deposits FROM users WHERE id = ?',
      [userId]
    )

    if (rows.length === 0) {
      res.status(404).json({ error: 'Usuário não encontrado.' })
      return
    }

    const row = rows[0] as { balance: number | string; total_deposits: number | string }

    res.json({
      balance: Number(row.balance ?? 0),
      totalDeposits: Number(row.total_deposits ?? 0),
    })
  } catch (err) {
    console.error('[user-summary]', err)
    res.status(500).json({ error: 'Erro interno no servidor.' })
  }
})

// ─── Login ───────────────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  const { phone, password } = req.body as {
    phone?: string
    password?: string
  }

  if (!phone || !password) {
    res.status(400).json({ error: 'Telefone e senha são obrigatórios.' })
    return
  }

  try {
    // Buscar usuário
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT id, name, phone, password, is_admin FROM users WHERE phone = ?',
      [phone]
    )

    if (rows.length === 0) {
      res.status(401).json({ error: 'Telefone ou senha incorretos.' })
      return
    }

    const user = rows[0]

    // Verificar senha
    const valid = await bcrypt.compare(password, user.password as string)
    if (!valid) {
      res.status(401).json({ error: 'Telefone ou senha incorretos.' })
      return
    }

    // Gerar JWT
    const token = jwt.sign(
      { id: user.id, phone: user.phone },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES as any }
    )

    res.json({
      message: `Bem-vindo de volta, ${user.name}!`,
      token,
      user: {
        id: user.id,
        name: user.name,
        phone: user.phone,
        is_admin: Number(user.is_admin ?? 0),
      },
    })
  } catch (err) {
    console.error('[login]', err)
    res.status(500).json({ error: 'Erro interno no servidor.' })
  }
})

app.post('/api/CASHIN/', async (req, res) => {
  const { userId, amount, method } = req.body as {
    userId?: number
    amount?: number
    method?: string
  }

  const parsedUserId = Number(userId)
  const parsedAmount = Number(amount)

  if (!parsedUserId || Number.isNaN(parsedUserId)) {
    res.status(400).json({ error: 'ID de usuário inválido.' })
    return
  }

  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    res.status(400).json({ error: 'Valor de depósito inválido.' })
    return
  }

  if (parsedAmount > 1000) {
    res.status(400).json({ error: 'Valor máximo para transação: R$ 1000,00' })
    return
  }

  try {
    await settleExpiredCyclesForUser(parsedUserId)

    const [users] = await pool.query<RowDataPacket[]>(
      'SELECT id, name, phone FROM users WHERE id = ?',
      [parsedUserId]
    )

    if (users.length === 0) {
      res.status(404).json({ error: 'Usuário não encontrado.' })
      return
    }

    const user = users[0] as { id: number; name: string; phone: string }
    const amountInCents = Math.round(parsedAmount)

    const payload = {
      amount: amountInCents,
      customerEmail: `user${user.id}@noor661.local`,
      customerName: user.name,
      customerDocument: '11615845445',
      customerDocumentType: 'cpf',
      customerPhone: user.phone?.replace(/\D/g, '') || '11999998888',
      description: `Depósito CASHIN - usuário #${user.id}`,
      callbackUrl: 'https://localhost:3333/api/CASHIN/webhook',
      metadata: {
        userId: user.id,
        method: method ?? 'pix',
      },
    }

    const lumoResponse = await fetch('https://api.lumopayment.com/api/payments/transactions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': LUMO_API_KEY,
      },
      body: JSON.stringify(payload),
    })

    const lumoData = await lumoResponse.json() as any

    if (!lumoResponse.ok || !lumoData?.success) {
      res.status(502).json({
        error: 'Falha ao criar cobrança PIX.',
        provider: lumoData,
      })
      return
    }

    const transactionId =
      lumoData?.data?.id ??
      lumoData?.data?.transaction_id ??
      lumoData?.data?.payment_data?.transaction_id ??
      null

    const qrCode =
      lumoData?.data?.payment_data?.qr_code ??
      lumoData?.data?.payment_data?.pix_code ??
      ''

    const qrImage =
      lumoData?.data?.payment_data?.qr_code_image ??
      lumoData?.data?.payment_data?.qr_code_base64 ??
      ''

    const providerStatus = String(
      lumoData?.data?.status ??
      lumoData?.status ??
      'pending'
    )

    const [paymentResult] = await pool.query(
      `
      INSERT INTO cashin_payments
      (
        user_id,
        provider_transaction_id,
        amount,
        method,
        status,
        pix_code,
        qr_image,
        provider_payload
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        parsedUserId,
        transactionId ? String(transactionId) : null,
        parsedAmount,
        method ?? 'pix',
        providerStatus,
        qrCode || null,
        qrImage || null,
        JSON.stringify(lumoData),
      ]
    ) as any

    res.json({
      ok: true,
      message: 'Cobrança PIX criada com sucesso.',
      paymentId: paymentResult?.insertId ?? null,
      transactionId,
      amount: parsedAmount,
      qrCode,
      provider: lumoData,
    })
  } catch (err) {
    console.error('[cashin-create]', err)
    res.status(500).json({ error: 'Erro interno ao criar cobrança.' })
  }
})

app.post('/api/CASHIN/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  try {
    const signatureHeader = req.headers['x-signature']
    const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader ?? ''

    const rawPayloadBuffer = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body))

    const calculated = crypto
      .createHmac('sha256', LUMO_WEBHOOK_SECRET)
      .update(rawPayloadBuffer)
      .digest('hex')

    if (!signature || !crypto.timingSafeEqual(Buffer.from(calculated), Buffer.from(String(signature)))) {
      res.status(401).send('Assinatura inválida')
      return
    }

    const payloadText = rawPayloadBuffer.toString('utf8')
    const data = JSON.parse(payloadText) as any

    const status = String(data?.status ?? '')
    const amountInCents = Number(data?.amount ?? 0)
    const userId = Number(data?.metadata?.userId ?? data?.userId ?? 0)
    const providerTransactionId =
      data?.id ??
      data?.transaction_id ??
      data?.data?.id ??
      data?.data?.transaction_id ??
      data?.payment_data?.transaction_id ??
      data?.data?.payment_data?.transaction_id ??
      null

    const normalizedStatus = (status || 'pending').toLowerCase()
    const isPaid = normalizedStatus === 'paid' || normalizedStatus === 'payment.paid'
    const amountBRL = amountInCents / 100

    if (providerTransactionId) {
      const [existingRows] = await pool.query<RowDataPacket[]>(
        'SELECT id, status, user_id, amount FROM cashin_payments WHERE provider_transaction_id = ? LIMIT 1',
        [String(providerTransactionId)]
      )

      if (existingRows.length > 0) {
        const existing = existingRows[0] as { id: number; status: string; user_id: number; amount: number | string }

        await pool.query(
          `
          UPDATE cashin_payments
          SET
            status = ?,
            provider_payload = ?,
            paid_at = CASE WHEN ? = 1 AND paid_at IS NULL THEN NOW() ELSE paid_at END,
            updated_at = NOW()
          WHERE id = ?
          `,
          [normalizedStatus, JSON.stringify(data), isPaid ? 1 : 0, existing.id]
        )

        const wasAlreadyPaid = String(existing.status ?? '').toLowerCase() === 'paid' || String(existing.status ?? '').toLowerCase() === 'payment.paid'
        if (isPaid && !wasAlreadyPaid) {
          await pool.query(
            `
            UPDATE users
            SET
              balance = COALESCE(balance, 0) + ?,
              total_deposits = COALESCE(total_deposits, 0) + ?
            WHERE id = ?
            `,
            [Number(existing.amount ?? amountBRL), Number(existing.amount ?? amountBRL), existing.user_id]
          )
        }

        res.status(200).send('OK')
        return
      }
    }

    if (userId && !Number.isNaN(userId)) {
      await pool.query(
        `
        INSERT INTO cashin_payments
        (
          user_id,
          provider_transaction_id,
          amount,
          method,
          status,
          provider_payload,
          paid_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        [
          userId,
          providerTransactionId ? String(providerTransactionId) : null,
          amountBRL > 0 ? amountBRL : 0,
          String(data?.metadata?.method ?? 'pix'),
          normalizedStatus,
          JSON.stringify(data),
          isPaid ? new Date() : null,
        ]
      )

      if (isPaid && amountBRL > 0) {
        await pool.query(
          `
          UPDATE users
          SET
            balance = COALESCE(balance, 0) + ?,
            total_deposits = COALESCE(total_deposits, 0) + ?
          WHERE id = ?
          `,
          [amountBRL, amountBRL, userId]
        )
      }
    }

    res.status(200).send('OK')
  } catch (err) {
    console.error('[cashin-webhook]', err)
    res.status(500).send('Erro')
  }
})

// ─── Start ───────────────────────────────────────────────────────────────────
app.get('/api/referral/:userId', async (req, res) => {
  const userId = Number(req.params.userId)

  if (!userId || Number.isNaN(userId)) {
    res.status(400).json({ ok: false, error: 'ID de usuário inválido.' })
    return
  }

  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT id, referral_code AS referralCode FROM users WHERE id = ? LIMIT 1',
      [userId]
    )

    if (rows.length === 0) {
      res.status(404).json({ ok: false, error: 'Usuário não encontrado.' })
      return
    }

    let referralCode = String(rows[0].referralCode ?? '').trim()

    if (!referralCode) {
      referralCode = `U${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 900 + 100)}`
      await pool.query(
        'UPDATE users SET referral_code = ? WHERE id = ?',
        [referralCode, userId]
      )
    }

    const appBaseUrl = process.env.APP_BASE_URL ?? 'http://localhost:5173'
    const referralLink = `${appBaseUrl}/cadastro?ref=${encodeURIComponent(referralCode)}`

    res.json({
      ok: true,
      userId,
      referralCode,
      referralLink,
    })
  } catch (err) {
    console.error('[referral-get]', err)
    res.status(500).json({ ok: false, error: 'Erro ao carregar link de convite.' })
  }
})

app.get('/api/dashboard/cycle-products', async (_req, res) => {
  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `
      SELECT
        id,
        name,
        description,
        amount,
        profit,
        cycle_days AS cycleDays,
        image_url AS imageUrl,
        is_active AS isActive,
        sort_order AS sortOrder
      FROM cycle_products
      WHERE is_active = 1
      ORDER BY sort_order ASC, id ASC
      `
    )

    const products = rows.map((row) => ({
      id: Number(row.id),
      name: String(row.name ?? ''),
      description: String(row.description ?? ''),
      amount: Number(row.amount ?? 0),
      profit: Number(row.profit ?? 0),
      cycleDays: Number(row.cycleDays ?? 0),
      imageUrl: String(row.imageUrl ?? ''),
      isActive: Number(row.isActive ?? 1) === 1,
      sortOrder: Number(row.sortOrder ?? 0),
    }))

    res.json({ ok: true, products })
  } catch (err) {
    console.error('[dashboard-cycle-products]', err)
    res.status(500).json({ ok: false, error: 'Erro ao listar planos de ciclo.' })
  }
})

app.get('/api/vip/levels', async (_req, res) => {
  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `
      SELECT
        id,
        name,
        price,
        daily_task_limit AS dailyTaskLimit,
        task_reward_multiplier AS taskRewardMultiplier,
        benefits,
        is_active AS isActive,
        sort_order AS sortOrder
      FROM vip_levels
      WHERE is_active = 1
      ORDER BY sort_order ASC, id ASC
      `
    )

    const levels = rows.map((row) => ({
      id: Number(row.id),
      name: String(row.name ?? ''),
      price: Number(row.price ?? 0),
      dailyTaskLimit: Number(row.dailyTaskLimit ?? 0),
      taskRewardMultiplier: Number(row.taskRewardMultiplier ?? 1),
      benefits: String(row.benefits ?? ''),
      isActive: Number(row.isActive ?? 1) === 1,
      sortOrder: Number(row.sortOrder ?? 0),
    }))

    res.json({ ok: true, levels })
  } catch (err) {
    console.error('[vip-levels]', err)
    res.status(500).json({ ok: false, error: 'Erro ao listar níveis VIP.' })
  }
})

app.get('/api/vip/user/:userId', async (req, res) => {
  const userId = Number(req.params.userId)

  if (!userId || Number.isNaN(userId)) {
    res.status(400).json({ ok: false, error: 'ID de usuário inválido.' })
    return
  }

  try {
    const [balanceRows] = await pool.query<RowDataPacket[]>(
      'SELECT balance FROM users WHERE id = ? LIMIT 1',
      [userId]
    )

    if (balanceRows.length === 0) {
      res.status(404).json({ ok: false, error: 'Usuário não encontrado.' })
      return
    }

    const userBalance = Number(balanceRows[0].balance ?? 0)

    const [rows] = await pool.query<RowDataPacket[]>(
      `
      SELECT
        uv.id,
        uv.user_id AS userId,
        uv.vip_level_id AS vipLevelId,
        uv.status,
        uv.started_at AS startedAt,
        uv.expires_at AS expiresAt,
        vl.name AS levelName,
        vl.daily_task_limit AS dailyTaskLimit,
        vl.task_reward_multiplier AS taskRewardMultiplier,
        vl.price AS vipPrice
      FROM user_vips uv
      INNER JOIN vip_levels vl ON vl.id = uv.vip_level_id
      WHERE uv.user_id = ?
        AND uv.status = 'active'
        AND (uv.expires_at IS NULL OR uv.expires_at > NOW())
      ORDER BY uv.id DESC
      LIMIT 1
      `,
      [userId]
    )

    if (rows.length === 0) {
      res.json({ ok: true, hasVip: false, vip: null, balance: userBalance })
      return
    }

    const vip = rows[0]
    res.json({
      ok: true,
      hasVip: true,
      balance: userBalance,
      vip: {
        id: Number(vip.id),
        userId: Number(vip.userId),
        vipLevelId: Number(vip.vipLevelId),
        status: String(vip.status ?? 'active'),
        startedAt: vip.startedAt,
        expiresAt: vip.expiresAt,
        levelName: String(vip.levelName ?? ''),
        dailyTaskLimit: Number(vip.dailyTaskLimit ?? 0),
        taskRewardMultiplier: Number(vip.taskRewardMultiplier ?? 1),
        vipPrice: Number(vip.vipPrice ?? 0),
      },
    })
  } catch (err) {
    console.error('[vip-user]', err)
    res.status(500).json({ ok: false, error: 'Erro ao consultar VIP do usuário.' })
  }
})

app.post('/api/vip/activate', async (req, res) => {
  const { userId, vipLevelId } = req.body as { userId?: number; vipLevelId?: number }

  const parsedUserId = Number(userId)
  const parsedVipLevelId = Number(vipLevelId)

  if (!parsedUserId || Number.isNaN(parsedUserId)) {
    res.status(400).json({ ok: false, error: 'ID de usuário inválido.' })
    return
  }

  if (!parsedVipLevelId || Number.isNaN(parsedVipLevelId)) {
    res.status(400).json({ ok: false, error: 'Nível VIP inválido.' })
    return
  }

  try {
    await settleExpiredCyclesForUser(parsedUserId)

    const [users] = await pool.query<RowDataPacket[]>(
      'SELECT id, balance FROM users WHERE id = ? LIMIT 1',
      [parsedUserId]
    )

    if (users.length === 0) {
      res.status(404).json({ ok: false, error: 'Usuário não encontrado.' })
      return
    }

    const [levels] = await pool.query<RowDataPacket[]>(
      'SELECT id, name, price, is_active AS isActive FROM vip_levels WHERE id = ? LIMIT 1',
      [parsedVipLevelId]
    )

    if (levels.length === 0 || Number(levels[0].isActive ?? 0) !== 1) {
      res.status(404).json({ ok: false, error: 'Nível VIP não encontrado ou inativo.' })
      return
    }

    const levelPrice = Number(levels[0].price ?? 0)
    const currentBalance = Number(users[0].balance ?? 0)

    if (currentBalance < levelPrice) {
      res.status(400).json({
        ok: false,
        error: 'Saldo insuficiente para ativar este VIP.',
        required: levelPrice,
        available: currentBalance,
      })
      return
    }

    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()

      await conn.query(
        `
        UPDATE user_vips
        SET status = 'inactive'
        WHERE user_id = ? AND status = 'active'
        `,
        [parsedUserId]
      )

      await conn.query(
        `
        UPDATE users
        SET balance = COALESCE(balance, 0) - ?
        WHERE id = ?
        `,
        [levelPrice, parsedUserId]
      )

      await conn.query(
        `
        INSERT INTO user_vips
        (
          user_id,
          vip_level_id,
          status,
          started_at,
          expires_at
        )
        VALUES (?, ?, 'active', NOW(), DATE_ADD(NOW(), INTERVAL 30 DAY))
        `,
        [parsedUserId, parsedVipLevelId]
      )

      // Regra solicitada:
      // Se comprou novo VIP no mesmo dia, libera novo ciclo de tarefas do dia.
      // Estratégia: apagar progresso diário atual para recalcular com o VIP recém-ativado.
      const saoPauloDate = getSaoPauloDateString()
      await conn.query(
        `
        DELETE FROM user_mining_task_progress
        WHERE user_id = ?
          AND progress_date = ?
        `,
        [parsedUserId, saoPauloDate]
      )

      await conn.query(
        `
        INSERT INTO vip_purchase_history
        (
          user_id,
          vip_level_id,
          amount_paid,
          balance_before,
          balance_after
        )
        VALUES (?, ?, ?, ?, ?)
        `,
        [parsedUserId, parsedVipLevelId, levelPrice, currentBalance, currentBalance - levelPrice]
      )

      await conn.commit()
    } catch (error) {
      await conn.rollback()
      throw error
    } finally {
      conn.release()
    }

    res.json({
      ok: true,
      message: `VIP ${String(levels[0].name ?? '')} ativado com sucesso.`,
      amountPaid: levelPrice,
      balanceBefore: currentBalance,
      balanceAfter: currentBalance - levelPrice,
    })
  } catch (err) {
    console.error('[vip-activate]', err)
    res.status(500).json({ ok: false, error: 'Erro ao ativar VIP.' })
  }
})

app.get('/api/mining/tasks/:userId', async (req, res) => {
  const userId = Number(req.params.userId)

  if (!userId || Number.isNaN(userId)) {
    res.status(400).json({ ok: false, error: 'ID de usuário inválido.' })
    return
  }

  try {
    await settleExpiredCyclesForUser(userId)

    const [users] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM users WHERE id = ? LIMIT 1',
      [userId]
    )

    if (users.length === 0) {
      res.status(404).json({ ok: false, error: 'Usuário não encontrado.' })
      return
    }

    const [vipRows] = await pool.query<RowDataPacket[]>(
      `
      SELECT
        uv.id,
        uv.vip_level_id AS vipLevelId,
        vl.name AS vipName,
        vl.daily_task_limit AS vipDailyTaskLimit,
        vl.task_reward_multiplier AS vipMultiplier
      FROM user_vips uv
      INNER JOIN vip_levels vl ON vl.id = uv.vip_level_id
      WHERE uv.user_id = ?
        AND uv.status = 'active'
        AND (uv.expires_at IS NULL OR uv.expires_at > NOW())
      ORDER BY uv.id DESC
      LIMIT 1
      `,
      [userId]
    )

    if (vipRows.length === 0) {
      res.status(403).json({
        ok: false,
        error: 'VIP ativo é obrigatório para acessar tarefas.',
        code: 'VIP_REQUIRED',
      })
      return
    }

    const vip = vipRows[0]
    const vipDailyTaskLimit = Number(vip.vipDailyTaskLimit ?? 0)
    const vipMultiplier = Number(vip.vipMultiplier ?? 1)

    const saoPauloDate = getSaoPauloDateString()

    const [dailyRows] = await pool.query<RowDataPacket[]>(
      `
      SELECT COALESCE(SUM(completed_count), 0) AS totalCompletedToday
      FROM user_mining_task_progress
      WHERE user_id = ? AND progress_date = ?
      `,
      [userId, saoPauloDate]
    )

    const totalCompletedToday = Number(dailyRows[0]?.totalCompletedToday ?? 0)
    const remainingByVip = Math.max(vipDailyTaskLimit - totalCompletedToday, 0)

    const [rows] = await pool.query<RowDataPacket[]>(
      `
      SELECT
        t.id,
        t.name,
        t.description,
        t.reward_amount AS baseRewardAmount,
        COALESCE(p.completed_count, 0) AS completedToday,
        COALESCE(p.earned_amount, 0) AS earnedToday
      FROM mining_tasks t
      LEFT JOIN user_mining_task_progress p
        ON p.task_id = t.id
        AND p.user_id = ?
        AND p.progress_date = ?
      WHERE t.is_active = 1
      ORDER BY t.id ASC
      `,
      [userId, saoPauloDate]
    )

    const tasks = rows.map((task) => {
      const baseRewardAmount = Number(task.baseRewardAmount ?? 0)
      const rewardAmount = Number((baseRewardAmount * vipMultiplier).toFixed(2))

      return {
        id: Number(task.id),
        name: String(task.name ?? ''),
        description: String(task.description ?? ''),
        dailyLimit: vipDailyTaskLimit,
        completedToday: Number(task.completedToday ?? 0),
        earnedToday: Number(task.earnedToday ?? 0),
        rewardAmount,
        remainingToday: remainingByVip,
      }
    })

    res.json({
      ok: true,
      vip: {
        vipLevelId: Number(vip.vipLevelId),
        vipName: String(vip.vipName ?? ''),
        vipDailyTaskLimit,
        vipMultiplier,
      },
      totalCompletedToday,
      remainingByVip,
      tasks,
    })
  } catch (err) {
    console.error('[mining-tasks-list]', err)
    res.status(500).json({ ok: false, error: 'Erro interno ao listar tarefas.' })
  }
})

app.post('/api/mining/tasks/complete', async (req, res) => {
  const { userId, taskId } = req.body as { userId?: number; taskId?: number }

  const parsedUserId = Number(userId)
  const parsedTaskId = Number(taskId)

  if (!parsedUserId || Number.isNaN(parsedUserId)) {
    res.status(400).json({ ok: false, error: 'ID de usuário inválido.' })
    return
  }

  if (!parsedTaskId || Number.isNaN(parsedTaskId)) {
    res.status(400).json({ ok: false, error: 'ID da tarefa inválido.' })
    return
  }

  try {
    const [users] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM users WHERE id = ? LIMIT 1',
      [parsedUserId]
    )

    if (users.length === 0) {
      res.status(404).json({ ok: false, error: 'Usuário não encontrado.' })
      return
    }

    const [vipRows] = await pool.query<RowDataPacket[]>(
      `
      SELECT
        uv.id,
        uv.vip_level_id AS vipLevelId,
        vl.name AS vipName,
        vl.daily_task_limit AS vipDailyTaskLimit,
        vl.task_reward_multiplier AS vipMultiplier
      FROM user_vips uv
      INNER JOIN vip_levels vl ON vl.id = uv.vip_level_id
      WHERE uv.user_id = ?
        AND uv.status = 'active'
        AND (uv.expires_at IS NULL OR uv.expires_at > NOW())
      ORDER BY uv.id DESC
      LIMIT 1
      `,
      [parsedUserId]
    )

    if (vipRows.length === 0) {
      res.status(403).json({
        ok: false,
        error: 'VIP ativo é obrigatório para concluir tarefas.',
        code: 'VIP_REQUIRED',
      })
      return
    }

    const vip = vipRows[0]
    const vipDailyTaskLimit = Number(vip.vipDailyTaskLimit ?? 0)
    const vipMultiplier = Number(vip.vipMultiplier ?? 1)

    const saoPauloDate = getSaoPauloDateString()

    const [dailyRows] = await pool.query<RowDataPacket[]>(
      `
      SELECT COALESCE(SUM(completed_count), 0) AS totalCompletedToday
      FROM user_mining_task_progress
      WHERE user_id = ? AND progress_date = ?
      `,
      [parsedUserId, saoPauloDate]
    )

    const totalCompletedToday = Number(dailyRows[0]?.totalCompletedToday ?? 0)
    if (totalCompletedToday >= vipDailyTaskLimit) {
      res.status(400).json({ ok: false, error: 'Limite diário do seu VIP já foi atingido.' })
      return
    }

    const [taskRows] = await pool.query<RowDataPacket[]>(
      `
      SELECT id, reward_amount AS baseRewardAmount, is_active AS isActive
      FROM mining_tasks
      WHERE id = ?
      LIMIT 1
      `,
      [parsedTaskId]
    )

    if (taskRows.length === 0) {
      res.status(404).json({ ok: false, error: 'Tarefa não encontrada.' })
      return
    }

    const task = taskRows[0]
    if (!Number(task.isActive)) {
      res.status(400).json({ ok: false, error: 'Tarefa inativa.' })
      return
    }

    const rewardAmount = Number((Number(task.baseRewardAmount ?? 0) * vipMultiplier).toFixed(2))

    const [progressRows] = await pool.query<RowDataPacket[]>(
      `
      SELECT id, completed_count AS completedCount
      FROM user_mining_task_progress
      WHERE user_id = ? AND task_id = ? AND progress_date = ?
      LIMIT 1
      `,
      [parsedUserId, parsedTaskId, saoPauloDate]
    )

    if (progressRows.length > 0 && Number(progressRows[0].completedCount ?? 0) > 0) {
      res.status(400).json({
        ok: false,
        error: 'Esta tarefa já foi concluída hoje. Tente novamente após 00:00 (Horário de São Paulo).',
        code: 'TASK_ALREADY_COMPLETED_TODAY',
      })
      return
    }

    if (progressRows.length > 0) {
      await pool.query(
        `
        UPDATE user_mining_task_progress
        SET
          completed_count = 1,
          earned_amount = ?,
          updated_at = NOW()
        WHERE id = ?
        `,
        [rewardAmount, progressRows[0].id]
      )
    } else {
      await pool.query(
        `
        INSERT INTO user_mining_task_progress
        (
          user_id,
          task_id,
          progress_date,
          completed_count,
          earned_amount
        )
        VALUES (?, ?, ?, 1, ?)
        `,
        [parsedUserId, parsedTaskId, saoPauloDate, rewardAmount]
      )
    }

    await pool.query(
      `
      UPDATE users
      SET balance = COALESCE(balance, 0) + ?
      WHERE id = ?
      `,
      [rewardAmount, parsedUserId]
    )

    res.json({
      ok: true,
      message: 'Tarefa de mineração concluída com sucesso.',
      vipName: String(vip.vipName ?? ''),
      rewardAmount,
      totalCompletedToday: totalCompletedToday + 1,
      remainingToday: Math.max(vipDailyTaskLimit - (totalCompletedToday + 1), 0),
    })
  } catch (err) {
    console.error('[mining-task-complete]', err)
    res.status(500).json({ ok: false, error: 'Erro interno ao completar tarefa.' })
  }
})

app.get('/api/profile/metrics/:userId', async (req, res) => {
  const userId = Number(req.params.userId)

  if (!userId || Number.isNaN(userId)) {
    res.status(400).json({ ok: false, error: 'ID de usuário inválido.' })
    return
  }

  try {
    await settleExpiredCyclesForUser(userId)

    const [users] = await pool.query<RowDataPacket[]>(
      'SELECT id, balance FROM users WHERE id = ? LIMIT 1',
      [userId]
    )

    if (users.length === 0) {
      res.status(404).json({ ok: false, error: 'Usuário não encontrado.' })
      return
    }

    const withdrawableBalance = Number(users[0].balance ?? 0)

    const [teamRows] = await pool.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS total FROM users WHERE referred_by_user_id = ?',
      [userId]
    )
    const teamTotal = Number(teamRows[0]?.total ?? 0)

    await pool.query(
      `
      CREATE TABLE IF NOT EXISTS user_cycle_purchases (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id BIGINT UNSIGNED NOT NULL,
        cycle_product_id BIGINT UNSIGNED NOT NULL,
        amount_paid DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        expected_profit DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        cycle_days INT NOT NULL DEFAULT 0,
        status ENUM('active','completed','cancelled') NOT NULL DEFAULT 'active',
        started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        ends_at DATETIME NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_user_cycle_purchases_user_id (user_id),
        KEY idx_user_cycle_purchases_product_id (cycle_product_id),
        KEY idx_user_cycle_purchases_status (status)
      )
      `
    )

    const [cycleRows] = await pool.query<RowDataPacket[]>(
      `
      SELECT
        ucp.id,
        ucp.amount_paid AS amountPaid,
        ucp.expected_profit AS expectedProfit,
        ucp.cycle_days AS cycleDays,
        ucp.started_at AS startedAt,
        ucp.ends_at AS endsAt,
        cp.name AS productName
      FROM user_cycle_purchases ucp
      LEFT JOIN cycle_products cp ON cp.id = ucp.cycle_product_id
      WHERE ucp.user_id = ?
        AND ucp.status = 'active'
      ORDER BY ucp.id DESC
      LIMIT 1
      `,
      [userId]
    )

    const hasActiveCyclePlan = cycleRows.length > 0
    const activeCyclePlan = hasActiveCyclePlan
      ? {
          id: Number(cycleRows[0].id),
          productName: String(cycleRows[0].productName ?? 'Plano de ciclo'),
          amountPaid: Number(cycleRows[0].amountPaid ?? 0),
          expectedProfit: Number(cycleRows[0].expectedProfit ?? 0),
          cycleDays: Number(cycleRows[0].cycleDays ?? 0),
          startedAt: cycleRows[0].startedAt,
          endsAt: cycleRows[0].endsAt,
        }
      : null

    res.json({
      ok: true,
      metrics: {
        teamTotal,
        withdrawableBalance,
        hasActiveCyclePlan,
        activeCyclePlan,
      },
    })
  } catch (err) {
    console.error('[profile-metrics]', err)
    res.status(500).json({ ok: false, error: 'Erro ao carregar métricas do perfil.' })
  }
})

app.post('/api/cycle-products/purchase', async (req, res) => {
  const { userId, cycleProductId } = req.body as { userId?: number; cycleProductId?: number }

  const parsedUserId = Number(userId)
  const parsedCycleProductId = Number(cycleProductId)

  if (!parsedUserId || Number.isNaN(parsedUserId)) {
    res.status(400).json({ ok: false, error: 'ID de usuário inválido.' })
    return
  }

  if (!parsedCycleProductId || Number.isNaN(parsedCycleProductId)) {
    res.status(400).json({ ok: false, error: 'ID do produto de ciclo inválido.' })
    return
  }

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    const [users] = await conn.query<RowDataPacket[]>(
      'SELECT id, balance FROM users WHERE id = ? LIMIT 1 FOR UPDATE',
      [parsedUserId]
    )

    if (users.length === 0) {
      await conn.rollback()
      res.status(404).json({ ok: false, error: 'Usuário não encontrado.' })
      return
    }

    const [products] = await conn.query<RowDataPacket[]>(
      `
      SELECT id, name, amount, profit, cycle_days AS cycleDays, is_active AS isActive
      FROM cycle_products
      WHERE id = ?
      LIMIT 1
      FOR UPDATE
      `,
      [parsedCycleProductId]
    )

    if (products.length === 0 || Number(products[0].isActive ?? 0) !== 1) {
      await conn.rollback()
      res.status(404).json({ ok: false, error: 'Produto de ciclo não encontrado ou inativo.' })
      return
    }

    const product = products[0]
    const userBalance = Number(users[0].balance ?? 0)
    const amount = Number(product.amount ?? 0)

    if (userBalance < amount) {
      await conn.rollback()
      res.status(400).json({
        ok: false,
        error: 'Saldo insuficiente para adquirir este ciclo.',
        required: amount,
        available: userBalance,
      })
      return
    }

    await conn.query(
      `
      CREATE TABLE IF NOT EXISTS user_cycle_purchases (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id BIGINT UNSIGNED NOT NULL,
        cycle_product_id BIGINT UNSIGNED NOT NULL,
        amount_paid DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        expected_profit DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        cycle_days INT NOT NULL DEFAULT 0,
        status ENUM('active','completed','cancelled') NOT NULL DEFAULT 'active',
        started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        ends_at DATETIME NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_user_cycle_purchases_user_id (user_id),
        KEY idx_user_cycle_purchases_product_id (cycle_product_id),
        KEY idx_user_cycle_purchases_status (status)
      )
      `
    )

    await conn.query(
      `
      UPDATE users
      SET balance = COALESCE(balance, 0) - ?
      WHERE id = ?
      `,
      [amount, parsedUserId]
    )

    await conn.query(
      `
      INSERT INTO user_cycle_purchases
      (
        user_id,
        cycle_product_id,
        amount_paid,
        expected_profit,
        cycle_days,
        status,
        started_at,
        ends_at
      )
      VALUES (?, ?, ?, ?, ?, 'active', NOW(), DATE_ADD(NOW(), INTERVAL ? DAY))
      `,
      [
        parsedUserId,
        Number(product.id),
        amount,
        Number(product.profit ?? 0),
        Number(product.cycleDays ?? 0),
        Number(product.cycleDays ?? 0),
      ]
    )

    await conn.commit()

    res.json({
      ok: true,
      message: `Ciclo ${String(product.name ?? '')} adquirido com sucesso.`,
      product: {
        id: Number(product.id),
        name: String(product.name ?? ''),
        amount,
        profit: Number(product.profit ?? 0),
        cycleDays: Number(product.cycleDays ?? 0),
      },
      balanceBefore: userBalance,
      balanceAfter: Number((userBalance - amount).toFixed(2)),
    })
  } catch (err) {
    await conn.rollback()
    console.error('[cycle-product-purchase]', err)
    res.status(500).json({ ok: false, error: 'Erro ao adquirir produto de ciclo.' })
  } finally {
    conn.release()
  }
})

app.get('/api/team/report/:userId', async (req, res) => {
  const userId = Number(req.params.userId)
  const startDate = String(req.query.startDate ?? '').trim()
  const endDate = String(req.query.endDate ?? '').trim()

  if (!userId || Number.isNaN(userId)) {
    res.status(400).json({ ok: false, error: 'ID de usuário inválido.' })
    return
  }

  const hasDateRange = Boolean(startDate && endDate)
  const dateFilterUsers = hasDateRange ? 'AND DATE(u.created_at) BETWEEN ? AND ?' : ''
  const dateFilterDeposits = hasDateRange ? 'AND DATE(cp.created_at) BETWEEN ? AND ?' : ''

  try {
    const [users] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM users WHERE id = ? LIMIT 1',
      [userId]
    )

    if (users.length === 0) {
      res.status(404).json({ ok: false, error: 'Usuário não encontrado.' })
      return
    }

    const [kpiRows] = await pool.query<RowDataPacket[]>(
      `
      SELECT
        (SELECT COUNT(*)
         FROM users u
         WHERE u.referred_by_user_id = ?
         ${dateFilterUsers}) AS teamSize,
        (SELECT COUNT(DISTINCT u.id)
         FROM users u
         INNER JOIN cashin_payments cp ON cp.user_id = u.id
         WHERE u.referred_by_user_id = ?
           AND LOWER(cp.status) IN ('paid', 'payment.paid')
           ${dateFilterDeposits}) AS depositedMembers,
        (SELECT COALESCE(SUM(cp.amount), 0)
         FROM users u
         INNER JOIN cashin_payments cp ON cp.user_id = u.id
         WHERE u.referred_by_user_id = ?
           AND LOWER(cp.status) IN ('paid', 'payment.paid')
           ${dateFilterDeposits}) AS teamRecharge
      `,
      hasDateRange
        ? [
            userId, startDate, endDate,
            userId, startDate, endDate,
            userId, startDate, endDate,
          ]
        : [userId, userId, userId]
    )

    let teamWithdraw = 0
    try {
      const [withdrawRows] = await pool.query<RowDataPacket[]>(
        `
        SELECT COALESCE(SUM(w.amount), 0) AS teamWithdraw
        FROM users u
        INNER JOIN withdrawals w ON w.user_id = u.id
        WHERE u.referred_by_user_id = ?
          ${hasDateRange ? 'AND DATE(w.created_at) BETWEEN ? AND ?' : ''}
        `,
        hasDateRange ? [userId, startDate, endDate] : [userId]
      )
      teamWithdraw = Number(withdrawRows[0]?.teamWithdraw ?? 0)
    } catch {
      // fallback seguro para ambientes sem tabela de saques
      teamWithdraw = 0
    }

    const [levelRows] = await pool.query<RowDataPacket[]>(
      `
      WITH RECURSIVE referral_tree AS (
        SELECT
          u.id,
          u.referred_by_user_id,
          1 AS level
        FROM users u
        WHERE u.referred_by_user_id = ?

        UNION ALL

        SELECT
          u2.id,
          u2.referred_by_user_id,
          rt.level + 1 AS level
        FROM users u2
        INNER JOIN referral_tree rt ON u2.referred_by_user_id = rt.id
        WHERE rt.level < 3
      )
      SELECT
        rt.level,
        COUNT(DISTINCT rt.id) AS totalMembers,
        COUNT(DISTINCT CASE
          WHEN cp.id IS NOT NULL AND LOWER(cp.status) IN ('paid', 'payment.paid') THEN rt.id
          ELSE NULL
        END) AS depositedMembers,
        COALESCE(SUM(CASE
          WHEN cp.id IS NOT NULL AND LOWER(cp.status) IN ('paid', 'payment.paid') THEN cp.amount
          ELSE 0
        END), 0) AS rechargedAmount
      FROM referral_tree rt
      LEFT JOIN users u ON u.id = rt.id
      LEFT JOIN cashin_payments cp ON cp.user_id = rt.id
      WHERE rt.level BETWEEN 1 AND 3
        ${hasDateRange ? 'AND DATE(u.created_at) BETWEEN ? AND ?' : ''}
        ${hasDateRange ? 'AND (cp.id IS NULL OR DATE(cp.created_at) BETWEEN ? AND ?)' : ''}
      GROUP BY rt.level
      ORDER BY rt.level ASC
      `,
      hasDateRange ? [userId, startDate, endDate, startDate, endDate] : [userId]
    )

    const levels = [1, 2, 3].map((level) => {
      const row = levelRows.find((r) => Number(r.level) === level)
      return {
        level,
        totalMembers: Number(row?.totalMembers ?? 0),
        depositedMembers: Number(row?.depositedMembers ?? 0),
        rechargedAmount: Number(row?.rechargedAmount ?? 0),
      }
    })

    res.json({
      ok: true,
      filters: {
        startDate: hasDateRange ? startDate : null,
        endDate: hasDateRange ? endDate : null,
      },
      summary: {
        teamSize: Number(kpiRows[0]?.teamSize ?? 0),
        depositedMembers: Number(kpiRows[0]?.depositedMembers ?? 0),
        teamRecharge: Number(kpiRows[0]?.teamRecharge ?? 0),
        teamWithdraw,
      },
      levels,
    })
  } catch (err) {
    console.error('[team-report]', err)
    res.status(500).json({ ok: false, error: 'Erro ao carregar relatório da equipe.' })
  }
})

app.get('/api/team/members/:userId', async (req, res) => {
  const userId = Number(req.params.userId)
  const startDate = String(req.query.startDate ?? '').trim()
  const endDate = String(req.query.endDate ?? '').trim()
  const level = Number(req.query.level ?? 1)

  if (!userId || Number.isNaN(userId)) {
    res.status(400).json({ ok: false, error: 'ID de usuário inválido.' })
    return
  }

  if (![1, 2, 3].includes(level)) {
    res.status(400).json({ ok: false, error: 'Nível inválido. Use 1, 2 ou 3.' })
    return
  }

  const hasDateRange = Boolean(startDate && endDate)
  const dateFilter = hasDateRange ? 'AND DATE(u.created_at) BETWEEN ? AND ?' : ''

  try {
    const [users] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM users WHERE id = ? LIMIT 1',
      [userId]
    )

    if (users.length === 0) {
      res.status(404).json({ ok: false, error: 'Usuário não encontrado.' })
      return
    }

    const [rows] = await pool.query<RowDataPacket[]>(
      `
      WITH RECURSIVE referral_tree AS (
        SELECT
          u.id,
          u.name,
          u.phone,
          u.created_at,
          u.referred_by_user_id,
          1 AS level
        FROM users u
        WHERE u.referred_by_user_id = ?

        UNION ALL

        SELECT
          u2.id,
          u2.name,
          u2.phone,
          u2.created_at,
          u2.referred_by_user_id,
          rt.level + 1 AS level
        FROM users u2
        INNER JOIN referral_tree rt ON u2.referred_by_user_id = rt.id
        WHERE rt.level < 3
      )
      SELECT
        rt.id,
        rt.name,
        rt.phone,
        rt.level,
        rt.created_at AS createdAt,
        COALESCE(SUM(CASE WHEN LOWER(cp.status) IN ('paid','payment.paid') THEN cp.amount ELSE 0 END), 0) AS totalDeposits,
        MAX(CASE WHEN LOWER(cp.status) IN ('paid','payment.paid') THEN 1 ELSE 0 END) AS hasDeposit
      FROM referral_tree rt
      LEFT JOIN cashin_payments cp ON cp.user_id = rt.id
      WHERE rt.level = ?
        ${dateFilter}
      GROUP BY rt.id, rt.name, rt.phone, rt.level, rt.created_at
      ORDER BY rt.created_at DESC
      `,
      hasDateRange ? [userId, level, startDate, endDate] : [userId, level]
    )

    const members = rows.map((row) => ({
      id: Number(row.id),
      name: String(row.name ?? 'Usuário'),
      phone: String(row.phone ?? '-'),
      level: Number(row.level ?? level),
      createdAt: row.createdAt,
      totalDeposits: Number(row.totalDeposits ?? 0),
      hasDeposit: Number(row.hasDeposit ?? 0) === 1,
    }))

    res.json({
      ok: true,
      level,
      total: members.length,
      members,
    })
  } catch (err) {
    console.error('[team-members]', err)
    res.status(500).json({ ok: false, error: 'Erro ao carregar membros da equipe.' })
  }
})

app.post('/api/roleta/spin', async (req, res) => {
  const { userId } = req.body as { userId?: number }
  const parsedUserId = Number(userId)

  if (!parsedUserId || Number.isNaN(parsedUserId)) {
    res.status(400).json({ ok: false, error: 'ID de usuário inválido.' })
    return
  }

  const prizes = ['7 BRL', '16 BRL', '35 BRL', '73 BRL', '183 BRL', '16600 BRL', '50 BRL', '90 BRL']
  const selectedIndex = Math.floor(Math.random() * prizes.length)
  const selectedPrize = prizes[selectedIndex]
  const segmentAngle = 360 / prizes.length
  const pointerAngle = 270
  const targetCenterAngle = selectedIndex * segmentAngle + segmentAngle / 2
  const rotationFinal = 2160 + (pointerAngle - targetCenterAngle)

  try {
    const [users] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM users WHERE id = ? LIMIT 1',
      [parsedUserId]
    )

    if (users.length === 0) {
      res.status(404).json({ ok: false, error: 'Usuário não encontrado.' })
      return
    }

    await pool.query(
      `
      CREATE TABLE IF NOT EXISTS roulette_spins (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id BIGINT UNSIGNED NOT NULL,
        prize_label VARCHAR(80) NOT NULL,
        prize_index INT NOT NULL,
        rotation_final DECIMAL(12,4) NOT NULL DEFAULT 0,
        source VARCHAR(30) NOT NULL DEFAULT 'roleta_page',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_roulette_spins_user_id (user_id),
        KEY idx_roulette_spins_created_at (created_at)
      )
      `
    )

    const [result] = await pool.query(
      `
      INSERT INTO roulette_spins
      (user_id, prize_label, prize_index, rotation_final, source)
      VALUES (?, ?, ?, ?, ?)
      `,
      [parsedUserId, selectedPrize, selectedIndex, rotationFinal, 'roleta_page']
    ) as any

    res.json({
      ok: true,
      spin: {
        id: Number(result?.insertId ?? 0),
        userId: parsedUserId,
        prizeLabel: selectedPrize,
        prizeIndex: selectedIndex,
        rotationFinal,
        createdAt: new Date().toISOString(),
      },
    })
  } catch (err) {
    console.error('[roleta-spin]', err)
    res.status(500).json({ ok: false, error: 'Erro ao registrar giro da roleta.' })
  }
})

app.get('/api/roleta/spins/:userId', async (req, res) => {
  const userId = Number(req.params.userId)
  const limit = Math.min(Math.max(Number(req.query.limit ?? 20), 1), 100)

  if (!userId || Number.isNaN(userId)) {
    res.status(400).json({ ok: false, error: 'ID de usuário inválido.' })
    return
  }

  try {
    const [users] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM users WHERE id = ? LIMIT 1',
      [userId]
    )

    if (users.length === 0) {
      res.status(404).json({ ok: false, error: 'Usuário não encontrado.' })
      return
    }

    await pool.query(
      `
      CREATE TABLE IF NOT EXISTS roulette_spins (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id BIGINT UNSIGNED NOT NULL,
        prize_label VARCHAR(80) NOT NULL,
        prize_index INT NOT NULL,
        rotation_final DECIMAL(12,4) NOT NULL DEFAULT 0,
        source VARCHAR(30) NOT NULL DEFAULT 'roleta_page',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_roulette_spins_user_id (user_id),
        KEY idx_roulette_spins_created_at (created_at)
      )
      `
    )

    const [rows] = await pool.query<RowDataPacket[]>(
      `
      SELECT
        id,
        user_id AS userId,
        prize_label AS prizeLabel,
        prize_index AS prizeIndex,
        rotation_final AS rotationFinal,
        source,
        created_at AS createdAt
      FROM roulette_spins
      WHERE user_id = ?
      ORDER BY id DESC
      LIMIT ?
      `,
      [userId, limit]
    )

    const spins = rows.map((row) => ({
      id: Number(row.id),
      userId: Number(row.userId),
      prizeLabel: String(row.prizeLabel ?? ''),
      prizeIndex: Number(row.prizeIndex ?? 0),
      rotationFinal: Number(row.rotationFinal ?? 0),
      source: String(row.source ?? 'roleta_page'),
      createdAt: row.createdAt,
    }))

    res.json({ ok: true, total: spins.length, spins })
  } catch (err) {
    console.error('[roleta-spins]', err)
    res.status(500).json({ ok: false, error: 'Erro ao carregar histórico da roleta.' })
  }
})

app.get('/api/community-links', async (_req, res) => {
  try {
    await pool.query(
      `
      CREATE TABLE IF NOT EXISTS community_links (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        whatsapp_group_url VARCHAR(500) NOT NULL,
        vip_group_url VARCHAR(500) NOT NULL DEFAULT '',
        manager_contact VARCHAR(255) NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id)
      )
      `
    )

    const [rows] = await pool.query<RowDataPacket[]>(
      `
      SELECT
        id,
        whatsapp_group_url AS whatsappGroupUrl,
        vip_group_url AS vipGroupUrl,
        manager_contact AS managerContact,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM community_links
      ORDER BY id DESC
      LIMIT 1
      `
    )

    if (rows.length === 0) {
      res.json({
        ok: true,
        links: {
          whatsappGroupUrl: '',
          vipGroupUrl: '',
          managerContact: '',
        },
      })
      return
    }

    res.json({
      ok: true,
      links: {
        id: Number(rows[0].id),
        whatsappGroupUrl: String(rows[0].whatsappGroupUrl ?? ''),
        vipGroupUrl: String(rows[0].vipGroupUrl ?? ''),
        managerContact: String(rows[0].managerContact ?? ''),
        createdAt: rows[0].createdAt,
        updatedAt: rows[0].updatedAt,
      },
    })
  } catch (err) {
    console.error('[community-links-get]', err)
    res.status(500).json({ ok: false, error: 'Erro ao carregar links da comunidade.' })
  }
})

app.post('/api/community-links', async (req, res) => {
  const { whatsappGroupUrl, vipGroupUrl, managerContact } = req.body as {
    whatsappGroupUrl?: string
    vipGroupUrl?: string
    managerContact?: string
  }

  const parsedWhatsappGroupUrl = String(whatsappGroupUrl ?? '').trim()
  const parsedVipGroupUrl = String(vipGroupUrl ?? '').trim()
  const parsedManagerContact = String(managerContact ?? '').trim()

  if (!parsedWhatsappGroupUrl) {
    res.status(400).json({ ok: false, error: 'Link do grupo do WhatsApp é obrigatório.' })
    return
  }

  if (!parsedManagerContact) {
    res.status(400).json({ ok: false, error: 'Contato do gerente é obrigatório.' })
    return
  }

  try {
    await pool.query(
      `
      CREATE TABLE IF NOT EXISTS community_links (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        whatsapp_group_url VARCHAR(500) NOT NULL,
        vip_group_url VARCHAR(500) NOT NULL DEFAULT '',
        manager_contact VARCHAR(255) NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id)
      )
      `
    )

    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM community_links ORDER BY id ASC LIMIT 1'
    )

    if (rows.length === 0) {
      await pool.query(
        `
        INSERT INTO community_links (whatsapp_group_url, vip_group_url, manager_contact)
        VALUES (?, ?, ?)
        `,
        [parsedWhatsappGroupUrl, parsedVipGroupUrl, parsedManagerContact]
      )
    } else {
      await pool.query(
        `
        UPDATE community_links
        SET
          whatsapp_group_url = ?,
          vip_group_url = ?,
          manager_contact = ?,
          updated_at = NOW()
        WHERE id = ?
        `,
        [parsedWhatsappGroupUrl, parsedVipGroupUrl, parsedManagerContact, Number(rows[0].id)]
      )
    }

    res.json({
      ok: true,
      message: 'Links da comunidade salvos com sucesso.',
      links: {
        whatsappGroupUrl: parsedWhatsappGroupUrl,
        vipGroupUrl: parsedVipGroupUrl,
        managerContact: parsedManagerContact,
      },
    })
  } catch (err) {
    console.error('[community-links-save]', err)
    res.status(500).json({ ok: false, error: 'Erro ao salvar links da comunidade.' })
  }
})

app.get('/api/transactions/paid/:userId', async (req, res) => {
  const userId = Number(req.params.userId)
  const from = String(req.query.from ?? '').trim()
  const to = String(req.query.to ?? '').trim()

  if (!userId || Number.isNaN(userId)) {
    res.status(400).json({ ok: false, error: 'ID de usuário inválido.' })
    return
  }

  const hasRange = Boolean(from && to)

  try {
    const [users] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM users WHERE id = ? LIMIT 1',
      [userId]
    )

    if (users.length === 0) {
      res.status(404).json({ ok: false, error: 'Usuário não encontrado.' })
      return
    }

    const [depositRows] = await pool.query<RowDataPacket[]>(
      `
      SELECT
        id,
        amount,
        method,
        status,
        created_at AS createdAt,
        paid_at AS paidAt,
        provider_transaction_id AS providerTransactionId
      FROM cashin_payments
      WHERE user_id = ?
        AND LOWER(status) IN ('paid', 'payment.paid')
        ${hasRange ? 'AND DATE(COALESCE(paid_at, created_at)) BETWEEN ? AND ?' : ''}
      ORDER BY COALESCE(paid_at, created_at) DESC, id DESC
      `,
      hasRange ? [userId, from, to] : [userId]
    )

    let withdrawRows: RowDataPacket[] = []
    try {
      const [rows] = await pool.query<RowDataPacket[]>(
        `
        SELECT
          id,
          amount,
          status,
          created_at AS createdAt,
          paid_at AS paidAt
        FROM withdrawals
        WHERE user_id = ?
          AND LOWER(status) IN ('paid', 'payment.paid')
          ${hasRange ? 'AND DATE(COALESCE(paid_at, created_at)) BETWEEN ? AND ?' : ''}
        ORDER BY COALESCE(paid_at, created_at) DESC, id DESC
        `,
        hasRange ? [userId, from, to] : [userId]
      )
      withdrawRows = rows
    } catch {
      withdrawRows = []
    }

    const deposits = depositRows.map((row) => ({
      id: Number(row.id),
      amount: Number(row.amount ?? 0),
      method: String(row.method ?? 'pix'),
      status: 'paid' as const,
      type: 'deposit' as const,
      paidAt: row.paidAt ?? row.createdAt ?? null,
      createdAt: row.createdAt ?? null,
      description: `Depósito ${String(row.method ?? 'pix').toUpperCase()} aprovado`,
      providerTransactionId: row.providerTransactionId ? String(row.providerTransactionId) : null,
    }))

    const withdrawals = withdrawRows.map((row) => ({
      id: Number(row.id),
      amount: Number(row.amount ?? 0),
      method: 'pix',
      status: 'paid' as const,
      type: 'withdraw' as const,
      paidAt: row.paidAt ?? row.createdAt ?? null,
      createdAt: row.createdAt ?? null,
      description: 'Saque aprovado',
      providerTransactionId: null as string | null,
    }))

    const transactions = [...deposits, ...withdrawals].sort((a, b) => {
      const aDate = new Date(String(a.paidAt ?? a.createdAt ?? 0)).getTime()
      const bDate = new Date(String(b.paidAt ?? b.createdAt ?? 0)).getTime()
      if (bDate !== aDate) return bDate - aDate
      return Number(b.id) - Number(a.id)
    })

    res.json({
      ok: true,
      userId,
      filters: {
        from: hasRange ? from : null,
        to: hasRange ? to : null,
      },
      total: transactions.length,
      transactions,
    })
  } catch (err) {
    console.error('[transactions-paid]', err)
    res.status(500).json({ ok: false, error: 'Erro ao carregar transações pagas.' })
  }
})

app.get('/api/earnings/records/:userId', async (req, res) => {
  const userId = Number(req.params.userId)

  if (!userId || Number.isNaN(userId)) {
    res.status(400).json({ ok: false, error: 'ID de usuário inválido.' })
    return
  }

  try {
    const [users] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM users WHERE id = ? LIMIT 1',
      [userId]
    )

    if (users.length === 0) {
      res.status(404).json({ ok: false, error: 'Usuário não encontrado.' })
      return
    }

    const [depositRows] = await pool.query<RowDataPacket[]>(
      `
      SELECT
        id,
        amount,
        status,
        method,
        created_at AS createdAt
      FROM cashin_payments
      WHERE user_id = ?
      ORDER BY id DESC
      `,
      [userId]
    )

    const normalizeStatus = (statusRaw: unknown): 'paid' | 'pending' | 'processing' | 'failed' => {
      const value = String(statusRaw ?? '').toLowerCase().trim()
      if (value === 'paid' || value === 'payment.paid') return 'paid'
      if (value === 'processing') return 'processing'
      if (value === 'failed' || value === 'canceled' || value === 'cancelled') return 'failed'
      return 'pending'
    }

    const deposits = depositRows.map((row) => ({
      id: Number(row.id),
      amount: Number(row.amount ?? 0),
      status: normalizeStatus(row.status),
      method: String(row.method ?? 'pix'),
      createdAt: row.createdAt,
      type: 'deposit' as const,
    }))

    let withdrawals: Array<{
      id: number
      amount: number
      status: 'paid' | 'pending' | 'processing' | 'failed'
      createdAt: unknown
      type: 'withdraw'
    }> = []

    try {
      const [withdrawRows] = await pool.query<RowDataPacket[]>(
        `
        SELECT
          id,
          amount,
          status,
          created_at AS createdAt
        FROM withdrawals
        WHERE user_id = ?
        ORDER BY id DESC
        `,
        [userId]
      )

      withdrawals = withdrawRows.map((row) => ({
        id: Number(row.id),
        amount: Number(row.amount ?? 0),
        status: normalizeStatus(row.status),
        createdAt: row.createdAt,
        type: 'withdraw' as const,
      }))
    } catch {
      withdrawals = []
    }

    const depositsPaid = deposits.filter((row) => row.status === 'paid')
    const depositsPending = deposits.filter((row) => row.status === 'pending')
    const withdrawalsPaid = withdrawals.filter((row) => row.status === 'paid')
    const withdrawalsPending = withdrawals.filter((row) => row.status === 'pending')

    res.json({
      ok: true,
      summary: {
        depositsPaid: Number(depositsPaid.reduce((sum, row) => sum + Number(row.amount ?? 0), 0).toFixed(2)),
        depositsPending: Number(depositsPending.reduce((sum, row) => sum + Number(row.amount ?? 0), 0).toFixed(2)),
        withdrawalsPaid: Number(withdrawalsPaid.reduce((sum, row) => sum + Number(row.amount ?? 0), 0).toFixed(2)),
        withdrawalsPending: Number(withdrawalsPending.reduce((sum, row) => sum + Number(row.amount ?? 0), 0).toFixed(2)),
      },
      records: {
        deposits,
        withdrawals,
      },
    })
  } catch (err) {
    console.error('[earnings-records]', err)
    res.status(500).json({ ok: false, error: 'Erro ao carregar registros de ganhos.' })
  }
})

app.get('/api/checkin/status/:userId', async (req, res) => {
  const userId = Number(req.params.userId)

  if (!userId || Number.isNaN(userId)) {
    res.status(400).json({ ok: false, error: 'ID de usuário inválido.' })
    return
  }

  const rewards = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]

  try {
    await pool.query(
      `
      CREATE TABLE IF NOT EXISTS daily_checkins (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id BIGINT UNSIGNED NOT NULL,
        checkin_day TINYINT UNSIGNED NOT NULL,
        reward_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        checkin_date DATE NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_daily_checkins_user_day (user_id, checkin_date),
        KEY idx_daily_checkins_user_id (user_id),
        KEY idx_daily_checkins_day (checkin_day)
      )
      `
    )

    const [users] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM users WHERE id = ? LIMIT 1',
      [userId]
    )

    if (users.length === 0) {
      res.status(404).json({ ok: false, error: 'Usuário não encontrado.' })
      return
    }

    const [todayRows] = await pool.query<RowDataPacket[]>(
      `
      SELECT id, checkin_day AS checkinDay, reward_amount AS rewardAmount, checkin_date AS checkinDate
      FROM daily_checkins
      WHERE user_id = ? AND checkin_date = CURDATE()
      LIMIT 1
      `,
      [userId]
    )

    const [lastRows] = await pool.query<RowDataPacket[]>(
      `
      SELECT checkin_day AS checkinDay, reward_amount AS rewardAmount, checkin_date AS checkinDate
      FROM daily_checkins
      WHERE user_id = ?
      ORDER BY id DESC
      LIMIT 10
      `,
      [userId]
    )

    const [latestRows] = await pool.query<RowDataPacket[]>(
      `
      SELECT checkin_day AS checkinDay
      FROM daily_checkins
      WHERE user_id = ?
      ORDER BY id DESC
      LIMIT 1
      `,
      [userId]
    )

    const latestDay = Number(latestRows[0]?.checkinDay ?? 0)
    const nextDay = latestDay >= 10 ? 1 : latestDay + 1
    const canClaim = todayRows.length === 0
    const currentDay = canClaim ? nextDay : Number(todayRows[0].checkinDay ?? nextDay)

    res.json({
      ok: true,
      canClaim,
      currentDay,
      claimedToday: todayRows.length > 0,
      todayClaim: todayRows.length > 0
        ? {
            day: Number(todayRows[0].checkinDay ?? 0),
            rewardAmount: Number(todayRows[0].rewardAmount ?? 0),
            checkinDate: todayRows[0].checkinDate,
          }
        : null,
      rewards,
      history: lastRows.map((row) => ({
        day: Number(row.checkinDay ?? 0),
        rewardAmount: Number(row.rewardAmount ?? 0),
        checkinDate: row.checkinDate,
      })),
    })
  } catch (err) {
    console.error('[checkin-status]', err)
    res.status(500).json({ ok: false, error: 'Erro ao carregar status do check-in.' })
  }
})

app.post('/api/checkin/claim', async (req, res) => {
  const { userId } = req.body as { userId?: number }
  const parsedUserId = Number(userId)

  if (!parsedUserId || Number.isNaN(parsedUserId)) {
    res.status(400).json({ ok: false, error: 'ID de usuário inválido.' })
    return
  }

  const rewards = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]
  const conn = await pool.getConnection()

  try {
    await conn.beginTransaction()

    await conn.query(
      `
      CREATE TABLE IF NOT EXISTS daily_checkins (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id BIGINT UNSIGNED NOT NULL,
        checkin_day TINYINT UNSIGNED NOT NULL,
        reward_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        checkin_date DATE NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_daily_checkins_user_day (user_id, checkin_date),
        KEY idx_daily_checkins_user_id (user_id),
        KEY idx_daily_checkins_day (checkin_day)
      )
      `
    )

    const [users] = await conn.query<RowDataPacket[]>(
      'SELECT id, balance FROM users WHERE id = ? LIMIT 1 FOR UPDATE',
      [parsedUserId]
    )

    if (users.length === 0) {
      await conn.rollback()
      res.status(404).json({ ok: false, error: 'Usuário não encontrado.' })
      return
    }

    const [todayRows] = await conn.query<RowDataPacket[]>(
      `
      SELECT id
      FROM daily_checkins
      WHERE user_id = ? AND checkin_date = CURDATE()
      LIMIT 1
      FOR UPDATE
      `,
      [parsedUserId]
    )

    if (todayRows.length > 0) {
      await conn.rollback()
      res.status(400).json({ ok: false, error: 'Check-in de hoje já foi resgatado.' })
      return
    }

    const [latestRows] = await conn.query<RowDataPacket[]>(
      `
      SELECT checkin_day AS checkinDay
      FROM daily_checkins
      WHERE user_id = ?
      ORDER BY id DESC
      LIMIT 1
      FOR UPDATE
      `,
      [parsedUserId]
    )

    const latestDay = Number(latestRows[0]?.checkinDay ?? 0)
    const checkinDay = latestDay >= 10 ? 1 : latestDay + 1
    const rewardAmount = Number(rewards[checkinDay - 1] ?? 2)

    const oldBalance = Number(users[0].balance ?? 0)

    const [checkinInsertResult] = await conn.query(
      `
      INSERT INTO daily_checkins (user_id, checkin_day, reward_amount, checkin_date)
      VALUES (?, ?, ?, CURDATE())
      `,
      [parsedUserId, checkinDay, rewardAmount]
    ) as any

    await conn.query(
      `
      UPDATE users
      SET balance = COALESCE(balance, 0) + ?
      WHERE id = ?
      `,
      [rewardAmount, parsedUserId]
    )

    const [updatedRows] = await conn.query<RowDataPacket[]>(
      'SELECT balance FROM users WHERE id = ? LIMIT 1',
      [parsedUserId]
    )

    const newBalance = Number(updatedRows[0]?.balance ?? oldBalance)

    await conn.query(
      `
      CREATE TABLE IF NOT EXISTS logs (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id BIGINT UNSIGNED NULL,
        entity_type VARCHAR(60) NOT NULL,
        entity_id BIGINT UNSIGNED NULL,
        action VARCHAR(100) NOT NULL,
        old_balance DECIMAL(12,2) NULL,
        new_balance DECIMAL(12,2) NULL,
        amount DECIMAL(12,2) NULL,
        metadata JSON NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_logs_user_id (user_id),
        KEY idx_logs_entity_type (entity_type),
        KEY idx_logs_entity_id (entity_id),
        KEY idx_logs_action (action),
        KEY idx_logs_created_at (created_at)
      )
      `
    )

    await conn.query(
      `
      INSERT INTO logs
      (
        user_id,
        entity_type,
        entity_id,
        action,
        old_balance,
        new_balance,
        amount,
        metadata
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        parsedUserId,
        'checkin',
        Number(checkinInsertResult?.insertId ?? 0),
        'daily_checkin_claimed',
        Number(oldBalance.toFixed(2)),
        Number(newBalance.toFixed(2)),
        Number(rewardAmount.toFixed(2)),
        JSON.stringify({
          checkinDay,
          checkinDate: new Date().toISOString(),
        }),
      ]
    )

    await conn.commit()

    res.json({
      ok: true,
      message: `Check-in do dia ${checkinDay} resgatado com sucesso!`,
      claim: {
        day: checkinDay,
        rewardAmount,
        checkinDate: new Date().toISOString(),
      },
      balance: Number(updatedRows[0]?.balance ?? 0),
    })
  } catch (err) {
    await conn.rollback()
    console.error('[checkin-claim]', err)
    res.status(500).json({ ok: false, error: 'Erro ao resgatar check-in.' })
  } finally {
    conn.release()
  }
})

app.get('/api/cycles/orders/:userId', async (req, res) => {
  const userId = Number(req.params.userId)

  if (!userId || Number.isNaN(userId)) {
    res.status(400).json({ ok: false, error: 'ID de usuário inválido.' })
    return
  }

  try {
    const [users] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM users WHERE id = ? LIMIT 1',
      [userId]
    )

    if (users.length === 0) {
      res.status(404).json({ ok: false, error: 'Usuário não encontrado.' })
      return
    }

    const [rows] = await pool.query<RowDataPacket[]>(
      `
      SELECT
        ucp.id,
        ucp.user_id AS userId,
        ucp.cycle_product_id AS cycleProductId,
        ucp.amount_paid AS amountPaid,
        ucp.expected_profit AS expectedProfit,
        ucp.cycle_days AS cycleDays,
        ucp.status,
        ucp.started_at AS startedAt,
        ucp.ends_at AS endsAt,
        cp.name AS productName
      FROM user_cycle_purchases ucp
      LEFT JOIN cycle_products cp ON cp.id = ucp.cycle_product_id
      WHERE ucp.user_id = ?
      ORDER BY ucp.id DESC
      `,
      [userId]
    )

    const now = new Date()

    const orders = rows.map((row) => {
      const endsAt = row.endsAt ? new Date(row.endsAt) : null
      const dbStatus = String(row.status ?? 'active')
      let uiStatus: 'ongoing' | 'completed' = 'ongoing'

      if (dbStatus === 'completed' || (endsAt && endsAt.getTime() < now.getTime())) {
        uiStatus = 'completed'
      }

      return {
        id: Number(row.id),
        userId: Number(row.userId),
        cycleProductId: Number(row.cycleProductId),
        productName: String(row.productName ?? 'Plano de ciclo'),
        amountPaid: Number(row.amountPaid ?? 0),
        expectedProfit: Number(row.expectedProfit ?? 0),
        cycleDays: Number(row.cycleDays ?? 0),
        status: dbStatus,
        uiStatus,
        startedAt: row.startedAt,
        endsAt: row.endsAt,
      }
    })

    res.json({
      ok: true,
      orders,
    })
  } catch (err) {
    console.error('[cycles-orders]', err)
    res.status(500).json({ ok: false, error: 'Erro ao carregar histórico de ciclos.' })
  }
})

app.get('/api/user/pix-key/:userId', async (req, res) => {
  const userId = Number(req.params.userId)

  if (!userId || Number.isNaN(userId)) {
    res.status(400).json({ ok: false, error: 'ID de usuário inválido.' })
    return
  }

  try {
    await pool.query(
      `
      CREATE TABLE IF NOT EXISTS user_pix_keys (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id BIGINT UNSIGNED NOT NULL,
        holder_name VARCHAR(150) NOT NULL,
        holder_cpf VARCHAR(20) NOT NULL,
        pix_key_type ENUM('CPF','CNPJ','EMAIL','TELEFONE','CHAVE_ALEATORIA') NOT NULL DEFAULT 'CHAVE_ALEATORIA',
        pix_key VARCHAR(255) NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_user_pix_keys_user_id (user_id),
        KEY idx_user_pix_keys_pix_key_type (pix_key_type)
      )
      `
    )

    const [users] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM users WHERE id = ? LIMIT 1',
      [userId]
    )

    if (users.length === 0) {
      res.status(404).json({ ok: false, error: 'Usuário não encontrado.' })
      return
    }

    const [rows] = await pool.query<RowDataPacket[]>(
      `
      SELECT
        user_id AS userId,
        holder_name AS holderName,
        holder_cpf AS holderCpf,
        pix_key_type AS pixKeyType,
        pix_key AS pixKey
      FROM user_pix_keys
      WHERE user_id = ?
      LIMIT 1
      `,
      [userId]
    )

    if (rows.length === 0) {
      res.json({ ok: true, hasPixKey: false, pixKey: null })
      return
    }

    res.json({
      ok: true,
      hasPixKey: true,
      pixKey: {
        userId: Number(rows[0].userId),
        holderName: String(rows[0].holderName ?? ''),
        holderCpf: String(rows[0].holderCpf ?? ''),
        pixKeyType: String(rows[0].pixKeyType ?? 'CHAVE_ALEATORIA'),
        pixKey: String(rows[0].pixKey ?? ''),
      },
    })
  } catch (err) {
    console.error('[pix-key-get]', err)
    res.status(500).json({ ok: false, error: 'Erro ao carregar chave PIX.' })
  }
})

app.post('/api/user/pix-key', async (req, res) => {
  const { userId, holderName, holderCpf, pixKeyType, pixKey } = req.body as {
    userId?: number
    holderName?: string
    holderCpf?: string
    pixKeyType?: string
    pixKey?: string
  }

  const parsedUserId = Number(userId)
  if (!parsedUserId || Number.isNaN(parsedUserId)) {
    res.status(400).json({ ok: false, error: 'ID de usuário inválido.' })
    return
  }

  const parsedHolderName = String(holderName ?? '').trim()
  const parsedHolderCpf = String(holderCpf ?? '').replace(/\D/g, '')
  const parsedPixType = normalizePixType(String(pixKeyType ?? ''))
  const parsedPixKey = normalizePixKey(String(pixKey ?? ''), parsedPixType)

  if (!parsedHolderName) {
    res.status(400).json({ ok: false, error: 'Nome do titular é obrigatório.' })
    return
  }

  if (!parsedHolderCpf || parsedHolderCpf.length !== 11) {
    res.status(400).json({ ok: false, error: 'CPF do titular inválido.' })
    return
  }

  if (!parsedPixKey) {
    res.status(400).json({ ok: false, error: 'Chave PIX é obrigatória.' })
    return
  }

  try {
    await pool.query(
      `
      CREATE TABLE IF NOT EXISTS user_pix_keys (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id BIGINT UNSIGNED NOT NULL,
        holder_name VARCHAR(150) NOT NULL,
        holder_cpf VARCHAR(20) NOT NULL,
        pix_key_type ENUM('CPF','CNPJ','EMAIL','TELEFONE','CHAVE_ALEATORIA') NOT NULL DEFAULT 'CHAVE_ALEATORIA',
        pix_key VARCHAR(255) NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_user_pix_keys_user_id (user_id),
        KEY idx_user_pix_keys_pix_key_type (pix_key_type)
      )
      `
    )

    const [users] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM users WHERE id = ? LIMIT 1',
      [parsedUserId]
    )

    if (users.length === 0) {
      res.status(404).json({ ok: false, error: 'Usuário não encontrado.' })
      return
    }

    await pool.query(
      `
      INSERT INTO user_pix_keys (user_id, holder_name, holder_cpf, pix_key_type, pix_key)
      VALUES (?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        holder_name = VALUES(holder_name),
        holder_cpf = VALUES(holder_cpf),
        pix_key_type = VALUES(pix_key_type),
        pix_key = VALUES(pix_key),
        updated_at = NOW()
      `,
      [parsedUserId, parsedHolderName, parsedHolderCpf, parsedPixType, parsedPixKey]
    )

    res.json({
      ok: true,
      message: 'Chave PIX salva com sucesso.',
      pixKey: {
        userId: parsedUserId,
        holderName: parsedHolderName,
        holderCpf: parsedHolderCpf,
        pixKeyType: parsedPixType,
        pixKey: parsedPixKey,
      },
    })
  } catch (err) {
    console.error('[pix-key-save]', err)
    res.status(500).json({ ok: false, error: 'Erro ao salvar chave PIX.' })
  }
})

app.get('/api/user/withdraw-password/status/:userId', async (req, res) => {
  const userId = Number(req.params.userId)

  if (!userId || Number.isNaN(userId)) {
    res.status(400).json({ ok: false, error: 'ID de usuário inválido.' })
    return
  }

  try {
    await pool.query(
      `
      ALTER TABLE users
      ADD COLUMN withdraw_password VARCHAR(255) NULL
      `
    )
  } catch {
    // Coluna já existe
  }

  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `
      SELECT id, withdraw_password AS withdrawPassword
      FROM users
      WHERE id = ?
      LIMIT 1
      `,
      [userId]
    )

    if (rows.length === 0) {
      res.status(404).json({ ok: false, error: 'Usuário não encontrado.' })
      return
    }

    const hasWithdrawPassword = Boolean(String(rows[0].withdrawPassword ?? '').trim())

    res.json({
      ok: true,
      userId,
      hasWithdrawPassword,
    })
  } catch (err) {
    console.error('[withdraw-password-status]', err)
    res.status(500).json({ ok: false, error: 'Erro ao consultar status da senha de saque.' })
  }
})

app.post('/api/user/withdraw-password', async (req, res) => {
  const { userId, password } = req.body as { userId?: number; password?: string }

  const parsedUserId = Number(userId)
  const parsedPassword = String(password ?? '').trim()

  if (!parsedUserId || Number.isNaN(parsedUserId)) {
    res.status(400).json({ ok: false, error: 'ID de usuário inválido.' })
    return
  }

  if (!parsedPassword || parsedPassword.length < 6) {
    res.status(400).json({ ok: false, error: 'A senha de saque deve ter no mínimo 6 caracteres.' })
    return
  }

  try {
    await pool.query(
      `
      ALTER TABLE users
      ADD COLUMN withdraw_password VARCHAR(255) NULL
      `
    )
  } catch {
    // Coluna já existe
  }

  try {
    const [users] = await pool.query<RowDataPacket[]>(
      'SELECT id, password FROM users WHERE id = ? LIMIT 1',
      [parsedUserId]
    )

    if (users.length === 0) {
      res.status(404).json({ ok: false, error: 'Usuário não encontrado.' })
      return
    }

    const isSameAsLoginPassword = await bcrypt.compare(parsedPassword, String(users[0].password ?? ''))
    if (isSameAsLoginPassword) {
      res.status(400).json({ ok: false, error: 'A senha de saque não pode ser igual à senha de login.' })
      return
    }

    const passwordHash = await bcrypt.hash(parsedPassword, 10)

    await pool.query(
      `
      UPDATE users
      SET withdraw_password = ?
      WHERE id = ?
      `,
      [passwordHash, parsedUserId]
    )

    await pool.query(
      `
      CREATE TABLE IF NOT EXISTS logs (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id BIGINT UNSIGNED NULL,
        entity_type VARCHAR(60) NOT NULL,
        entity_id BIGINT UNSIGNED NULL,
        action VARCHAR(100) NOT NULL,
        old_balance DECIMAL(12,2) NULL,
        new_balance DECIMAL(12,2) NULL,
        amount DECIMAL(12,2) NULL,
        metadata JSON NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_logs_user_id (user_id),
        KEY idx_logs_entity_type (entity_type),
        KEY idx_logs_entity_id (entity_id),
        KEY idx_logs_action (action),
        KEY idx_logs_created_at (created_at)
      )
      `
    )

    await pool.query(
      `
      INSERT INTO logs
      (
        user_id,
        entity_type,
        entity_id,
        action,
        metadata
      )
      VALUES (?, ?, ?, ?, ?)
      `,
      [
        parsedUserId,
        'user',
        parsedUserId,
        'withdraw_password_changed',
        JSON.stringify({
          source: 'user_withdraw_password',
          changedAt: new Date().toISOString(),
        }),
      ]
    )

    res.json({
      ok: true,
      message: 'Senha de saque salva com sucesso.',
    })
  } catch (err) {
    console.error('[withdraw-password-save]', err)
    res.status(500).json({ ok: false, error: 'Erro ao salvar senha de saque.' })
  }
})

app.post('/api/user/change-password', async (req, res) => {
  const { userId, currentPassword, newPassword } = req.body as {
    userId?: number
    currentPassword?: string
    newPassword?: string
  }

  const parsedUserId = Number(userId)
  const parsedCurrentPassword = String(currentPassword ?? '').trim()
  const parsedNewPassword = String(newPassword ?? '').trim()

  if (!parsedUserId || Number.isNaN(parsedUserId)) {
    res.status(400).json({ ok: false, error: 'ID de usuário inválido.' })
    return
  }

  if (!parsedCurrentPassword) {
    res.status(400).json({ ok: false, error: 'Senha atual é obrigatória.' })
    return
  }

  if (!parsedNewPassword || parsedNewPassword.length < 6) {
    res.status(400).json({ ok: false, error: 'A nova senha deve ter no mínimo 6 caracteres.' })
    return
  }

  try {
    const [users] = await pool.query<RowDataPacket[]>(
      'SELECT id, password FROM users WHERE id = ? LIMIT 1',
      [parsedUserId]
    )

    if (users.length === 0) {
      res.status(404).json({ ok: false, error: 'Usuário não encontrado.' })
      return
    }

    const currentHash = String(users[0].password ?? '')
    const validCurrentPassword = await bcrypt.compare(parsedCurrentPassword, currentHash)
    if (!validCurrentPassword) {
      res.status(401).json({ ok: false, error: 'Senha atual incorreta.' })
      return
    }

    const isSamePassword = await bcrypt.compare(parsedNewPassword, currentHash)
    if (isSamePassword) {
      res.status(400).json({ ok: false, error: 'A nova senha não pode ser igual à senha atual.' })
      return
    }

    const newPasswordHash = await bcrypt.hash(parsedNewPassword, 10)

    await pool.query(
      `
      UPDATE users
      SET password = ?
      WHERE id = ?
      `,
      [newPasswordHash, parsedUserId]
    )

    await pool.query(
      `
      CREATE TABLE IF NOT EXISTS logs (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id BIGINT UNSIGNED NULL,
        entity_type VARCHAR(60) NOT NULL,
        entity_id BIGINT UNSIGNED NULL,
        action VARCHAR(100) NOT NULL,
        old_balance DECIMAL(12,2) NULL,
        new_balance DECIMAL(12,2) NULL,
        amount DECIMAL(12,2) NULL,
        metadata JSON NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_logs_user_id (user_id),
        KEY idx_logs_entity_type (entity_type),
        KEY idx_logs_entity_id (entity_id),
        KEY idx_logs_action (action),
        KEY idx_logs_created_at (created_at)
      )
      `
    )

    await pool.query(
      `
      INSERT INTO logs
      (
        user_id,
        entity_type,
        entity_id,
        action,
        metadata
      )
      VALUES (?, ?, ?, ?, ?)
      `,
      [
        parsedUserId,
        'user',
        parsedUserId,
        'login_password_changed',
        JSON.stringify({
          source: 'profile_change_password',
          changedAt: new Date().toISOString(),
        }),
      ]
    )

    res.json({
      ok: true,
      message: 'Senha de login alterada com sucesso.',
    })
  } catch (err) {
    console.error('[user-change-password]', err)
    res.status(500).json({ ok: false, error: 'Erro ao alterar senha de login.' })
  }
})

app.post('/api/withdraw/request', async (req, res) => {
  const { userId, amount, withdrawPassword } = req.body as {
    userId?: number
    amount?: number | string
    withdrawPassword?: string
  }

  const parsedUserId = Number(userId)
  const parsedAmount = Number(String(amount ?? '').replace(',', '.'))
  const parsedPassword = String(withdrawPassword ?? '').trim()

  if (!parsedUserId || Number.isNaN(parsedUserId)) {
    res.status(400).json({ ok: false, error: 'ID de usuário inválido.' })
    return
  }

  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    res.status(400).json({ ok: false, error: 'Informe um valor de saque válido.' })
    return
  }

  if (!parsedPassword || parsedPassword.length < 6) {
    res.status(400).json({ ok: false, error: 'Senha de saque inválida.' })
    return
  }

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    await conn.query(
      `
      CREATE TABLE IF NOT EXISTS withdrawals (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id BIGINT UNSIGNED NOT NULL,
        amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        holder_name VARCHAR(150) NOT NULL,
        holder_cpf VARCHAR(20) NOT NULL,
        pix_key_type ENUM('CPF','CNPJ','EMAIL','TELEFONE','CHAVE_ALEATORIA') NOT NULL DEFAULT 'CHAVE_ALEATORIA',
        pix_key VARCHAR(255) NOT NULL,
        provider_transaction_id VARCHAR(255) NULL,
        external_id VARCHAR(255) NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'pending',
        provider_payload JSON NULL,
        paid_at DATETIME NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_withdrawals_user_id (user_id),
        KEY idx_withdrawals_status (status),
        KEY idx_withdrawals_user_created_at (user_id, created_at),
        UNIQUE KEY uq_withdrawals_provider_transaction_id (provider_transaction_id)
      )
      `
    )

    const [users] = await conn.query<RowDataPacket[]>(
      `
      SELECT id, balance, withdraw_password AS withdrawPassword
      FROM users
      WHERE id = ?
      LIMIT 1
      FOR UPDATE
      `,
      [parsedUserId]
    )

    if (users.length === 0) {
      await conn.rollback()
      res.status(404).json({ ok: false, error: 'Usuário não encontrado.' })
      return
    }

    const hasWithdrawPassword = Boolean(String(users[0].withdrawPassword ?? '').trim())
    if (!hasWithdrawPassword) {
      await conn.rollback()
      res.status(400).json({ ok: false, error: 'Cadastre sua senha de saque antes de solicitar.' })
      return
    }

    const validPassword = await bcrypt.compare(parsedPassword, String(users[0].withdrawPassword ?? ''))
    if (!validPassword) {
      await conn.rollback()
      res.status(401).json({ ok: false, error: 'Senha de saque incorreta.' })
      return
    }

    const [todayRows] = await conn.query<RowDataPacket[]>(
      `
      SELECT id
      FROM withdrawals
      WHERE user_id = ?
        AND DATE(created_at) = CURDATE()
      LIMIT 1
      FOR UPDATE
      `,
      [parsedUserId]
    )

    if (todayRows.length > 0) {
      await conn.rollback()
      res.status(400).json({ ok: false, error: 'Você já solicitou um saque hoje. Tente novamente amanhã.' })
      return
    }

    const [pixRows] = await conn.query<RowDataPacket[]>(
      `
      SELECT
        holder_name AS holderName,
        holder_cpf AS holderCpf,
        pix_key_type AS pixKeyType,
        pix_key AS pixKey
      FROM user_pix_keys
      WHERE user_id = ?
      LIMIT 1
      FOR UPDATE
      `,
      [parsedUserId]
    )

    if (pixRows.length === 0) {
      await conn.rollback()
      res.status(400).json({ ok: false, error: 'Cadastre uma chave PIX antes de solicitar saque.' })
      return
    }

    const holderName = String(pixRows[0].holderName ?? '').trim()
    const holderCpf = String(pixRows[0].holderCpf ?? '').replace(/\D/g, '')
    const pixKeyType = normalizePixType(String(pixRows[0].pixKeyType ?? 'CHAVE_ALEATORIA'))
    const pixKey = normalizePixKey(String(pixRows[0].pixKey ?? ''), pixKeyType)
    const currentBalance = Number(users[0].balance ?? 0)

    if (!holderName || holderCpf.length !== 11 || !pixKey) {
      await conn.rollback()
      res.status(400).json({ ok: false, error: 'Dados PIX inválidos. Atualize sua chave PIX.' })
      return
    }

    if (currentBalance < parsedAmount) {
      await conn.rollback()
      res.status(400).json({
        ok: false,
        error: 'Saldo insuficiente para saque.',
        required: parsedAmount,
        available: currentBalance,
      })
      return
    }

    await conn.query(
      `
      CREATE TABLE IF NOT EXISTS logs (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id BIGINT UNSIGNED NULL,
        entity_type VARCHAR(60) NOT NULL,
        entity_id BIGINT UNSIGNED NULL,
        action VARCHAR(100) NOT NULL,
        old_balance DECIMAL(12,2) NULL,
        new_balance DECIMAL(12,2) NULL,
        amount DECIMAL(12,2) NULL,
        metadata JSON NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_logs_user_id (user_id),
        KEY idx_logs_entity_type (entity_type),
        KEY idx_logs_entity_id (entity_id),
        KEY idx_logs_action (action),
        KEY idx_logs_created_at (created_at)
      )
      `
    )

    await conn.query(
      `
      CREATE TABLE IF NOT EXISTS system_withdraw_config (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        withdraw_fee_percent DECIMAL(8,2) NOT NULL DEFAULT 0.00,
        min_withdraw_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        max_withdraw_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        withdraw_auto_approve TINYINT(1) NOT NULL DEFAULT 0,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id)
      )
      `
    )

    try {
      await conn.query(
        `
        ALTER TABLE system_withdraw_config
        ADD COLUMN withdraw_auto_approve TINYINT(1) NOT NULL DEFAULT 0
        `
      )
    } catch {
      // coluna já existe
    }

    const [configRows] = await conn.query<RowDataPacket[]>(
      `
      SELECT withdraw_auto_approve AS withdrawAutoApprove
      FROM system_withdraw_config
      ORDER BY id ASC
      LIMIT 1
      `
    )

    const shouldAutoApprove = Number(configRows[0]?.withdrawAutoApprove ?? 0) === 1

    const oldBalance = Number(currentBalance.toFixed(2))
    const newBalance = Number((oldBalance - parsedAmount).toFixed(2))

    await conn.query(
      `
      UPDATE users
      SET balance = ?
      WHERE id = ?
      `,
      [newBalance, parsedUserId]
    )

    const externalId = `WD-${Date.now()}-${parsedUserId}`
    let withdrawStatus: 'pending' | 'processing' | 'paid' | 'failed' = 'pending'
    let providerTransactionId: string | null = null
    let providerPayload: any = null

    if (shouldAutoApprove) {
      const lumopayPixType = mapPixTypeToLumopay(pixKeyType)
      const lumopayPixKey = normalizeLumopayPixKey(pixKey, lumopayPixType)

      const cashoutPayload = {
        amount: Number(parsedAmount.toFixed(2)),
        pixKey: lumopayPixKey,
        pixKeyType: lumopayPixType,
        description: `Saque PIX auto #${externalId}`,
      }

      const providerRes = await fetch(LUMOPAY_TRANSFER_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': LUMO_API_KEY,
        },
        body: JSON.stringify(cashoutPayload),
      })

      providerPayload = await providerRes.json().catch(() => ({}))

      if (!providerRes.ok || providerPayload?.success === false) {
        throw new Error(String(providerPayload?.message ?? providerPayload?.error ?? 'Falha ao processar saque automático na Lumopay.'))
      }

      providerTransactionId =
        String(
          providerPayload?.data?.external_id ??
          providerPayload?.data?.transaction_id ??
          providerPayload?.transaction_id ??
          providerPayload?.idTransaction ??
          ''
        ).trim() || null

      const providerStatusRaw = String(
        providerPayload?.data?.status ??
        providerPayload?.status ??
        'processing'
      ).toLowerCase()

      withdrawStatus =
        providerStatusRaw === 'paid' || providerStatusRaw === 'payment.paid'
          ? 'paid'
          : providerStatusRaw === 'failed' || providerStatusRaw === 'canceled' || providerStatusRaw === 'cancelled'
            ? 'failed'
            : 'processing'
    }

    const [insertResult] = await conn.query(
      `
      INSERT INTO withdrawals
      (
        user_id,
        amount,
        holder_name,
        holder_cpf,
        pix_key_type,
        pix_key,
        provider_transaction_id,
        status,
        external_id,
        provider_payload,
        paid_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        parsedUserId,
        Number(parsedAmount.toFixed(2)),
        holderName,
        holderCpf,
        pixKeyType,
        pixKey,
        providerTransactionId,
        withdrawStatus,
        externalId,
        providerPayload ? JSON.stringify(providerPayload) : null,
        withdrawStatus === 'paid' ? new Date() : null,
      ]
    ) as any

    await conn.query(
      `
      INSERT INTO logs
      (
        user_id,
        entity_type,
        entity_id,
        action,
        old_balance,
        new_balance,
        amount,
        metadata
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        parsedUserId,
        'withdrawal',
        Number(insertResult?.insertId ?? 0),
        shouldAutoApprove ? 'withdraw_request_auto_processed' : 'withdraw_request_created',
        oldBalance,
        newBalance,
        Number(parsedAmount.toFixed(2)),
        JSON.stringify({
          status: withdrawStatus,
          externalId,
          autoApprove: shouldAutoApprove,
          providerTransactionId,
        }),
      ]
    )

    await conn.commit()

    res.json({
      ok: true,
      message: shouldAutoApprove
        ? 'Solicitação de saque enviada e processada automaticamente.'
        : 'Solicitação de saque enviada com sucesso.',
      withdraw: {
        id: Number(insertResult?.insertId ?? 0),
        amount: Number(parsedAmount.toFixed(2)),
        status: withdrawStatus,
        transactionId: providerTransactionId,
        externalId,
        autoApprove: shouldAutoApprove,
      },
    })
  } catch (err) {
    await conn.rollback()
    console.error('[withdraw-request]', err)
    res.status(500).json({ ok: false, error: 'Erro ao solicitar saque.' })
  } finally {
    conn.release()
  }
})

app.post('/api/withdraw/webhook', async (req, res) => {
  const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? 'ip-desconhecido')
  const payload = (req.body ?? {}) as {
    status?: string
    amount?: number | string
    pixKey?: string
    idtransaction?: string
    idTransaction?: string
    transactionId?: string
    providerTransactionId?: string
    externalId?: string
    id?: string
    data?: {
      status?: string
      amount?: number | string
      pix_key?: string
      transaction_id?: string
      external_id?: string
      id?: string
    }
  }

  try {
    await pool.query(
      `
      CREATE TABLE IF NOT EXISTS withdrawals (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id BIGINT UNSIGNED NOT NULL,
        amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        holder_name VARCHAR(150) NOT NULL,
        holder_cpf VARCHAR(20) NOT NULL,
        pix_key_type ENUM('CPF','CNPJ','EMAIL','TELEFONE','CHAVE_ALEATORIA') NOT NULL DEFAULT 'CHAVE_ALEATORIA',
        pix_key VARCHAR(255) NOT NULL,
        provider_transaction_id VARCHAR(255) NULL,
        external_id VARCHAR(255) NULL,
        status VARCHAR(50) NOT NULL DEFAULT 'pending',
        provider_payload JSON NULL,
        paid_at DATETIME NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_withdrawals_user_id (user_id),
        KEY idx_withdrawals_status (status),
        UNIQUE KEY uq_withdrawals_provider_transaction_id (provider_transaction_id)
      )
      `
    )

    const statusOriginal = String(payload?.status ?? payload?.data?.status ?? '').trim()
    if (!statusOriginal) {
      console.error('[withdraw-webhook] payload inválido sem status', { ip, payload })
      res.status(400).json({ ok: false, error: 'Dados inválidos ou incompletos (status).' })
      return
    }

    const statusUpper = statusOriginal.toUpperCase()
    const normalizedStatus =
      statusUpper === 'COMPLETED' || statusUpper === 'PAID' || statusUpper === 'PAYMENT.PAID'
        ? 'paid'
        : statusUpper === 'CANCELLED' || statusUpper === 'CANCELED' || statusUpper === 'FAILED' || statusUpper === 'REJECTED'
          ? 'failed'
          : statusUpper === 'PROCESSING'
            ? 'processing'
            : 'pending'

    const amountRaw = Number(String(payload?.amount ?? payload?.data?.amount ?? '').replace(',', '.'))
    const amount = Number.isFinite(amountRaw) ? Number(Math.abs(amountRaw).toFixed(2)) : null
    const pixKey = String(payload?.pixKey ?? payload?.data?.pix_key ?? '').trim() || null

    const providerTransactionId = String(
      payload?.providerTransactionId ??
      payload?.transactionId ??
      payload?.idtransaction ??
      payload?.idTransaction ??
      payload?.id ??
      payload?.data?.transaction_id ??
      payload?.data?.id ??
      ''
    ).trim() || null

    const externalId = String(payload?.externalId ?? payload?.data?.external_id ?? '').trim() || null

    console.log('[withdraw-webhook] recebido', {
      ip,
      statusOriginal,
      normalizedStatus,
      amount,
      pixKey,
      providerTransactionId,
      externalId,
    })

    let foundWithdrawal: RowDataPacket | null = null
    let matchStrategy = 'none'

    if (providerTransactionId) {
      const [rowsByProviderId] = await pool.query<RowDataPacket[]>(
        `
        SELECT id, user_id AS userId, amount, status, pix_key AS pixKey
        FROM withdrawals
        WHERE provider_transaction_id = ?
        ORDER BY id DESC
        LIMIT 1
        `,
        [providerTransactionId]
      )
      if (rowsByProviderId.length > 0) {
        foundWithdrawal = rowsByProviderId[0]
        matchStrategy = 'provider_transaction_id'
      }
    }

    if (!foundWithdrawal && externalId) {
      const [rowsByExternalId] = await pool.query<RowDataPacket[]>(
        `
        SELECT id, user_id AS userId, amount, status, pix_key AS pixKey
        FROM withdrawals
        WHERE external_id = ?
        ORDER BY id DESC
        LIMIT 1
        `,
        [externalId]
      )
      if (rowsByExternalId.length > 0) {
        foundWithdrawal = rowsByExternalId[0]
        matchStrategy = 'external_id'
      }
    }

    if (!foundWithdrawal && pixKey) {
      const [rowsByPix] = await pool.query<RowDataPacket[]>(
        `
        SELECT id, user_id AS userId, amount, status, pix_key AS pixKey
        FROM withdrawals
        WHERE pix_key = ?
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [pixKey]
      )
      if (rowsByPix.length > 0) {
        foundWithdrawal = rowsByPix[0]
        matchStrategy = 'pix_key'
      }
    }

    if (!foundWithdrawal && amount != null) {
      const [rowsByAmount] = await pool.query<RowDataPacket[]>(
        `
        SELECT id, user_id AS userId, amount, status, pix_key AS pixKey
        FROM withdrawals
        WHERE ABS(amount - ?) < 1.0
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [amount]
      )
      if (rowsByAmount.length > 0) {
        foundWithdrawal = rowsByAmount[0]
        matchStrategy = 'amount_approx'
      }
    }

    if (!foundWithdrawal) {
      const [rowsMostRecent] = await pool.query<RowDataPacket[]>(
        `
        SELECT id, user_id AS userId, amount, status, pix_key AS pixKey
        FROM withdrawals
        ORDER BY created_at DESC
        LIMIT 1
        `
      )
      if (rowsMostRecent.length > 0) {
        foundWithdrawal = rowsMostRecent[0]
        matchStrategy = 'most_recent'
      }
    }

    if (!foundWithdrawal) {
      console.error('[withdraw-webhook] saque não encontrado', {
        ip,
        statusOriginal,
        amount,
        pixKey,
        providerTransactionId,
        externalId,
      })
      res.status(404).json({ ok: false, error: 'Saque não encontrado com os dados fornecidos.' })
      return
    }

    const withdrawalId = Number(foundWithdrawal.id)
    const userId = Number(foundWithdrawal.userId)
    const currentStatus = String(foundWithdrawal.status ?? '').toLowerCase()
    const withdrawalAmount = Number(foundWithdrawal.amount ?? 0)

    console.log('[withdraw-webhook] saque encontrado', {
      matchStrategy,
      withdrawalId,
      userId,
      currentStatus,
      withdrawalAmount,
    })

    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()

      await conn.query(
        `
        UPDATE withdrawals
        SET
          status = ?,
          provider_transaction_id = COALESCE(?, provider_transaction_id),
          external_id = COALESCE(?, external_id),
          provider_payload = ?,
          paid_at = CASE WHEN ? = 'paid' AND paid_at IS NULL THEN NOW() ELSE paid_at END,
          updated_at = NOW()
        WHERE id = ?
        `,
        [
          normalizedStatus,
          providerTransactionId,
          externalId,
          JSON.stringify({
            source: 'withdraw_webhook_legacy_compat',
            ip,
            matchStrategy,
            payload,
          }),
          normalizedStatus,
          withdrawalId,
        ]
      )

      const shouldRefund =
        normalizedStatus === 'failed' &&
        currentStatus !== 'failed' &&
        currentStatus !== 'cancelled' &&
        currentStatus !== 'canceled' &&
        withdrawalAmount > 0 &&
        userId > 0

      if (shouldRefund) {
        await conn.query(
          `
          UPDATE users
          SET balance = COALESCE(balance, 0) + ?
          WHERE id = ?
          `,
          [withdrawalAmount, userId]
        )
        console.log('[withdraw-webhook] estorno realizado', {
          withdrawalId,
          userId,
          refundAmount: withdrawalAmount,
          refundRule: '100%',
        })
      }

      await conn.commit()

      console.log('[withdraw-webhook] atualizado com sucesso', {
        withdrawalId,
        previousStatus: currentStatus,
        newStatus: normalizedStatus,
        providerTransactionId,
        externalId,
        matchStrategy,
      })

      res.json({
        ok: true,
        message: 'Webhook de saque processado com sucesso.',
        withdrawal: {
          id: withdrawalId,
          previousStatus: currentStatus,
          newStatus: normalizedStatus,
          matchStrategy,
        },
        refunded: shouldRefund,
      })
    } catch (err) {
      await conn.rollback()
      throw err
    } finally {
      conn.release()
    }
  } catch (err) {
    console.error('[withdraw-webhook]', err)
    res.status(500).json({ ok: false, error: 'Erro ao processar webhook de saque.' })
  }
})

const ensureGiftVoucherTables = async () => {
  await pool.query(
    `
    CREATE TABLE IF NOT EXISTS gift_vouchers (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      name VARCHAR(150) NOT NULL,
      description TEXT NULL,
      image_url VARCHAR(500) NULL,
      price DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      discount_coupon VARCHAR(80) NOT NULL,
      redeem_reward_value DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_gift_vouchers_discount_coupon (discount_coupon),
      KEY idx_gift_vouchers_active (is_active)
    )
    `
  )

  await pool.query(
    `
    CREATE TABLE IF NOT EXISTS gift_voucher_purchases (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id BIGINT UNSIGNED NOT NULL,
      gift_voucher_id BIGINT UNSIGNED NOT NULL,
      paid_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      discount_coupon VARCHAR(80) NOT NULL,
      redeem_reward_value DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      generated_gift_code VARCHAR(50) NULL,
      generated_gift_code_id BIGINT UNSIGNED NULL,
      status ENUM('paid','cancelled') NOT NULL DEFAULT 'paid',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_gift_voucher_purchases_user (user_id),
      KEY idx_gift_voucher_purchases_voucher (gift_voucher_id),
      KEY idx_gift_voucher_purchases_generated_code_id (generated_gift_code_id)
    )
    `
  )

  const tryAlter = async (sql: string) => {
    try {
      await pool.query(sql)
    } catch {
      // já existe
    }
  }

  await tryAlter(`
    ALTER TABLE gift_voucher_purchases
    ADD COLUMN generated_gift_code VARCHAR(50) NULL
  `)

  await tryAlter(`
    ALTER TABLE gift_voucher_purchases
    ADD COLUMN generated_gift_code_id BIGINT UNSIGNED NULL
  `)
}

const ensureGiftCodeTables = async () => {
  await pool.query(
    `
    CREATE TABLE IF NOT EXISTS gift_codes (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      code VARCHAR(50) NOT NULL,
      reward_type VARCHAR(50) NOT NULL DEFAULT 'balance_credit',
      reward_value DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      max_total_uses INT NOT NULL DEFAULT 1,
      used_count INT NOT NULL DEFAULT 0,
      notes VARCHAR(255) NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      starts_at DATETIME NULL,
      expires_at DATETIME NULL,
      created_by_user_id BIGINT UNSIGNED NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_gift_codes_code (code),
      KEY idx_gift_codes_active (is_active),
      KEY idx_gift_codes_expires (expires_at)
    )
    `
  )

  await pool.query(
    `
    CREATE TABLE IF NOT EXISTS gift_code_redemptions (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      gift_code_id BIGINT UNSIGNED NOT NULL,
      user_id BIGINT UNSIGNED NOT NULL,
      reward_type VARCHAR(50) NOT NULL DEFAULT 'balance_credit',
      reward_value DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      reward_applied TINYINT(1) NOT NULL DEFAULT 0,
      metadata JSON NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_gift_code_redemption_once (gift_code_id, user_id),
      KEY idx_gift_code_redemptions_user (user_id),
      KEY idx_gift_code_redemptions_code (gift_code_id)
    )
    `
  )

  const tryAlter = async (sql: string) => {
    try {
      await pool.query(sql)
    } catch (err: any) {
      const msg = String(err?.message ?? '').toLowerCase()
      const code = String(err?.code ?? '')
      const ignorable =
        code === 'ER_DUP_FIELDNAME' ||
        code === 'ER_BAD_FIELD_ERROR' ||
        code === 'ER_CANT_DROP_FIELD_OR_KEY' ||
        msg.includes('duplicate column name') ||
        msg.includes('already exists') ||
        msg.includes('check that column/key exists')
      if (!ignorable) throw err
    }
  }

  await tryAlter(`
    ALTER TABLE gift_codes
    ADD COLUMN starts_at DATETIME NULL
  `)

  await tryAlter(`
    ALTER TABLE gift_codes
    ADD COLUMN expires_at DATETIME NULL
  `)

  await tryAlter(`
    ALTER TABLE gift_codes
    ADD COLUMN created_by_user_id BIGINT UNSIGNED NULL
  `)

  await tryAlter(`
    ALTER TABLE gift_codes
    ADD COLUMN notes VARCHAR(255) NULL
  `)

  await tryAlter(`
    ALTER TABLE gift_codes
    MODIFY COLUMN reward_type VARCHAR(50) NOT NULL DEFAULT 'balance_credit'
  `)

  await tryAlter(`
    ALTER TABLE gift_codes
    ADD COLUMN is_listed_for_sale TINYINT(1) NOT NULL DEFAULT 0
  `)

  await tryAlter(`
    ALTER TABLE gift_codes
    ADD COLUMN image_url VARCHAR(500) NULL
  `)

  await tryAlter(`
    ALTER TABLE gift_codes
    ADD COLUMN sale_price DECIMAL(12,2) NULL
  `)

  await tryAlter(`
    ALTER TABLE gift_codes
    ADD COLUMN description TEXT NULL
  `)

  await tryAlter(`
    ALTER TABLE gift_codes
    ADD COLUMN discount_coupon VARCHAR(80) NULL
  `)

  await tryAlter(`
    ALTER TABLE gift_codes
    ADD COLUMN discount_percent DECIMAL(8,2) NULL
  `)

  await tryAlter(`
    ALTER TABLE gift_code_redemptions
    MODIFY COLUMN metadata JSON NULL
  `)
}

app.get('/api/gift-vouchers', requireAuth, async (_req, res) => {
  try {
    await ensureGiftCodeTables()

    const [rows] = await pool.query<RowDataPacket[]>(
      `
      SELECT
        id,
        code,
        description,
        image_url AS imageUrl,
        sale_price AS salePrice,
        discount_coupon AS discountCoupon,
        discount_percent AS discountPercent,
        reward_value AS redeemRewardValue,
        max_total_uses AS maxTotalUses,
        used_count AS usedCount,
        is_active AS isActive,
        is_listed_for_sale AS isListedForSale,
        created_at AS createdAt
      FROM gift_codes
      WHERE is_active = 1
        AND is_listed_for_sale = 1
        AND sale_price IS NOT NULL
        AND sale_price > 0
        AND (max_total_uses <= 0 OR used_count < max_total_uses)
      ORDER BY id DESC
      `
    )

    const vouchers = rows.map((row) => {
      const salePrice = Number(row.salePrice ?? 0)
      const discountPercentRaw = row.discountPercent == null ? null : Number(row.discountPercent)
      const discountPercent =
        discountPercentRaw != null && Number.isFinite(discountPercentRaw) && discountPercentRaw > 0
          ? Math.min(discountPercentRaw, 100)
          : null
      const finalPrice =
        discountPercent != null
          ? Number((salePrice * (1 - discountPercent / 100)).toFixed(2))
          : salePrice

      return {
        id: Number(row.id),
        name: String(row.code ?? ''),
        code: String(row.code ?? ''),
        description: String(row.description ?? ''),
        imageUrl: String(row.imageUrl ?? ''),
        price: finalPrice,
        originalPrice: salePrice,
        discountCoupon: String(row.discountCoupon ?? ''),
        discountPercent,
        redeemRewardValue: Number(row.redeemRewardValue ?? 0),
        maxTotalUses: Number(row.maxTotalUses ?? 0),
        usedCount: Number(row.usedCount ?? 0),
        remainingUses:
          Number(row.maxTotalUses ?? 0) > 0
            ? Math.max(Number(row.maxTotalUses ?? 0) - Number(row.usedCount ?? 0), 0)
            : null,
        isActive: Number(row.isActive ?? 0) === 1,
        isListedForSale: Number(row.isListedForSale ?? 0) === 1,
        createdAt: row.createdAt ?? null,
      }
    })

    res.json({ ok: true, vouchers })
  } catch (err) {
    console.error('[gift-vouchers-list]', err)
    res.status(500).json({ ok: false, error: 'Erro ao listar vales presentes.' })
  }
})

app.post('/api/gift-vouchers', requireMaxAdmin, async (req, res) => {
  const { name, description, imageUrl, price, discountCoupon, redeemRewardValue } = req.body as {
    name?: string
    description?: string
    imageUrl?: string
    price?: number | string
    discountCoupon?: string
    redeemRewardValue?: number | string
  }

  const parsedName = String(name ?? '').trim()
  const parsedDescription = String(description ?? '').trim()
  const parsedImageUrl = String(imageUrl ?? '').trim()
  const parsedPrice = Number(String(price ?? '0').replace(',', '.'))
  const parsedDiscountCoupon = String(discountCoupon ?? '').trim().toUpperCase()
  const parsedRedeemRewardValue = Number(String(redeemRewardValue ?? '0').replace(',', '.'))

  if (!parsedName) {
    res.status(400).json({ ok: false, error: 'Nome do vale é obrigatório.' })
    return
  }

  if (!parsedDiscountCoupon) {
    res.status(400).json({ ok: false, error: 'Cupom de desconto é obrigatório.' })
    return
  }

  if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) {
    res.status(400).json({ ok: false, error: 'Valor do vale inválido.' })
    return
  }

  if (!Number.isFinite(parsedRedeemRewardValue) || parsedRedeemRewardValue <= 0) {
    res.status(400).json({ ok: false, error: 'Valor de resgate inválido.' })
    return
  }

  try {
    await ensureGiftVoucherTables()

    const [result] = await pool.query(
      `
      INSERT INTO gift_vouchers
      (
        name,
        description,
        image_url,
        price,
        discount_coupon,
        redeem_reward_value,
        is_active
      )
      VALUES (?, ?, ?, ?, ?, ?, 1)
      `,
      [
        parsedName,
        parsedDescription || null,
        parsedImageUrl || null,
        Number(parsedPrice.toFixed(2)),
        parsedDiscountCoupon,
        Number(parsedRedeemRewardValue.toFixed(2)),
      ]
    ) as any

    res.status(201).json({
      ok: true,
      message: 'Vale presente criado com sucesso.',
      voucher: {
        id: Number(result?.insertId ?? 0),
        name: parsedName,
        description: parsedDescription,
        imageUrl: parsedImageUrl,
        price: Number(parsedPrice.toFixed(2)),
        discountCoupon: parsedDiscountCoupon,
        redeemRewardValue: Number(parsedRedeemRewardValue.toFixed(2)),
      },
    })
  } catch (err: any) {
    if (String(err?.code ?? '') === 'ER_DUP_ENTRY') {
      res.status(409).json({ ok: false, error: 'Cupom já existe.' })
      return
    }

    console.error('[gift-vouchers-create]', err)
    res.status(500).json({ ok: false, error: 'Erro ao criar vale presente.' })
  }
})

app.post('/api/gift-vouchers/purchase', requireAuth, async (req: AuthenticatedRequest, res) => {
  const { userId, giftVoucherId } = req.body as { userId?: number; giftVoucherId?: number }

  const parsedUserId = Number(userId)
  const parsedGiftVoucherId = Number(giftVoucherId)

  if (!parsedUserId || Number.isNaN(parsedUserId)) {
    res.status(400).json({ ok: false, error: 'ID de usuário inválido.' })
    return
  }

  if (!parsedGiftVoucherId || Number.isNaN(parsedGiftVoucherId)) {
    res.status(400).json({ ok: false, error: 'ID do vale inválido.' })
    return
  }

  if (Number(req.authUser?.id ?? 0) !== parsedUserId) {
    res.status(403).json({ ok: false, error: 'Ação não permitida para este usuário.' })
    return
  }

  const conn = await pool.getConnection()
  try {
    await ensureGiftVoucherTables()
    await ensureGiftCodeTables()
    await conn.beginTransaction()

    const [userRows] = await conn.query<RowDataPacket[]>(
      'SELECT id, balance FROM users WHERE id = ? LIMIT 1 FOR UPDATE',
      [parsedUserId]
    )

    if (userRows.length === 0) {
      await conn.rollback()
      res.status(404).json({ ok: false, error: 'Usuário não encontrado.' })
      return
    }

    const [giftCodeRows] = await conn.query<RowDataPacket[]>(
      `
      SELECT
        id,
        code,
        reward_value AS rewardValue,
        max_total_uses AS maxTotalUses,
        used_count AS usedCount,
        is_active AS isActive,
        is_listed_for_sale AS isListedForSale,
        sale_price AS salePrice,
        discount_coupon AS discountCoupon,
        discount_percent AS discountPercent
      FROM gift_codes
      WHERE id = ?
      LIMIT 1
      FOR UPDATE
      `,
      [parsedGiftVoucherId]
    )

    if (giftCodeRows.length === 0) {
      await conn.rollback()
      res.status(404).json({ ok: false, error: 'Código não encontrado.' })
      return
    }

    const giftCode = giftCodeRows[0]
    const isActive = Number(giftCode.isActive ?? 0) === 1
    const isListedForSale = Number(giftCode.isListedForSale ?? 0) === 1
    const maxTotalUses = Number(giftCode.maxTotalUses ?? 0)
    const usedCount = Number(giftCode.usedCount ?? 0)

    if (!isActive || !isListedForSale) {
      await conn.rollback()
      res.status(400).json({ ok: false, error: 'Este código não está disponível para venda.' })
      return
    }

    if (maxTotalUses > 0 && usedCount >= maxTotalUses) {
      await conn.rollback()
      res.status(400).json({ ok: false, error: 'Este código esgotou o limite de resgates.' })
      return
    }

    const salePriceRaw = Number(giftCode.salePrice ?? 0)
    if (!Number.isFinite(salePriceRaw) || salePriceRaw <= 0) {
      await conn.rollback()
      res.status(400).json({ ok: false, error: 'Preço de venda inválido para este código.' })
      return
    }

    const discountPercentRaw = giftCode.discountPercent == null ? null : Number(giftCode.discountPercent)
    const discountPercent =
      discountPercentRaw != null && Number.isFinite(discountPercentRaw) && discountPercentRaw > 0
        ? Math.min(discountPercentRaw, 100)
        : null

    const finalPrice =
      discountPercent != null
        ? Number((salePriceRaw * (1 - discountPercent / 100)).toFixed(2))
        : Number(salePriceRaw.toFixed(2))

    const currentBalance = Number(userRows[0].balance ?? 0)
    if (currentBalance < finalPrice) {
      await conn.rollback()
      res.status(400).json({
        ok: false,
        error: 'Saldo insuficiente para comprar este código.',
        required: finalPrice,
        available: currentBalance,
      })
      return
    }

    const balanceAfter = Number((currentBalance - finalPrice).toFixed(2))

    await conn.query(
      `
      UPDATE users
      SET balance = ?
      WHERE id = ?
      `,
      [balanceAfter, parsedUserId]
    )

    const generatedGiftCode = String(giftCode.code ?? '').trim().toUpperCase()
    const generatedGiftCodeId = Number(giftCode.id ?? 0)
    const redeemRewardValue = Number(giftCode.rewardValue ?? 0)

    const [purchaseResult] = await conn.query(
      `
      INSERT INTO gift_voucher_purchases
      (
        user_id,
        gift_voucher_id,
        paid_amount,
        discount_coupon,
        redeem_reward_value,
        generated_gift_code,
        generated_gift_code_id,
        status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 'paid')
      `,
      [
        parsedUserId,
        parsedGiftVoucherId,
        Number(finalPrice.toFixed(2)),
        String(giftCode.discountCoupon ?? ''),
        Number(redeemRewardValue.toFixed(2)),
        generatedGiftCode,
        generatedGiftCodeId || null,
      ]
    ) as any

    await conn.commit()

    res.json({
      ok: true,
      message: 'Código comprado com sucesso.',
      generatedGiftCode,
      purchase: {
        id: Number(purchaseResult?.insertId ?? 0),
        giftVoucherId: parsedGiftVoucherId,
        name: generatedGiftCode,
        paidAmount: Number(finalPrice.toFixed(2)),
        originalPrice: Number(salePriceRaw.toFixed(2)),
        discountPercent,
        redeemRewardValue: Number(redeemRewardValue.toFixed(2)),
        generatedGiftCode,
      },
      balanceBefore: Number(currentBalance.toFixed(2)),
      balanceAfter,
    })
  } catch (err) {
    await conn.rollback()
    console.error('[gift-vouchers-purchase]', err)
    res.status(500).json({ ok: false, error: 'Erro ao comprar código.' })
  } finally {
    conn.release()
  }
})

app.get('/api/admin/gift-codes', requireMaxAdmin, async (_req, res) => {
  try {
    await ensureGiftCodeTables()

    const [rows] = await pool.query<RowDataPacket[]>(
      `
      SELECT
        id,
        code,
        reward_type AS rewardType,
        reward_value AS rewardValue,
        max_total_uses AS maxTotalUses,
        used_count AS usedCount,
        notes,
        is_active AS isActive,
        starts_at AS startsAt,
        expires_at AS expiresAt,
        created_by_user_id AS createdByUserId,
        is_listed_for_sale AS isListedForSale,
        image_url AS imageUrl,
        sale_price AS salePrice,
        description,
        discount_coupon AS discountCoupon,
        discount_percent AS discountPercent,
        created_at AS createdAt
      FROM gift_codes
      ORDER BY id DESC
      `
    )

    const giftCodes = rows.map((row) => ({
      id: Number(row.id),
      code: String(row.code ?? ''),
      rewardType: String(row.rewardType ?? 'balance_credit'),
      rewardValue: Number(row.rewardValue ?? 0),
      maxTotalUses: Number(row.maxTotalUses ?? 0),
      usedCount: Number(row.usedCount ?? 0),
      notes: String(row.notes ?? ''),
      isActive: Number(row.isActive ?? 0) === 1,
      startsAt: row.startsAt ?? null,
      expiresAt: row.expiresAt ?? null,
      createdByUserId: row.createdByUserId == null ? null : Number(row.createdByUserId),
      isListedForSale: Number(row.isListedForSale ?? 0) === 1,
      imageUrl: String(row.imageUrl ?? ''),
      salePrice: row.salePrice == null ? null : Number(row.salePrice),
      description: String(row.description ?? ''),
      discountCoupon: String(row.discountCoupon ?? ''),
      discountPercent: row.discountPercent == null ? null : Number(row.discountPercent),
      createdAt: row.createdAt ?? null,
    }))

    res.json({ ok: true, giftCodes })
  } catch (err) {
    console.error('[admin-gift-codes-list]', err)
    const details = process.env.NODE_ENV === 'production'
      ? undefined
      : String((err as any)?.message ?? err)
    res.status(500).json({ ok: false, error: 'Erro ao listar códigos de presente.', details })
  }
})

app.post('/api/admin/gift-codes', requireMaxAdmin, async (req: AuthenticatedRequest, res) => {
  const {
    code,
    rewardType,
    rewardValue,
    maxTotalUses,
    notes,
    startsAt,
    expiresAt,
    isListedForSale,
    imageUrl,
    salePrice,
    description,
    discountCoupon,
    discountPercent,
    productName,
  } = req.body as {
    code?: string
    rewardType?: string
    rewardValue?: number | string
    maxTotalUses?: number | string
    notes?: string
    startsAt?: string | null
    expiresAt?: string | null
    isListedForSale?: boolean | number | string
    imageUrl?: string | null
    salePrice?: number | string | null
    description?: string | null
    discountCoupon?: string | null
    discountPercent?: number | string | null
    productName?: string | null
  }

  const normalizedCode = String(code ?? '').trim().toUpperCase()
  const normalizedRewardType = String(rewardType ?? 'balance_credit').trim() || 'balance_credit'
  const normalizedRewardValue = Number(String(rewardValue ?? '0').replace(',', '.'))
  const normalizedMaxTotalUses = Number(String(maxTotalUses ?? '1'))
  const normalizedNotes = String(notes ?? '').trim()
  const normalizedStartsAt = startsAt ? String(startsAt).trim() : null
  const normalizedExpiresAt = expiresAt ? String(expiresAt).trim() : null

  const normalizedIsListedForSale =
    isListedForSale === true ||
    isListedForSale === 1 ||
    String(isListedForSale ?? '').toLowerCase() === 'true'

  const normalizedImageUrl = String(imageUrl ?? '').trim()
  const normalizedDescription = String(description ?? '').trim()
  const normalizedProductName = String(productName ?? '').trim()
  const normalizedDiscountCoupon = String(discountCoupon ?? '').trim().toUpperCase()
  const normalizedSalePrice =
    salePrice == null || String(salePrice).trim() === ''
      ? null
      : Number(String(salePrice).replace(',', '.'))
  const normalizedDiscountPercent =
    discountPercent == null || String(discountPercent).trim() === ''
      ? null
      : Number(String(discountPercent).replace(',', '.'))

  if (!normalizedCode) {
    res.status(400).json({ ok: false, error: 'Código é obrigatório.' })
    return
  }

  if (!Number.isFinite(normalizedRewardValue) || normalizedRewardValue <= 0) {
    res.status(400).json({ ok: false, error: 'Valor de recompensa inválido.' })
    return
  }

  if (!Number.isInteger(normalizedMaxTotalUses) || normalizedMaxTotalUses <= 0) {
    res.status(400).json({ ok: false, error: 'Limite máximo de usos inválido.' })
    return
  }

  if (normalizedIsListedForSale) {

    if (!normalizedDescription) {
      res.status(400).json({ ok: false, error: 'Descrição é obrigatória para venda.' })
      return
    }

    if (!Number.isFinite(Number(normalizedSalePrice)) || Number(normalizedSalePrice) <= 0) {
      res.status(400).json({ ok: false, error: 'Valor do vale presente inválido para venda.' })
      return
    }

    if (
      normalizedDiscountPercent != null &&
      (!Number.isFinite(normalizedDiscountPercent) || normalizedDiscountPercent < 0 || normalizedDiscountPercent > 100)
    ) {
      res.status(400).json({ ok: false, error: 'Cupom de desconto (%) deve estar entre 0 e 100.' })
      return
    }
  }

  try {
    await ensureGiftCodeTables()

    const [result] = await pool.query(
      `
      INSERT INTO gift_codes
      (
        code,
        reward_type,
        reward_value,
        max_total_uses,
        used_count,
        notes,
        is_active,
        starts_at,
        expires_at,
        created_by_user_id,
        is_listed_for_sale,
        image_url,
        sale_price,
        description,
        discount_coupon,
        discount_percent
      )
      VALUES (?, ?, ?, ?, 0, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        normalizedCode,
        normalizedRewardType,
        Number(normalizedRewardValue.toFixed(2)),
        normalizedMaxTotalUses,
        normalizedNotes || null,
        normalizedStartsAt || null,
        normalizedExpiresAt || null,
        Number(req.authUser?.id ?? 0) || null,
        normalizedIsListedForSale ? 1 : 0,
        normalizedImageUrl || null,
        normalizedIsListedForSale ? Number(Number(normalizedSalePrice).toFixed(2)) : null,
        normalizedDescription || null,
        normalizedDiscountCoupon || null,
        normalizedDiscountPercent == null ? null : Number(normalizedDiscountPercent.toFixed(2)),
      ]
    ) as any

    res.status(201).json({
      ok: true,
      message: `Código ${normalizedCode} criado com sucesso.`,
      giftCode: {
        id: Number(result?.insertId ?? 0),
        code: normalizedCode,
        productName: normalizedProductName || normalizedCode,
        rewardType: normalizedRewardType,
        rewardValue: Number(normalizedRewardValue.toFixed(2)),
        maxTotalUses: normalizedMaxTotalUses,
        usedCount: 0,
        notes: normalizedNotes,
        startsAt: normalizedStartsAt,
        expiresAt: normalizedExpiresAt,
        isListedForSale: normalizedIsListedForSale,
        imageUrl: normalizedImageUrl || null,
        salePrice: normalizedIsListedForSale ? Number(Number(normalizedSalePrice).toFixed(2)) : null,
        description: normalizedDescription || null,
        discountCoupon: normalizedDiscountCoupon || null,
        discountPercent: normalizedDiscountPercent == null ? null : Number(normalizedDiscountPercent.toFixed(2)),
      },
    })
  } catch (err: any) {
    if (String(err?.code ?? '') === 'ER_DUP_ENTRY') {
      res.status(409).json({ ok: false, error: 'Este código já existe.' })
      return
    }

    console.error('[admin-gift-codes-create]', err)
    res.status(500).json({ ok: false, error: 'Erro ao criar código de presente.' })
  }
})

app.delete('/api/admin/gift-codes/:id', requireMaxAdmin, async (req, res) => {
  const giftCodeId = Number(req.params.id)

  if (!giftCodeId || Number.isNaN(giftCodeId)) {
    res.status(400).json({ ok: false, error: 'ID do código inválido.' })
    return
  }

  const conn = await pool.getConnection()
  try {
    await ensureGiftCodeTables()
    await conn.beginTransaction()

    const [existsRows] = await conn.query<RowDataPacket[]>(
      'SELECT id, code FROM gift_codes WHERE id = ? LIMIT 1 FOR UPDATE',
      [giftCodeId]
    )

    if (existsRows.length === 0) {
      await conn.rollback()
      res.status(404).json({ ok: false, error: 'Código não encontrado.' })
      return
    }

    await conn.query(
      'DELETE FROM gift_code_redemptions WHERE gift_code_id = ?',
      [giftCodeId]
    )

    await conn.query(
      'DELETE FROM gift_codes WHERE id = ?',
      [giftCodeId]
    )

    await conn.commit()
    res.json({
      ok: true,
      message: `Código ${String(existsRows[0].code ?? '')} apagado com sucesso.`,
      deletedId: giftCodeId,
    })
  } catch (err) {
    await conn.rollback()
    console.error('[admin-gift-codes-delete]', err)
    res.status(500).json({ ok: false, error: 'Erro ao apagar código de presente.' })
  } finally {
    conn.release()
  }
})

app.post('/api/gift-codes/redeem', async (req, res) => {
  const { userId, code } = req.body as { userId?: number; code?: string }

  const parsedUserId = Number(userId)
  const normalizedCode = String(code ?? '').trim().toUpperCase()

  if (!parsedUserId || Number.isNaN(parsedUserId)) {
    res.status(400).json({ ok: false, error: 'ID de usuário inválido.' })
    return
  }

  if (!normalizedCode) {
    res.status(400).json({ ok: false, error: 'Código é obrigatório.' })
    return
  }

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    const [userRows] = await conn.query<RowDataPacket[]>(
      'SELECT id, balance FROM users WHERE id = ? LIMIT 1 FOR UPDATE',
      [parsedUserId]
    )

    if (userRows.length === 0) {
      await conn.rollback()
      res.status(404).json({ ok: false, error: 'Usuário não encontrado.' })
      return
    }

    const [giftRows] = await conn.query<RowDataPacket[]>(
      `
      SELECT
        id,
        code,
        reward_type AS rewardType,
        reward_value AS rewardValue,
        max_total_uses AS maxTotalUses,
        used_count AS usedCount,
        is_active AS isActive,
        starts_at AS startsAt,
        expires_at AS expiresAt
      FROM gift_codes
      WHERE UPPER(code) = ?
      LIMIT 1
      FOR UPDATE
      `,
      [normalizedCode]
    )

    if (giftRows.length === 0) {
      await conn.rollback()
      res.status(404).json({ ok: false, error: 'Código não encontrado.' })
      return
    }

    const gift = giftRows[0]
    const isActive = Number(gift.isActive ?? 0) === 1
    const usedCount = Number(gift.usedCount ?? 0)
    const maxTotalUses = Number(gift.maxTotalUses ?? 0)
    const now = new Date()
    const startsAt = gift.startsAt ? new Date(gift.startsAt) : null
    const expiresAt = gift.expiresAt ? new Date(gift.expiresAt) : null

    if (!isActive) {
      await conn.rollback()
      res.status(400).json({ ok: false, error: 'Código inativo.' })
      return
    }

    if (startsAt && startsAt > now) {
      await conn.rollback()
      res.status(400).json({ ok: false, error: 'Código ainda não está disponível.' })
      return
    }

    if (expiresAt && expiresAt < now) {
      await conn.rollback()
      res.status(400).json({ ok: false, error: 'Código expirado.' })
      return
    }

    if (maxTotalUses > 0 && usedCount >= maxTotalUses) {
      await conn.rollback()
      res.status(400).json({ ok: false, error: 'Código já atingiu o limite de uso.' })
      return
    }

    const [alreadyRedeemedRows] = await conn.query<RowDataPacket[]>(
      `
      SELECT id
      FROM gift_code_redemptions
      WHERE gift_code_id = ? AND user_id = ?
      LIMIT 1
      `,
      [Number(gift.id), parsedUserId]
    )

    if (alreadyRedeemedRows.length > 0) {
      await conn.rollback()
      res.status(400).json({ ok: false, error: 'Você já resgatou este código.' })
      return
    }

    const rewardType = String(gift.rewardType ?? 'balance_credit')
    const rewardValue = Number(gift.rewardValue ?? 0)
    const oldBalance = Number(userRows[0]?.balance ?? 0)

    await conn.query(
      `
      INSERT INTO gift_code_redemptions
      (
        gift_code_id,
        user_id,
        reward_type,
        reward_value,
        reward_applied,
        metadata
      )
      VALUES (?, ?, ?, ?, 1, ?)
      `,
      [
        Number(gift.id),
        parsedUserId,
        rewardType,
        rewardValue,
        JSON.stringify({
          source: 'profile_page',
          code: normalizedCode,
        }),
      ]
    )

    await conn.query(
      `
      UPDATE gift_codes
      SET used_count = used_count + 1
      WHERE id = ?
      `,
      [Number(gift.id)]
    )

    if (rewardType === 'balance_credit' && rewardValue > 0) {
      await conn.query(
        `
        UPDATE users
        SET balance = COALESCE(balance, 0) + ?
        WHERE id = ?
        `,
        [rewardValue, parsedUserId]
      )
    }

    const [updatedUserRows] = await conn.query<RowDataPacket[]>(
      'SELECT balance FROM users WHERE id = ? LIMIT 1',
      [parsedUserId]
    )

    const updatedBalance = Number(updatedUserRows[0]?.balance ?? 0)

    await conn.query(
      `
      CREATE TABLE IF NOT EXISTS logs (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id BIGINT UNSIGNED NULL,
        entity_type VARCHAR(60) NOT NULL,
        entity_id BIGINT UNSIGNED NULL,
        action VARCHAR(100) NOT NULL,
        old_balance DECIMAL(12,2) NULL,
        new_balance DECIMAL(12,2) NULL,
        amount DECIMAL(12,2) NULL,
        metadata JSON NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_logs_user_id (user_id),
        KEY idx_logs_entity_type (entity_type),
        KEY idx_logs_entity_id (entity_id),
        KEY idx_logs_action (action),
        KEY idx_logs_created_at (created_at)
      )
      `
    )

    await conn.query(
      `
      INSERT INTO logs
      (
        user_id,
        entity_type,
        entity_id,
        action,
        old_balance,
        new_balance,
        amount,
        metadata
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        parsedUserId,
        'gift_code',
        Number(gift.id),
        'gift_code_redeemed',
        Number(oldBalance.toFixed(2)),
        Number(updatedBalance.toFixed(2)),
        Number(rewardValue.toFixed(2)),
        JSON.stringify({
          code: normalizedCode,
          rewardType,
          source: 'profile_page',
        }),
      ]
    )

    await conn.commit()

    res.json({
      ok: true,
      message: `Código ${normalizedCode} resgatado com sucesso!`,
      rewardType,
      rewardValue,
      balance: updatedBalance,
      code: normalizedCode,
    })
  } catch (err) {
    await conn.rollback()
    console.error('[gift-code-redeem]', err)
    res.status(500).json({ ok: false, error: 'Erro interno ao resgatar código.' })
  } finally {
    conn.release()
  }
})

app.get('/api/admin/withdraw-config', async (_req, res) => {
  try {
    await pool.query(
      `
      CREATE TABLE IF NOT EXISTS system_withdraw_config (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        withdraw_fee_percent DECIMAL(8,2) NOT NULL DEFAULT 0.00,
        min_withdraw_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        max_withdraw_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        withdraw_auto_approve TINYINT(1) NOT NULL DEFAULT 0,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id)
      )
      `
    )

    try {
      await pool.query(
        `
        ALTER TABLE system_withdraw_config
        ADD COLUMN withdraw_auto_approve TINYINT(1) NOT NULL DEFAULT 0
        `
      )
    } catch {
      // coluna já existe
    }

    const [rows] = await pool.query<RowDataPacket[]>(
      `
      SELECT
        id,
        withdraw_fee_percent AS withdrawFeePercent,
        min_withdraw_amount AS minWithdrawAmount,
        max_withdraw_amount AS maxWithdrawAmount,
        withdraw_auto_approve AS withdrawAutoApprove
      FROM system_withdraw_config
      ORDER BY id ASC
      LIMIT 1
      `
    )

    if (rows.length === 0) {
      await pool.query(
        `
        INSERT INTO system_withdraw_config
          (withdraw_fee_percent, min_withdraw_amount, max_withdraw_amount, withdraw_auto_approve)
        VALUES (0.00, 0.00, 0.00, 0)
        `
      )

      res.json({
        ok: true,
        config: {
          withdrawFeePercent: 0,
          minWithdrawAmount: 0,
          maxWithdrawAmount: 0,
          withdrawAutoApprove: false,
        },
      })
      return
    }

    const row = rows[0]
    res.json({
      ok: true,
      config: {
        withdrawFeePercent: Number(row.withdrawFeePercent ?? 0),
        minWithdrawAmount: Number(row.minWithdrawAmount ?? 0),
        maxWithdrawAmount: Number(row.maxWithdrawAmount ?? 0),
        withdrawAutoApprove: Number(row.withdrawAutoApprove ?? 0) === 1,
      },
    })
  } catch (err) {
    console.error('[admin-withdraw-config-get]', err)
    res.status(500).json({ ok: false, error: 'Erro ao carregar configurações de saque.' })
  }
})

app.post('/api/admin/withdraw-config', requireMaxAdmin, async (req, res) => {
  const { withdrawFeePercent, minWithdrawAmount, maxWithdrawAmount, withdrawAutoApprove } = req.body as {
    withdrawFeePercent?: number | string
    minWithdrawAmount?: number | string
    maxWithdrawAmount?: number | string
    withdrawAutoApprove?: boolean | number | string
  }

  const fee = Number(String(withdrawFeePercent ?? 0).replace(',', '.'))
  const min = Number(String(minWithdrawAmount ?? 0).replace(',', '.'))
  const max = Number(String(maxWithdrawAmount ?? 0).replace(',', '.'))
  const autoApprove =
    withdrawAutoApprove === true ||
    withdrawAutoApprove === 1 ||
    String(withdrawAutoApprove ?? '').toLowerCase() === 'true'
      ? 1
      : 0

  if (!Number.isFinite(fee) || fee < 0) {
    res.status(400).json({ ok: false, error: 'Taxa de saque inválida.' })
    return
  }

  if (!Number.isFinite(min) || min < 0) {
    res.status(400).json({ ok: false, error: 'Valor mínimo inválido.' })
    return
  }

  if (!Number.isFinite(max) || max < 0) {
    res.status(400).json({ ok: false, error: 'Valor máximo inválido.' })
    return
  }

  if (max > 0 && min > max) {
    res.status(400).json({ ok: false, error: 'Valor mínimo não pode ser maior que o máximo.' })
    return
  }

  try {
    await pool.query(
      `
      CREATE TABLE IF NOT EXISTS system_withdraw_config (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        withdraw_fee_percent DECIMAL(8,2) NOT NULL DEFAULT 0.00,
        min_withdraw_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        max_withdraw_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        withdraw_auto_approve TINYINT(1) NOT NULL DEFAULT 0,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id)
      )
      `
    )

    try {
      await pool.query(
        `
        ALTER TABLE system_withdraw_config
        ADD COLUMN withdraw_auto_approve TINYINT(1) NOT NULL DEFAULT 0
        `
      )
    } catch {
      // coluna já existe
    }

    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM system_withdraw_config ORDER BY id ASC LIMIT 1'
    )

    const normalizedFee = Number(fee.toFixed(2))
    const normalizedMin = Number(min.toFixed(2))
    const normalizedMax = Number(max.toFixed(2))

    if (rows.length === 0) {
      await pool.query(
        `
        INSERT INTO system_withdraw_config
          (withdraw_fee_percent, min_withdraw_amount, max_withdraw_amount, withdraw_auto_approve)
        VALUES (?, ?, ?, ?)
        `,
        [normalizedFee, normalizedMin, normalizedMax, autoApprove]
      )
    } else {
      await pool.query(
        `
        UPDATE system_withdraw_config
        SET
          withdraw_fee_percent = ?,
          min_withdraw_amount = ?,
          max_withdraw_amount = ?,
          withdraw_auto_approve = ?,
          updated_at = NOW()
        WHERE id = ?
        `,
        [normalizedFee, normalizedMin, normalizedMax, autoApprove, Number(rows[0].id)]
      )
    }

    res.json({
      ok: true,
      message: 'Configurações de saque salvas com sucesso.',
      config: {
        withdrawFeePercent: normalizedFee,
        minWithdrawAmount: normalizedMin,
        maxWithdrawAmount: normalizedMax,
        withdrawAutoApprove: autoApprove === 1,
      },
    })
  } catch (err) {
    console.error('[admin-withdraw-config-save]', err)
    res.status(500).json({ ok: false, error: 'Erro ao salvar configurações de saque.' })
  }
})

app.get('/api/site-settings', async (_req, res) => {
  try {
    await pool.query(
      `
      CREATE TABLE IF NOT EXISTS site_settings (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        site_title VARCHAR(150) NOT NULL DEFAULT '',
        site_description TEXT NULL,
        site_logo_url VARCHAR(500) NULL,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id)
      )
      `
    )

    try {
      await pool.query(
        `
        ALTER TABLE site_settings
        ADD COLUMN site_logo_url VARCHAR(500) NULL
        `
      )
    } catch {
      // coluna já existe
    }

    const [rows] = await pool.query<RowDataPacket[]>(
      `
      SELECT
        site_title AS siteTitle,
        site_description AS siteDescription,
        COALESCE(site_logo_url, '') AS siteLogoUrl,
        updated_at AS updatedAt
      FROM site_settings
      ORDER BY id ASC
      LIMIT 1
      `
    )

    if (rows.length === 0) {
      res.json({
        ok: true,
        settings: {
          siteTitle: '',
          siteDescription: '',
          siteLogoUrl: '',
          updatedAt: null,
        },
      })
      return
    }

    res.json({
      ok: true,
      settings: {
        siteTitle: String(rows[0].siteTitle ?? ''),
        siteDescription: String(rows[0].siteDescription ?? ''),
        siteLogoUrl: String(rows[0].siteLogoUrl ?? ''),
        updatedAt: rows[0].updatedAt ?? null,
      },
    })
  } catch (err) {
    console.error('[site-settings-get-public]', err)
    res.status(500).json({ ok: false, error: 'Erro ao carregar configurações públicas do site.' })
  }
})

app.get('/api/admin/site-settings', requireMaxAdmin, async (_req, res) => {
  try {
    await pool.query(
      `
      CREATE TABLE IF NOT EXISTS site_settings (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        site_title VARCHAR(150) NOT NULL DEFAULT '',
        site_description TEXT NULL,
        site_logo_url VARCHAR(500) NULL,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id)
      )
      `
    )

    try {
      await pool.query(
        `
        ALTER TABLE site_settings
        ADD COLUMN site_logo_url VARCHAR(500) NULL
        `
      )
    } catch {
      // coluna já existe
    }

    const [rows] = await pool.query<RowDataPacket[]>(
      `
      SELECT
        id,
        site_title AS siteTitle,
        site_description AS siteDescription,
        COALESCE(site_logo_url, '') AS siteLogoUrl,
        updated_at AS updatedAt
      FROM site_settings
      ORDER BY id ASC
      LIMIT 1
      `
    )

    if (rows.length === 0) {
      await pool.query(
        `
        INSERT INTO site_settings (site_title, site_description, site_logo_url)
        VALUES ('', '', '')
        `
      )

      res.json({
        ok: true,
        settings: {
          siteTitle: '',
          siteDescription: '',
          siteLogoUrl: '',
          updatedAt: null,
        },
      })
      return
    }

    res.json({
      ok: true,
      settings: {
        siteTitle: String(rows[0].siteTitle ?? ''),
        siteDescription: String(rows[0].siteDescription ?? ''),
        siteLogoUrl: String(rows[0].siteLogoUrl ?? ''),
        updatedAt: rows[0].updatedAt ?? null,
      },
    })
  } catch (err) {
    console.error('[admin-site-settings-get]', err)
    res.status(500).json({ ok: false, error: 'Erro ao carregar configurações do site.' })
  }
})

app.post('/api/admin/site-settings', requireMaxAdmin, async (req, res) => {
  const { siteTitle, siteDescription, siteLogoUrl } = req.body as {
    siteTitle?: string
    siteDescription?: string
    siteLogoUrl?: string
  }

  const parsedSiteTitle = String(siteTitle ?? '').trim()
  const parsedSiteDescription = String(siteDescription ?? '').trim()
  const parsedSiteLogoUrl = String(siteLogoUrl ?? '').trim()

  if (!parsedSiteTitle) {
    res.status(400).json({ ok: false, error: 'Título do site é obrigatório.' })
    return
  }

  try {
    await pool.query(
      `
      CREATE TABLE IF NOT EXISTS site_settings (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        site_title VARCHAR(150) NOT NULL DEFAULT '',
        site_description TEXT NULL,
        site_logo_url VARCHAR(500) NULL,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id)
      )
      `
    )

    try {
      await pool.query(
        `
        ALTER TABLE site_settings
        ADD COLUMN site_logo_url VARCHAR(500) NULL
        `
      )
    } catch {
      // coluna já existe
    }

    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM site_settings ORDER BY id ASC LIMIT 1'
    )

    if (rows.length === 0) {
      await pool.query(
        `
        INSERT INTO site_settings (site_title, site_description, site_logo_url)
        VALUES (?, ?, ?)
        `,
        [parsedSiteTitle, parsedSiteDescription, parsedSiteLogoUrl]
      )
    } else {
      await pool.query(
        `
        UPDATE site_settings
        SET
          site_title = ?,
          site_description = ?,
          site_logo_url = ?,
          updated_at = NOW()
        WHERE id = ?
        `,
        [parsedSiteTitle, parsedSiteDescription, parsedSiteLogoUrl, Number(rows[0].id)]
      )
    }

    res.json({
      ok: true,
      message: 'Configurações do site salvas com sucesso.',
      settings: {
        siteTitle: parsedSiteTitle,
        siteDescription: parsedSiteDescription,
        siteLogoUrl: parsedSiteLogoUrl,
      },
    })
  } catch (err) {
    console.error('[admin-site-settings-save]', err)
    res.status(500).json({ ok: false, error: 'Erro ao salvar configurações do site.' })
  }
})

app.get('/api/admin/overview', requireMaxAdmin, async (_req, res) => {
  try {
    const [activeUsersRows] = await pool.query<RowDataPacket[]>(
      `
      SELECT COUNT(*) AS total
      FROM users
      `
    )

    const [depositsTodayRows] = await pool.query<RowDataPacket[]>(
      `
      SELECT COALESCE(SUM(amount), 0) AS total
      FROM cashin_payments
      WHERE LOWER(status) IN ('paid', 'payment.paid')
        AND DATE(COALESCE(paid_at, created_at)) = CURDATE()
      `
    )

    let pendingWithdrawals = 0
    let withdrawalsPaid = 0
    try {
      const [pendingRows] = await pool.query<RowDataPacket[]>(
        `
        SELECT COUNT(*) AS total
        FROM withdrawals
        WHERE LOWER(status) IN ('pending', 'processing')
        `
      )
      pendingWithdrawals = Number(pendingRows[0]?.total ?? 0)

      const [paidRows] = await pool.query<RowDataPacket[]>(
        `
        SELECT COALESCE(SUM(amount), 0) AS total
        FROM withdrawals
        WHERE LOWER(status) IN ('paid', 'payment.paid')
        `
      )
      withdrawalsPaid = Number(paidRows[0]?.total ?? 0)
    } catch {
      pendingWithdrawals = 0
      withdrawalsPaid = 0
    }

    const depositsPaid = Number(depositsTodayRows[0]?.total ?? 0)
    const netRevenue = Number((depositsPaid - withdrawalsPaid).toFixed(2))

    res.json({
      ok: true,
      summary: {
        activeUsers: Number(activeUsersRows[0]?.total ?? 0),
        depositsToday: depositsPaid,
        pendingWithdrawals,
        netRevenue,
      },
    })
  } catch (err) {
    console.error('[admin-overview]', err)
    res.status(500).json({ ok: false, error: 'Erro ao carregar visão geral do admin.' })
  }
})

app.get('/api/admin/withdrawals/latest', requireMaxAdmin, async (req, res) => {
  const rawLimit = Number(req.query.limit ?? 10)
  const limit = Math.min(Math.max(rawLimit, 1), 50)

  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `
      SELECT
        w.id,
        w.amount,
        w.status,
        w.created_at AS createdAt,
        w.paid_at AS paidAt,
        u.id AS userId,
        u.name AS userName,
        u.phone AS userPhone
      FROM withdrawals w
      INNER JOIN users u ON u.id = w.user_id
      ORDER BY w.id DESC
      LIMIT ?
      `,
      [limit]
    )

    const withdrawals = rows.map((row) => ({
      id: Number(row.id),
      amount: Number(row.amount ?? 0),
      status: String(row.status ?? 'pending').toLowerCase(),
      createdAt: row.createdAt,
      paidAt: row.paidAt,
      user: {
        id: Number(row.userId),
        name: String(row.userName ?? 'Usuário'),
        phone: String(row.userPhone ?? ''),
      },
    }))

    res.json({
      ok: true,
      total: withdrawals.length,
      withdrawals,
    })
  } catch (err) {
    console.error('[admin-withdrawals-latest]', err)
    res.status(500).json({ ok: false, error: 'Erro ao carregar últimos saques.' })
  }
})

app.get('/api/admin/withdrawals/pending', requireMaxAdmin, async (_req, res) => {
  try {
    await pool.query(
      `
      CREATE TABLE IF NOT EXISTS system_withdraw_config (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        withdraw_fee_percent DECIMAL(8,2) NOT NULL DEFAULT 0.00,
        min_withdraw_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        max_withdraw_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id)
      )
      `
    )

    const [configRows] = await pool.query<RowDataPacket[]>(
      `
      SELECT withdraw_fee_percent AS withdrawFeePercent
      FROM system_withdraw_config
      ORDER BY id ASC
      LIMIT 1
      `
    )

    const configuredFeePercent = Number(configRows[0]?.withdrawFeePercent ?? 0)

    const [rows] = await pool.query<RowDataPacket[]>(
      `
      SELECT
        w.id,
        w.amount,
        w.status,
        w.created_at AS createdAt,
        w.updated_at AS updatedAt,
        w.paid_at AS paidAt,
        u.id AS userId,
        u.name AS userName,
        u.phone AS userPhone
      FROM withdrawals w
      INNER JOIN users u ON u.id = w.user_id
      WHERE LOWER(w.status) IN ('pending', 'processing')
      ORDER BY w.id DESC
      `
    )

    const withdrawals = rows.map((row) => {
      const amount = Number(row.amount ?? 0)
      const feeAmount = Number(((amount * configuredFeePercent) / 100).toFixed(2))
      const netAmount = Number((amount - feeAmount).toFixed(2))

      return {
        id: Number(row.id),
        amount,
        status: String(row.status ?? 'pending').toLowerCase(),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        paidAt: row.paidAt,
        feePercent: configuredFeePercent,
        feeAmount,
        netAmount,
        user: {
          id: Number(row.userId),
          name: String(row.userName ?? 'Usuário'),
          phone: String(row.userPhone ?? ''),
        },
      }
    })

    res.json({
      ok: true,
      total: withdrawals.length,
      withdrawFeePercent: configuredFeePercent,
      withdrawals,
    })
  } catch (err) {
    console.error('[admin-withdrawals-pending]', err)
    res.status(500).json({ ok: false, error: 'Erro ao carregar saques pendentes.' })
  }
})

app.post('/api/admin/withdrawals/:id/action', requireMaxAdmin, async (req: AuthenticatedRequest, res) => {
  const withdrawalId = Number(req.params.id)
  const { action, refundOnCancel, provider } = req.body as {
    action?: 'approve' | 'cancel'
    refundOnCancel?: boolean
    provider?: 'syncpay' | 'connectpay'
  }

  const parsedAction = String(action ?? '').toLowerCase()
  const shouldRefund = Boolean(refundOnCancel)
  const parsedProvider = String(provider ?? '').trim().toLowerCase()

  if (parsedAction === 'approve' && !['syncpay', 'connectpay'].includes(parsedProvider)) {
    res.status(400).json({ ok: false, error: 'Provedor inválido. Use syncpay ou connectpay.' })
    return
  }

  if (!withdrawalId || Number.isNaN(withdrawalId)) {
    res.status(400).json({ ok: false, error: 'ID do saque inválido.' })
    return
  }

  if (!['approve', 'cancel'].includes(parsedAction)) {
    res.status(400).json({ ok: false, error: 'Ação inválida. Use approve ou cancel.' })
    return
  }

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    const [withdrawRows] = await conn.query<RowDataPacket[]>(
      `
      SELECT id, user_id AS userId, amount, status
      FROM withdrawals
      WHERE id = ?
      LIMIT 1
      FOR UPDATE
      `,
      [withdrawalId]
    )

    if (withdrawRows.length === 0) {
      await conn.rollback()
      res.status(404).json({ ok: false, error: 'Saque não encontrado.' })
      return
    }

    const withdrawal = withdrawRows[0]
    const currentStatus = String(withdrawal.status ?? '').toLowerCase()

    if (!['pending', 'processing'].includes(currentStatus)) {
      await conn.rollback()
      res.status(400).json({ ok: false, error: 'Somente saques pendentes/processando podem ser alterados.' })
      return
    }

    let nextStatus = parsedAction === 'approve' ? 'processing' : 'failed'
    const amount = Number(withdrawal.amount ?? 0)
    const userId = Number(withdrawal.userId)
    let providerTransactionId: string | null = null
    let providerResponsePayload: any = null

    if (parsedAction === 'approve') {
      const [pixRows] = await conn.query<RowDataPacket[]>(
        `
        SELECT holder_name AS holderName, holder_cpf AS holderCpf, pix_key_type AS pixKeyType, pix_key AS pixKey
        FROM withdrawals
        WHERE id = ?
        LIMIT 1
        FOR UPDATE
        `,
        [withdrawalId]
      )

      if (pixRows.length === 0) {
        await conn.rollback()
        res.status(404).json({ ok: false, error: 'Dados PIX do saque não encontrados.' })
        return
      }

      const holderName = String(pixRows[0].holderName ?? '').trim()
      const holderCpf = String(pixRows[0].holderCpf ?? '').replace(/\D/g, '')
      const pixKeyTypeRaw = String(pixRows[0].pixKeyType ?? 'CHAVE_ALEATORIA')
      const pixKeyRaw = String(pixRows[0].pixKey ?? '')

      const lumopayPixType = mapPixTypeToLumopay(pixKeyTypeRaw)
      const lumopayPixKey = normalizeLumopayPixKey(pixKeyRaw, lumopayPixType)

      if (!holderName || holderCpf.length < 11 || !lumopayPixKey) {
        await conn.rollback()
        res.status(400).json({ ok: false, error: 'Dados PIX inválidos para envio ao provedor.' })
        return
      }

      const cashoutPayload = {
        amount: Number(amount.toFixed(2)),
        pixKey: lumopayPixKey,
        pixKeyType: lumopayPixType,
        description: `Saque PIX #${withdrawalId}`,
      }

      const providerRes = await fetch(LUMOPAY_TRANSFER_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': LUMO_API_KEY,
        },
        body: JSON.stringify(cashoutPayload),
      })

      providerResponsePayload = await providerRes.json().catch(() => ({}))

      if (!providerRes.ok || providerResponsePayload?.success === false) {
        await conn.rollback()
        res.status(502).json({
          ok: false,
          error: String(providerResponsePayload?.message ?? providerResponsePayload?.error ?? 'Falha ao processar saque na Lumopay.'),
          provider: providerResponsePayload,
        })
        return
      }

      providerTransactionId =
        String(
          providerResponsePayload?.data?.external_id ??
          providerResponsePayload?.data?.transaction_id ??
          providerResponsePayload?.transaction_id ??
          providerResponsePayload?.idTransaction ??
          ''
        ).trim() || null

      const providerStatusRaw = String(
        providerResponsePayload?.data?.status ??
        providerResponsePayload?.status ??
        'processing'
      ).toLowerCase()

      nextStatus =
        providerStatusRaw === 'paid' || providerStatusRaw === 'payment.paid'
          ? 'paid'
          : providerStatusRaw === 'failed' || providerStatusRaw === 'canceled' || providerStatusRaw === 'cancelled'
            ? 'failed'
            : 'processing'
    }

    await conn.query(
      `
      UPDATE withdrawals
      SET
        status = ?,
        provider_transaction_id = CASE
          WHEN ? IN ('processing', 'paid') THEN COALESCE(?, provider_transaction_id)
          ELSE provider_transaction_id
        END,
        provider_payload = CASE
          WHEN ? IN ('processing', 'paid') THEN ?
          ELSE provider_payload
        END,
        paid_at = CASE WHEN ? = 'paid' THEN NOW() ELSE paid_at END,
        updated_at = NOW()
      WHERE id = ?
      `,
      [
        nextStatus,
        nextStatus,
        providerTransactionId,
        nextStatus,
        parsedAction === 'approve'
          ? JSON.stringify({
              provider: 'lumopay',
              selectedProvider: parsedProvider,
              processedByAdminId: Number(req.authUser?.id ?? 0),
              processedAt: new Date().toISOString(),
              request: { amount },
              response: providerResponsePayload,
            })
          : null,
        nextStatus,
        withdrawalId,
      ]
    )

    let refunded = false
    if (parsedAction === 'cancel' && shouldRefund && amount > 0 && userId > 0) {
      await conn.query(
        `
        UPDATE users
        SET balance = COALESCE(balance, 0) + ?
        WHERE id = ?
        `,
        [amount, userId]
      )
      refunded = true
    }

    await conn.query(
      `
      CREATE TABLE IF NOT EXISTS logs (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id BIGINT UNSIGNED NULL,
        entity_type VARCHAR(60) NOT NULL,
        entity_id BIGINT UNSIGNED NULL,
        action VARCHAR(100) NOT NULL,
        old_balance DECIMAL(12,2) NULL,
        new_balance DECIMAL(12,2) NULL,
        amount DECIMAL(12,2) NULL,
        metadata JSON NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_logs_user_id (user_id),
        KEY idx_logs_entity_type (entity_type),
        KEY idx_logs_entity_id (entity_id),
        KEY idx_logs_action (action),
        KEY idx_logs_created_at (created_at)
      )
      `
    )

    await conn.query(
      `
      INSERT INTO logs
      (
        user_id,
        entity_type,
        entity_id,
        action,
        amount,
        metadata
      )
      VALUES (?, ?, ?, ?, ?, ?)
      `,
      [
        userId || null,
        'withdrawal',
        withdrawalId,
        parsedAction === 'approve' ? 'admin_withdraw_approved' : 'admin_withdraw_cancelled',
        Number(amount.toFixed(2)),
        JSON.stringify({
          adminId: Number(req.authUser?.id ?? 0),
          refundOnCancel: shouldRefund,
          refunded,
          previousStatus: currentStatus,
          nextStatus,
          provider: parsedAction === 'approve' ? parsedProvider : null,
          providerTransactionId,
        }),
      ]
    )

    await conn.commit()

    res.json({
      ok: true,
      message: parsedAction === 'approve'
        ? `Saque enviado com sucesso para processamento via Lumopay (${parsedProvider.toUpperCase()}).`
        : refunded
          ? 'Saque cancelado e valor estornado com sucesso.'
          : 'Saque cancelado sem estorno.',
      withdrawal: {
        id: withdrawalId,
        status: nextStatus,
        provider: parsedAction === 'approve' ? parsedProvider : null,
        providerTransactionId: parsedAction === 'approve' ? providerTransactionId : null,
      },
      refunded,
    })
  } catch (err) {
    await conn.rollback()
    console.error('[admin-withdrawals-action]', err)
    res.status(500).json({ ok: false, error: 'Erro ao atualizar saque.' })
  } finally {
    conn.release()
  }
})

app.post('/api/admin/migrate-balance-columns', async (_req, res) => {
  try {
    const [balanceCols] = await pool.query<RowDataPacket[]>(
      "SHOW COLUMNS FROM users LIKE 'balance'"
    )

    const [depositCols] = await pool.query<RowDataPacket[]>(
      "SHOW COLUMNS FROM users LIKE 'total_deposits'"
    )

    if (balanceCols.length === 0) {
      await pool.query(
        'ALTER TABLE users ADD COLUMN balance DECIMAL(12,2) NOT NULL DEFAULT 0.00'
      )
    }

    if (depositCols.length === 0) {
      await pool.query(
        'ALTER TABLE users ADD COLUMN total_deposits DECIMAL(12,2) NOT NULL DEFAULT 0.00'
      )
    }

    await pool.query(
      `
      CREATE TABLE IF NOT EXISTS cashin_payments (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id BIGINT UNSIGNED NOT NULL,
        provider_transaction_id VARCHAR(255) NULL,
        amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        method VARCHAR(30) NOT NULL DEFAULT 'pix',
        status VARCHAR(50) NOT NULL DEFAULT 'pending',
        pix_code TEXT NULL,
        qr_image LONGTEXT NULL,
        provider_payload JSON NULL,
        paid_at DATETIME NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_cashin_user_id (user_id),
        UNIQUE KEY uq_cashin_provider_transaction_id (provider_transaction_id)
      )
      `
    )

    await pool.query(
      `
      CREATE TABLE IF NOT EXISTS mining_tasks (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        name VARCHAR(120) NOT NULL,
        description VARCHAR(255) NOT NULL,
        daily_limit INT NOT NULL DEFAULT 1,
        reward_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id)
      )
      `
    )

    await pool.query(
      `
      CREATE TABLE IF NOT EXISTS user_mining_task_progress (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id BIGINT UNSIGNED NOT NULL,
        task_id BIGINT UNSIGNED NOT NULL,
        progress_date DATE NOT NULL,
        completed_count INT NOT NULL DEFAULT 0,
        earned_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_user_task_date (user_id, task_id, progress_date),
        KEY idx_user_progress (user_id, progress_date),
        KEY idx_task_progress (task_id, progress_date)
      )
      `
    )

    await pool.query(
      `
      CREATE TABLE IF NOT EXISTS vip_levels (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        name VARCHAR(80) NOT NULL,
        price DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        daily_task_limit INT NOT NULL DEFAULT 0,
        task_reward_multiplier DECIMAL(10,2) NOT NULL DEFAULT 1.00,
        benefits TEXT NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        sort_order INT NOT NULL DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id)
      )
      `
    )

    await pool.query(
      `
      CREATE TABLE IF NOT EXISTS user_vips (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id BIGINT UNSIGNED NOT NULL,
        vip_level_id BIGINT UNSIGNED NOT NULL,
        status ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
        started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_user_vips_user_id (user_id),
        KEY idx_user_vips_level_id (vip_level_id),
        KEY idx_user_vips_status (status)
      )
      `
    )

    await pool.query(
      `
      CREATE TABLE IF NOT EXISTS vip_purchase_history (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id BIGINT UNSIGNED NOT NULL,
        vip_level_id BIGINT UNSIGNED NOT NULL,
        amount_paid DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        balance_before DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        balance_after DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_vip_purchase_user_id (user_id),
        KEY idx_vip_purchase_level_id (vip_level_id)
      )
      `
    )

    const [vipCountRows] = await pool.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS total FROM vip_levels'
    )

    const totalVips = Number(vipCountRows[0]?.total ?? 0)

    if (totalVips === 0) {
      await pool.query(
        `
        INSERT INTO vip_levels
          (name, price, daily_task_limit, task_reward_multiplier, benefits, is_active, sort_order)
        VALUES
          ('VIP 1', 29.90, 5, 1.10, 'Acesso básico às tarefas VIP', 1, 1),
          ('VIP 2', 59.90, 10, 1.20, 'Limite diário maior + prioridade padrão', 1, 2),
          ('VIP 3', 99.90, 20, 1.35, 'Bônus de comissão intermediário', 1, 3),
          ('VIP 4', 199.90, 35, 1.50, 'Comissão avançada e suporte prioritário', 1, 4),
          ('VIP 5', 399.90, 60, 2.00, 'Plano máximo com maiores ganhos', 1, 5)
        `
      )
    }

    const [taskCountRows] = await pool.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS total FROM mining_tasks'
    )

    const totalTasks = Number(taskCountRows[0]?.total ?? 0)

    if (totalTasks === 0) {
      await pool.query(
        `
        INSERT INTO mining_tasks (name, description, daily_limit, reward_amount, is_active)
        VALUES
          ('Mineração Bronze', 'Execute mineração básica com baixo consumo.', 10, 0.50, 1),
          ('Mineração Prata', 'Mineração intermediária com retorno estável.', 6, 1.00, 1),
          ('Mineração Ouro', 'Mineração avançada com maior recompensa.', 3, 2.50, 1)
        `
      )
    }

    await pool.query(
      `
      CREATE TABLE IF NOT EXISTS roulette_spins (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id BIGINT UNSIGNED NOT NULL,
        prize_label VARCHAR(80) NOT NULL,
        prize_index INT NOT NULL,
        rotation_final DECIMAL(12,4) NOT NULL DEFAULT 0,
        source VARCHAR(30) NOT NULL DEFAULT 'roleta_page',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_roulette_spins_user_id (user_id),
        KEY idx_roulette_spins_created_at (created_at)
      )
      `
    )

    await pool.query(
      `
      CREATE TABLE IF NOT EXISTS daily_checkins (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id BIGINT UNSIGNED NOT NULL,
        checkin_day TINYINT UNSIGNED NOT NULL,
        reward_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        checkin_date DATE NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_daily_checkins_user_day (user_id, checkin_date),
        KEY idx_daily_checkins_user_id (user_id),
        KEY idx_daily_checkins_day (checkin_day)
      )
      `
    )

    res.json({
      ok: true,
      message: 'Migração aplicada: saldo, pagamentos, tarefas de mineração, níveis VIP, roleta e check-in garantidos.',
    })
  } catch (err) {
    console.error('[migrate-balance-columns]', err)
    res.status(500).json({ ok: false, error: 'Falha ao aplicar migração.' })
  }
})

app.get('/api/admin/rankings', requireMaxAdmin, async (_req, res) => {
  try {
    const [referralRows] = await pool.query<RowDataPacket[]>(
      `
      WITH RECURSIVE referral_tree AS (
        SELECT
          u.id AS rootUserId,
          u.id AS currentUserId,
          0 AS lvl
        FROM users u

        UNION ALL

        SELECT
          rt.rootUserId,
          u2.id AS currentUserId,
          rt.lvl + 1 AS lvl
        FROM referral_tree rt
        INNER JOIN users u2 ON u2.referred_by_user_id = rt.currentUserId
        WHERE rt.lvl < 3
      )
      SELECT
        u.id,
        u.name,
        u.phone,
        COALESCE(SUM(CASE WHEN rt.lvl = 1 THEN 1 ELSE 0 END), 0) AS level1Count,
        COALESCE(SUM(CASE WHEN rt.lvl = 2 THEN 1 ELSE 0 END), 0) AS level2Count,
        COALESCE(SUM(CASE WHEN rt.lvl = 3 THEN 1 ELSE 0 END), 0) AS level3Count
      FROM users u
      LEFT JOIN referral_tree rt
        ON rt.rootUserId = u.id
       AND rt.lvl BETWEEN 1 AND 3
      GROUP BY u.id, u.name, u.phone
      ORDER BY (level1Count + level2Count + level3Count) DESC, u.id ASC
      LIMIT 5
      `
    )

    const [balanceRows] = await pool.query<RowDataPacket[]>(
      `
      SELECT
        id,
        name,
        phone,
        COALESCE(balance, 0) AS balance
      FROM users
      ORDER BY COALESCE(balance, 0) DESC, id ASC
      LIMIT 5
      `
    )

    const referrals = referralRows.map((row) => {
      const level1Count = Number(row.level1Count ?? 0)
      const level2Count = Number(row.level2Count ?? 0)
      const level3Count = Number(row.level3Count ?? 0)
      return {
        id: Number(row.id),
        name: String(row.name ?? 'Usuário'),
        phone: String(row.phone ?? '-'),
        level1Count,
        level2Count,
        level3Count,
        totalReferrals: level1Count + level2Count + level3Count,
      }
    })

    const balances = balanceRows.map((row) => ({
      id: Number(row.id),
      name: String(row.name ?? 'Usuário'),
      phone: String(row.phone ?? '-'),
      balance: Number(row.balance ?? 0),
    }))

    res.json({
      ok: true,
      rankings: {
        referrals,
        balances,
      },
    })
  } catch (err) {
    console.error('[admin-rankings]', err)
    res.status(500).json({ ok: false, error: 'Erro ao carregar rankings do admin.' })
  }
})

app.get('/api/admin/users', requireMaxAdmin, async (_req, res) => {
  try {
    await pool.query(
      `
      ALTER TABLE users
      ADD COLUMN is_banned TINYINT(1) NOT NULL DEFAULT 0
      `
    ).catch(() => null)

    const [rows] = await pool.query<RowDataPacket[]>(
      `
      SELECT
        id,
        name,
        phone,
        is_admin,
        COALESCE(is_banned, 0) AS is_banned,
        created_at
      FROM users
      ORDER BY id DESC
      `
    )

    res.json({ ok: true, users: rows })
  } catch (err) {
    console.error('[admin-users-list]', err)
    res.status(500).json({ ok: false, error: 'Falha ao carregar usuários.' })
  }
})

app.put('/api/admin/users/:id', requireMaxAdmin, async (req, res) => {
  const userId = Number(req.params.id)
  const { name, phone } = (req.body ?? {}) as { name?: string; phone?: string }

  if (!userId || Number.isNaN(userId)) {
    res.status(400).json({ ok: false, error: 'ID inválido.' })
    return
  }

  if (!String(name ?? '').trim() || !String(phone ?? '').trim()) {
    res.status(400).json({ ok: false, error: 'Nome e telefone são obrigatórios.' })
    return
  }

  try {
    const [result] = await pool.query(
      `
      UPDATE users
      SET name = ?, phone = ?
      WHERE id = ?
      `,
      [String(name).trim(), String(phone).trim(), userId]
    )

    const affected = Number((result as { affectedRows?: number }).affectedRows ?? 0)
    if (affected === 0) {
      res.status(404).json({ ok: false, error: 'Usuário não encontrado.' })
      return
    }

    res.json({ ok: true, message: 'Usuário atualizado com sucesso.' })
  } catch (err) {
    console.error('[admin-users-update]', err)
    res.status(500).json({ ok: false, error: 'Falha ao atualizar usuário.' })
  }
})

app.delete('/api/admin/users/:id', requireMaxAdmin, async (req, res) => {
  const userId = Number(req.params.id)

  if (!userId || Number.isNaN(userId)) {
    res.status(400).json({ ok: false, error: 'ID inválido.' })
    return
  }

  try {
    const [result] = await pool.query(
      `
      DELETE FROM users
      WHERE id = ?
      `,
      [userId]
    )

    const affected = Number((result as { affectedRows?: number }).affectedRows ?? 0)
    if (affected === 0) {
      res.status(404).json({ ok: false, error: 'Usuário não encontrado.' })
      return
    }

    res.json({ ok: true, message: 'Usuário apagado com sucesso.' })
  } catch (err) {
    console.error('[admin-users-delete]', err)
    res.status(500).json({ ok: false, error: 'Falha ao apagar usuário.' })
  }
})

app.patch('/api/admin/users/:id/ban', requireMaxAdmin, async (req, res) => {
  const userId = Number(req.params.id)
  const isBanned = Number((req.body as { is_banned?: number })?.is_banned ?? 0) ? 1 : 0

  if (!userId || Number.isNaN(userId)) {
    res.status(400).json({ ok: false, error: 'ID inválido.' })
    return
  }

  try {
    await pool.query(
      `
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS is_banned TINYINT(1) NOT NULL DEFAULT 0
      `
    )

    const [result] = await pool.query(
      `
      UPDATE users
      SET is_banned = ?
      WHERE id = ?
      `,
      [isBanned, userId]
    )

    const affected = Number((result as { affectedRows?: number }).affectedRows ?? 0)
    if (affected === 0) {
      res.status(404).json({ ok: false, error: 'Usuário não encontrado.' })
      return
    }

    res.json({ ok: true, message: isBanned ? 'Usuário banido.' : 'Usuário desbanido.' })
  } catch (err) {
    console.error('[admin-users-ban]', err)
    res.status(500).json({ ok: false, error: 'Falha ao alterar banimento.' })
  }
})

app.post('/api/admin/users/:id/balance', requireMaxAdmin, async (req: AuthenticatedRequest, res) => {
  const userId = Number(req.params.id)
  const { amount, operation, reason } = (req.body ?? {}) as {
    amount?: number | string
    operation?: 'add' | 'subtract'
    reason?: string
  }

  const parsedAmount = Number(String(amount ?? '').replace(',', '.'))
  const parsedOperation = String(operation ?? '').trim() as 'add' | 'subtract'
  const parsedReason = String(reason ?? '').trim()

  if (!userId || Number.isNaN(userId)) {
    res.status(400).json({ ok: false, error: 'ID inválido.' })
    return
  }

  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    res.status(400).json({ ok: false, error: 'Valor inválido.' })
    return
  }

  if (!['add', 'subtract'].includes(parsedOperation)) {
    res.status(400).json({ ok: false, error: 'Operação inválida. Use add ou subtract.' })
    return
  }

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    await conn.query(
      `
      CREATE TABLE IF NOT EXISTS logs (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id BIGINT UNSIGNED NULL,
        entity_type VARCHAR(60) NOT NULL,
        entity_id BIGINT UNSIGNED NULL,
        action VARCHAR(100) NOT NULL,
        old_balance DECIMAL(12,2) NULL,
        new_balance DECIMAL(12,2) NULL,
        amount DECIMAL(12,2) NULL,
        metadata JSON NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_logs_user_id (user_id),
        KEY idx_logs_entity_type (entity_type),
        KEY idx_logs_entity_id (entity_id),
        KEY idx_logs_action (action),
        KEY idx_logs_created_at (created_at)
      )
      `
    )

    const [rows] = await conn.query<RowDataPacket[]>(
      'SELECT id, balance FROM users WHERE id = ? LIMIT 1 FOR UPDATE',
      [userId]
    )

    if (rows.length === 0) {
      await conn.rollback()
      res.status(404).json({ ok: false, error: 'Usuário não encontrado.' })
      return
    }

    const currentBalance = Number(rows[0].balance ?? 0)
    const roundedAmount = Number(parsedAmount.toFixed(2))
    const nextBalance =
      parsedOperation === 'add'
        ? Number((currentBalance + roundedAmount).toFixed(2))
        : Number((currentBalance - roundedAmount).toFixed(2))

    if (parsedOperation === 'subtract' && nextBalance < 0) {
      await conn.rollback()
      res.status(400).json({
        ok: false,
        error: 'Saldo insuficiente para retirar esse valor.',
        balance: currentBalance,
      })
      return
    }

    await conn.query(
      `
      UPDATE users
      SET balance = ?
      WHERE id = ?
      `,
      [nextBalance, userId]
    )

    const action = parsedOperation === 'add' ? 'admin_balance_add' : 'admin_balance_subtract'

    await conn.query(
      `
      INSERT INTO logs
      (
        user_id,
        entity_type,
        entity_id,
        action,
        old_balance,
        new_balance,
        amount,
        metadata
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        userId,
        'user',
        userId,
        action,
        Number(currentBalance.toFixed(2)),
        nextBalance,
        roundedAmount,
        JSON.stringify({
          adminId: Number(req.authUser?.id ?? 0),
          reason: parsedReason || null,
          operation: parsedOperation,
        }),
      ]
    )

    await conn.commit()

    res.json({
      ok: true,
      message: parsedOperation === 'add' ? 'Saldo adicionado com sucesso.' : 'Saldo retirado com sucesso.',
      balanceBefore: Number(currentBalance.toFixed(2)),
      balanceAfter: nextBalance,
      amount: roundedAmount,
      operation: parsedOperation,
    })
  } catch (err) {
    await conn.rollback()
    console.error('[admin-user-balance]', err)
    res.status(500).json({ ok: false, error: 'Falha ao ajustar saldo do usuário.' })
  } finally {
    conn.release()
  }
})

app.get('/api/admin/logs', requireMaxAdmin, async (req, res) => {
  const category = String(req.query.category ?? 'all').trim().toLowerCase()
  const rawLimit = Number(req.query.limit ?? 300)
  const limit = Math.min(Math.max(rawLimit, 1), 1000)

  try {
    await pool.query(
      `
      CREATE TABLE IF NOT EXISTS logs (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id BIGINT UNSIGNED NULL,
        entity_type VARCHAR(60) NOT NULL,
        entity_id BIGINT UNSIGNED NULL,
        action VARCHAR(100) NOT NULL,
        old_balance DECIMAL(12,2) NULL,
        new_balance DECIMAL(12,2) NULL,
        amount DECIMAL(12,2) NULL,
        metadata JSON NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_logs_user_id (user_id),
        KEY idx_logs_entity_type (entity_type),
        KEY idx_logs_entity_id (entity_id),
        KEY idx_logs_action (action),
        KEY idx_logs_created_at (created_at)
      )
      `
    )

    const [rows] = await pool.query<RowDataPacket[]>(
      `
      SELECT
        l.id,
        l.user_id AS userId,
        l.entity_type AS entityType,
        l.entity_id AS entityId,
        l.action,
        l.old_balance AS oldBalance,
        l.new_balance AS newBalance,
        l.amount,
        l.metadata,
        l.created_at AS createdAt,
        u.name AS userName,
        u.phone AS userPhone
      FROM logs l
      LEFT JOIN users u ON u.id = l.user_id
      ORDER BY l.id DESC
      LIMIT ?
      `,
      [limit]
    )

    type LogCategory = 'withdraw' | 'deposit' | 'balance' | 'security' | 'gift_code' | 'checkin' | 'vip' | 'cycle' | 'other'

    const resolveCategory = (actionRaw: string, entityTypeRaw: string): LogCategory => {
      const action = String(actionRaw ?? '').toLowerCase()
      const entityType = String(entityTypeRaw ?? '').toLowerCase()

      if (action.includes('withdraw') || entityType === 'withdrawal') return 'withdraw'
      if (action.includes('cashin') || action.includes('deposit') || entityType === 'cashin') return 'deposit'
      if (action.includes('balance') || action.includes('admin_balance')) return 'balance'
      if (action.includes('password') || action.includes('login') || action.includes('security')) return 'security'
      if (action.includes('gift') || action.includes('code')) return 'gift_code'
      if (action.includes('checkin')) return 'checkin'
      if (action.includes('vip')) return 'vip'
      if (action.includes('cycle')) return 'cycle'
      return 'other'
    }

    const parseMetadata = (value: unknown) => {
      if (value == null) return null
      if (typeof value === 'object') return value as Record<string, unknown>
      const raw = String(value).trim()
      if (!raw) return null
      try {
        return JSON.parse(raw) as Record<string, unknown>
      } catch {
        return { raw }
      }
    }

    const mapped = rows.map((row) => {
      const parsedCategory = resolveCategory(String(row.action ?? ''), String(row.entityType ?? ''))
      return {
        id: Number(row.id),
        userId: row.userId == null ? null : Number(row.userId),
        userName: row.userName == null ? null : String(row.userName),
        userPhone: row.userPhone == null ? null : String(row.userPhone),
        entityType: String(row.entityType ?? ''),
        entityId: row.entityId == null ? null : Number(row.entityId),
        action: String(row.action ?? ''),
        category: parsedCategory,
        oldBalance: row.oldBalance == null ? null : Number(row.oldBalance),
        newBalance: row.newBalance == null ? null : Number(row.newBalance),
        amount: row.amount == null ? null : Number(row.amount),
        metadata: parseMetadata(row.metadata),
        createdAt: row.createdAt ? String(row.createdAt) : null,
      }
    })

    const filtered = category === 'all'
      ? mapped
      : mapped.filter((item) => item.category === category)

    const grouped = {
      withdraw: filtered.filter((item) => item.category === 'withdraw'),
      deposit: filtered.filter((item) => item.category === 'deposit'),
      balance: filtered.filter((item) => item.category === 'balance'),
      security: filtered.filter((item) => item.category === 'security'),
      gift_code: filtered.filter((item) => item.category === 'gift_code'),
      checkin: filtered.filter((item) => item.category === 'checkin'),
      vip: filtered.filter((item) => item.category === 'vip'),
      cycle: filtered.filter((item) => item.category === 'cycle'),
      other: filtered.filter((item) => item.category === 'other'),
    }

    res.json({
      ok: true,
      filter: { category, limit },
      total: filtered.length,
      logs: filtered,
      grouped,
    })
  } catch (err) {
    console.error('[admin-logs-list]', err)
    res.status(500).json({ ok: false, error: 'Falha ao carregar logs administrativos.' })
  }
})

app.get('/api/admin/users/:id/details', requireMaxAdmin, async (req, res) => {
  const userId = Number(req.params.id)

  if (!userId || Number.isNaN(userId)) {
    res.status(400).json({ ok: false, error: 'ID inválido.' })
    return
  }

  try {
    await pool.query(
      `
      ALTER TABLE users
      ADD COLUMN is_banned TINYINT(1) NOT NULL DEFAULT 0
      `
    ).catch(() => null)

    const [userRows] = await pool.query<RowDataPacket[]>(
      `
      SELECT
        id,
        name,
        phone,
        is_admin,
        COALESCE(is_banned, 0) AS is_banned,
        created_at,
        COALESCE(balance, 0) AS balance
      FROM users
      WHERE id = ?
      LIMIT 1
      `,
      [userId]
    )

    if (userRows.length === 0) {
      res.status(404).json({ ok: false, error: 'Usuário não encontrado.' })
      return
    }

    const [depositRows] = await pool.query<RowDataPacket[]>(
      `
      SELECT COALESCE(SUM(amount), 0) AS total
      FROM cashin_payments
      WHERE user_id = ?
        AND LOWER(status) IN ('paid', 'payment.paid')
      `,
      [userId]
    )

    let totalWithdrawals = 0
    try {
      const [withdrawRows] = await pool.query<RowDataPacket[]>(
        `
        SELECT COALESCE(SUM(amount), 0) AS total
        FROM withdrawals
        WHERE user_id = ?
        `,
        [userId]
      )
      totalWithdrawals = Number(withdrawRows[0]?.total ?? 0)
    } catch {
      totalWithdrawals = 0
    }

    let totalCyclePlansBought = 0
    try {
      const [cycleRows] = await pool.query<RowDataPacket[]>(
        `
        SELECT COUNT(*) AS total
        FROM user_cycle_purchases
        WHERE user_id = ?
        `,
        [userId]
      )
      totalCyclePlansBought = Number(cycleRows[0]?.total ?? 0)
    } catch {
      totalCyclePlansBought = 0
    }

    let totalVipPlansBought = 0
    try {
      const [vipRows] = await pool.query<RowDataPacket[]>(
        `
        SELECT COUNT(*) AS total
        FROM vip_purchase_history
        WHERE user_id = ?
        `,
        [userId]
      )
      totalVipPlansBought = Number(vipRows[0]?.total ?? 0)
    } catch {
      totalVipPlansBought = 0
    }

    let accountLogs: Array<{
      id: number
      action: string
      old_balance: number | null
      new_balance: number | null
      amount: number | null
      metadata: string | null
      created_at: string | null
    }> = []

    try {
      const [logRows] = await pool.query<RowDataPacket[]>(
        `
        SELECT
          id,
          action,
          old_balance,
          new_balance,
          amount,
          metadata,
          created_at
        FROM logs
        WHERE user_id = ?
           OR (entity_type = 'user' AND entity_id = ?)
        ORDER BY id DESC
        LIMIT 100
        `,
        [userId, userId]
      )
      accountLogs = logRows.map((row) => ({
        id: Number(row.id),
        action: String(row.action ?? ''),
        old_balance: row.old_balance == null ? null : Number(row.old_balance),
        new_balance: row.new_balance == null ? null : Number(row.new_balance),
        amount: row.amount == null ? null : Number(row.amount),
        metadata: row.metadata == null ? null : String(row.metadata),
        created_at: row.created_at ? String(row.created_at) : null,
      }))
    } catch {
      accountLogs = []
    }

    let vipPurchases: Array<{ id: number; planName: string; amountPaid: number; createdAt: string | null }> = []
    try {
      const [vipRows] = await pool.query<RowDataPacket[]>(
        `
        SELECT
          vph.id,
          COALESCE(vl.name, CONCAT('VIP #', vph.vip_level_id)) AS planName,
          vph.amount_paid AS amountPaid,
          vph.created_at AS createdAt
        FROM vip_purchase_history vph
        LEFT JOIN vip_levels vl ON vl.id = vph.vip_level_id
        WHERE vph.user_id = ?
        ORDER BY vph.id DESC
        `,
        [userId]
      )
      vipPurchases = vipRows.map((row) => ({
        id: Number(row.id),
        planName: String(row.planName ?? 'VIP'),
        amountPaid: Number(row.amountPaid ?? 0),
        createdAt: row.createdAt ? String(row.createdAt) : null,
      }))
    } catch {
      vipPurchases = []
    }

    let cyclePurchases: Array<{ id: number; planName: string; amountPaid: number; createdAt: string | null }> = []
    try {
      const [cycleRowsDetailed] = await pool.query<RowDataPacket[]>(
        `
        SELECT
          ucp.id,
          COALESCE(cp.name, CONCAT('Plano #', ucp.cycle_product_id)) AS planName,
          ucp.amount_paid AS amountPaid,
          ucp.created_at AS createdAt
        FROM user_cycle_purchases ucp
        LEFT JOIN cycle_products cp ON cp.id = ucp.cycle_product_id
        WHERE ucp.user_id = ?
        ORDER BY ucp.id DESC
        `,
        [userId]
      )
      cyclePurchases = cycleRowsDetailed.map((row) => ({
        id: Number(row.id),
        planName: String(row.planName ?? 'Plano de ciclo'),
        amountPaid: Number(row.amountPaid ?? 0),
        createdAt: row.createdAt ? String(row.createdAt) : null,
      }))
    } catch {
      cyclePurchases = []
    }

    let giftCodeRedemptions: Array<{
      id: number
      code: string
      rewardType: string
      rewardValue: number
      createdAt: string | null
    }> = []

    try {
      const [giftRows] = await pool.query<RowDataPacket[]>(
        `
        SELECT
          gcr.id,
          COALESCE(gc.code, '-') AS code,
          gcr.reward_type AS rewardType,
          gcr.reward_value AS rewardValue,
          gcr.created_at AS createdAt
        FROM gift_code_redemptions gcr
        LEFT JOIN gift_codes gc ON gc.id = gcr.gift_code_id
        WHERE gcr.user_id = ?
        ORDER BY gcr.id DESC
        `,
        [userId]
      )

      giftCodeRedemptions = giftRows.map((row) => ({
        id: Number(row.id),
        code: String(row.code ?? '-'),
        rewardType: String(row.rewardType ?? ''),
        rewardValue: Number(row.rewardValue ?? 0),
        createdAt: row.createdAt ? String(row.createdAt) : null,
      }))
    } catch {
      giftCodeRedemptions = []
    }

    let dailyCheckinRedemptions: Array<{
      id: number
      checkinDay: number
      rewardAmount: number
      checkinDate: string | null
      createdAt: string | null
    }> = []

    try {
      const [checkinRows] = await pool.query<RowDataPacket[]>(
        `
        SELECT
          id,
          checkin_day AS checkinDay,
          reward_amount AS rewardAmount,
          checkin_date AS checkinDate,
          created_at AS createdAt
        FROM daily_checkins
        WHERE user_id = ?
        ORDER BY id DESC
        `,
        [userId]
      )

      dailyCheckinRedemptions = checkinRows.map((row) => ({
        id: Number(row.id),
        checkinDay: Number(row.checkinDay ?? 0),
        rewardAmount: Number(row.rewardAmount ?? 0),
        checkinDate: row.checkinDate ? String(row.checkinDate) : null,
        createdAt: row.createdAt ? String(row.createdAt) : null,
      }))
    } catch {
      dailyCheckinRedemptions = []
    }

    const buildMembersByLevel = async (level: 1 | 2 | 3) => {
      const [rows] = await pool.query<RowDataPacket[]>(
        `
        WITH RECURSIVE referral_tree AS (
          SELECT
            u.id,
            u.name,
            u.phone,
            u.created_at AS createdAt,
            u.referred_by_user_id,
            1 AS level
          FROM users u
          WHERE u.referred_by_user_id = ?

          UNION ALL

          SELECT
            u2.id,
            u2.name,
            u2.phone,
            u2.created_at AS createdAt,
            u2.referred_by_user_id,
            rt.level + 1 AS level
          FROM users u2
          INNER JOIN referral_tree rt ON u2.referred_by_user_id = rt.id
          WHERE rt.level < 3
        )
        SELECT
          rt.id,
          rt.name,
          rt.phone,
          rt.createdAt,
          COALESCE(SUM(CASE WHEN LOWER(cp.status) IN ('paid','payment.paid') THEN cp.amount ELSE 0 END), 0) AS totalDepositsPaid,
          MAX(CASE WHEN LOWER(cp.status) IN ('paid','payment.paid') THEN 1 ELSE 0 END) AS hasDeposit
        FROM referral_tree rt
        LEFT JOIN cashin_payments cp ON cp.user_id = rt.id
        WHERE rt.level = ?
        GROUP BY rt.id, rt.name, rt.phone, rt.createdAt
        ORDER BY rt.createdAt DESC
        `,
        [userId, level]
      )

      return rows.map((row) => ({
        id: Number(row.id),
        name: String(row.name ?? 'Usuário'),
        phone: String(row.phone ?? '-'),
        createdAt: row.createdAt ? String(row.createdAt) : null,
        hasDeposit: Number(row.hasDeposit ?? 0) === 1,
        totalDepositsPaid: Number(row.totalDepositsPaid ?? 0),
      }))
    }

    let referralsLevel1: Array<{
      id: number
      name: string
      phone: string
      createdAt: string | null
      hasDeposit: boolean
      totalDepositsPaid: number
    }> = []

    let referralsLevel2: typeof referralsLevel1 = []
    let referralsLevel3: typeof referralsLevel1 = []

    try {
      referralsLevel1 = await buildMembersByLevel(1)
      referralsLevel2 = await buildMembersByLevel(2)
      referralsLevel3 = await buildMembersByLevel(3)
    } catch {
      referralsLevel1 = []
      referralsLevel2 = []
      referralsLevel3 = []
    }

    const user = userRows[0]
    res.json({
      ok: true,
      user: {
        id: Number(user.id),
        name: String(user.name ?? ''),
        phone: String(user.phone ?? ''),
        is_admin: Number(user.is_admin ?? 0),
        is_banned: Number(user.is_banned ?? 0),
        created_at: user.created_at,
        balance: Number(user.balance ?? 0),
        totalDepositsPaid: Number(depositRows[0]?.total ?? 0),
        totalWithdrawals,
        totalCyclePlansBought,
        totalVipPlansBought,
        accountLogs,
        vipPurchases,
        cyclePurchases,
        giftCodeRedemptions,
        dailyCheckinRedemptions,
        referralsLevel1,
        referralsLevel2,
        referralsLevel3,
      },
    })
  } catch (err) {
    console.error('[admin-user-details]', err)
    res.status(500).json({ ok: false, error: 'Falha ao carregar detalhes do usuário.' })
  }
})

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason)
})

process.on('uncaughtException', (error) => {
  console.error('[uncaughtException]', error)
})

app.use((req, _res, next) => {
  const startedAt = Date.now()
  const requestId = Math.random().toString(36).slice(2, 10)

  console.log(`[http] -> id=${requestId} ${req.method} ${req.originalUrl}`)

  _res.on('finish', () => {
    const ms = Date.now() - startedAt
    console.log(
      `[http] <- id=${requestId} ${req.method} ${req.originalUrl} status=${_res.statusCode} ${ms}ms`
    )
  })

  next()
})

app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`)
  console.log('📋 HTTP request logging: enabled')
  console.log('🧯 Global error logging: enabled')
})
