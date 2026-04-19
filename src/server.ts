import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import { createServer } from 'http'
import { Server as SocketIOServer } from 'socket.io'
import pool, { DB_HOST, DB_NAME, DB_PASSWORD, DB_PORT, DB_USER } from './db'
import type { NextFunction, Request, Response } from 'express'
import type { RowDataPacket, ResultSetHeader } from 'mysql2'
import mysql from 'mysql2/promise'

dotenv.config()

const app  = express()
const httpServer = createServer(app)
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
})
const PORT = process.env.PORT     ?? 3333
const JWT_SECRET   = process.env.JWT_SECRET   ?? 'fallback_secret'
const JWT_EXPIRES  = process.env.JWT_EXPIRES_IN ?? '7d'
const LUMO_API_KEY = 'pk_69aa7a3d1a07dffe750eb533c92fabbe87974479ed791fb7ead328a56e67143d'
const LUMO_WEBHOOK_SECRET = 'sk_8910b90244b35ab56342bc3c019e569bb59abb9a90a7f69ad1dd59ce59ebd1065dc6240536d0a7b2e69496f8bac1dcdb739d22767183e2421b590f1fbfb77e39'
const LUMOPAY_TRANSFER_URL = 'https://api.lumopayment.com/api/payments/transfers/pix'
const SAO_PAULO_TZ = 'America/Sao_Paulo'

let telegramPollingStarted = false
let telegramPollingInterval: NodeJS.Timeout | null = null
let telegramUpdateOffset = 0
const telegramProcessedMessageKeys = new Set<string>()

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

const ensureDatabaseExists = async () => {
  const conn = await mysql.createConnection({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD,
    charset: 'utf8mb4',
  })

  try {
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`)
    console.log(`[db] database garantido: ${DB_NAME}@${DB_HOST}:${DB_PORT}`)
  } finally {
    await conn.end()
  }
}

const ensureTelegramConfigTable = async () => {
  await pool.query(
    `
    CREATE TABLE IF NOT EXISTS system_telegram_config (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      singleton_key TINYINT UNSIGNED NOT NULL DEFAULT 1,
      bot_token VARCHAR(255) NOT NULL DEFAULT '',
      group_id VARCHAR(255) NOT NULL DEFAULT '',
      welcome_message TEXT NULL,
        private_chat_only_message TEXT NULL,
        private_link_success_message TEXT NULL,
        checkin_success_message TEXT NULL,
        checkin_already_claimed_message TEXT NULL,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_system_telegram_config_singleton (singleton_key)
    )
    `
  )

  try {
    await pool.query(
      `
      ALTER TABLE system_telegram_config
      ADD COLUMN singleton_key TINYINT UNSIGNED NOT NULL DEFAULT 1
      `
    )
  } catch {
    // coluna já existe
  }

  try {
    await pool.query(
      `
      ALTER TABLE system_telegram_config
      ADD UNIQUE KEY uq_system_telegram_config_singleton (singleton_key)
      `
    )
  } catch {
    // índice já existe
  }

  await pool.query(
    `
    UPDATE system_telegram_config
    SET singleton_key = 1
    WHERE singleton_key IS NULL OR singleton_key <> 1
    `
  )

  try {
    await pool.query(
      `
      ALTER TABLE system_telegram_config
      ADD COLUMN private_chat_only_message TEXT NULL
      `
    )
  } catch {
    // coluna já existe
  }

  try {
    await pool.query(
      `
      ALTER TABLE system_telegram_config
      ADD COLUMN private_link_success_message TEXT NULL
      `
    )
  } catch {
    // coluna já existe
  }

  try {
    await pool.query(
      `
      ALTER TABLE system_telegram_config
      ADD COLUMN duplicate_connection_message TEXT NULL
      `
    )
  } catch {
    // coluna já existe
  }

  try {
    await pool.query(
      `
      ALTER TABLE system_telegram_config
      ADD COLUMN checkin_success_message TEXT NULL
      `
    )
  } catch {
    // coluna já existe
  }

  try {
    await pool.query(
      `
      ALTER TABLE system_telegram_config
      ADD COLUMN checkin_already_claimed_message TEXT NULL
      `
    )
  } catch {
    // coluna já existe
  }

  try {
    await pool.query(
      `
      ALTER TABLE system_telegram_config
      ADD COLUMN logs_group_id VARCHAR(255) NOT NULL DEFAULT ''
      `
    )
  } catch {
    // coluna já existe
  }

  await pool.query(
    `
    INSERT IGNORE INTO system_telegram_config (
      singleton_key,
      bot_token,
      group_id,
      welcome_message,
      private_chat_only_message,
      private_link_success_message
    )
    VALUES (
      1,
      '',
      '',
      '',
      'Conexão permitida somente no chat privado do bot.',
      'Conta conectada com sucesso.'
    )
    `
  )

  await pool.query(
    `
    UPDATE system_telegram_config
    SET private_chat_only_message = 'Conexão permitida somente no chat privado do bot.'
    WHERE private_chat_only_message IS NULL OR TRIM(private_chat_only_message) = ''
    `
  )

  await pool.query(
    `
    UPDATE system_telegram_config
    SET private_link_success_message = 'Conta conectada com sucesso.'
    WHERE private_link_success_message IS NULL OR TRIM(private_link_success_message) = ''
    `
  )

  await pool.query(
    `
    UPDATE system_telegram_config
    SET duplicate_connection_message = 'Esta conta já foi conectada anteriormente e não pode ser vinculada novamente.'
    WHERE duplicate_connection_message IS NULL OR TRIM(duplicate_connection_message) = ''
    `
  )

  await pool.query(
    `
    UPDATE system_telegram_config
    SET checkin_success_message = 'Check-in do dia {day} resgatado com sucesso!'
    WHERE checkin_success_message IS NULL OR TRIM(checkin_success_message) = ''
    `
  )

  await pool.query(
    `
    UPDATE system_telegram_config
    SET checkin_already_claimed_message = 'Check-in de hoje já foi resgatado.'
    WHERE checkin_already_claimed_message IS NULL OR TRIM(checkin_already_claimed_message) = ''
    `
  )
}

const ensureUserTelegramConnectionsTable = async () => {
  await pool.query(
    `
    CREATE TABLE IF NOT EXISTS user_telegram_connections (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id BIGINT UNSIGNED NOT NULL,
      phone VARCHAR(40) NOT NULL,
      telegram_chat_id VARCHAR(80) NOT NULL,
      telegram_user_id VARCHAR(80) NOT NULL,
      telegram_username VARCHAR(120) NULL,
      telegram_first_name VARCHAR(120) NULL,
      is_connected TINYINT(1) NOT NULL DEFAULT 1,
      connected_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_user_telegram_user_id (user_id),
      UNIQUE KEY uq_user_telegram_chat_id (telegram_chat_id),
      KEY idx_user_telegram_phone (phone)
    )
    `
  )
}

const ensureTelegramConnectedColumn = async () => {
  try {
    await pool.query(
      `
      ALTER TABLE users
      ADD COLUMN telegram_conectado TINYINT(1) NOT NULL DEFAULT 0
      `
    )
  } catch {
    // coluna já existe
  }
}

const ensureTelegramConnectedSync = async () => {
  try {
    await pool.query(
      `
      UPDATE users u
      INNER JOIN user_telegram_connections utc ON utc.user_id = u.id
      SET u.telegram_conectado = 1
      WHERE COALESCE(utc.is_connected, 1) = 1
      `
    )

    await pool.query(
      `
      UPDATE users u
      INNER JOIN (
        SELECT DISTINCT REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') AS normalized_phone
        FROM user_telegram_connections
        WHERE phone IS NOT NULL AND TRIM(phone) <> ''
      ) t ON (
        CONVERT(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(u.phone, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') USING utf8mb4) COLLATE utf8mb4_unicode_ci
        =
        CONVERT(t.normalized_phone USING utf8mb4) COLLATE utf8mb4_unicode_ci
      )
      SET u.telegram_conectado = 1
      `
    )
  } catch (err) {
    console.error('[ensure-telegram-connected-sync]', err)
  }
}

const normalizePhoneForCompare = (value: string) => String(value ?? '').replace(/\D/g, '')

const ensureWithdrawActivationTokensTable = async () => {
  await pool.query(
    `
    CREATE TABLE IF NOT EXISTS withdraw_activation_tokens (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id BIGINT UNSIGNED NOT NULL,
      token VARCHAR(64) NOT NULL,
      status ENUM('pending','activated','expired') NOT NULL DEFAULT 'pending',
      telegram_user_id VARCHAR(80) NULL,
      activated_chat_id VARCHAR(80) NULL,
      activated_at DATETIME NULL,
      expires_at DATETIME NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_withdraw_activation_tokens_token (token),
      KEY idx_withdraw_activation_tokens_user (user_id),
      KEY idx_withdraw_activation_tokens_status (status),
      KEY idx_withdraw_activation_tokens_expires_at (expires_at)
    )
    `
  )
}

const createWithdrawActivationToken = async (userId: number) => {
  const parsedUserId = Number(userId)
  if (!parsedUserId || Number.isNaN(parsedUserId)) {
    throw new Error('ID de usuário inválido para gerar token.')
  }

  await ensureWithdrawActivationTokensTable()

  const token = crypto.randomBytes(8).toString('hex').slice(0, 16)
  await pool.query(
    `
    UPDATE withdraw_activation_tokens
    SET status = 'expired', updated_at = NOW()
    WHERE user_id = ?
      AND status = 'pending'
    `,
    [parsedUserId]
  )

  await pool.query(
    `
    INSERT INTO withdraw_activation_tokens
    (user_id, token, status, expires_at)
    VALUES (?, ?, 'pending', DATE_ADD(NOW(), INTERVAL 30 MINUTE))
    `,
    [parsedUserId, token]
  )

  return token
}

const sendTelegramMessage = async (
  botToken: string,
  chatId: string,
  text: string,
  options?: {
    replyMarkup?: Record<string, unknown>
    parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML'
    replyToMessageId?: number
  }
) => {
  if (!botToken || !chatId) return
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        ...(options?.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
        ...(options?.parseMode ? { parse_mode: options.parseMode } : {}),
        ...(Number.isInteger(options?.replyToMessageId)
          ? { reply_to_message_id: Number(options?.replyToMessageId), allow_sending_without_reply: true }
          : {}),
      }),
    })
  } catch (err) {
    console.error('[telegram-send-message]', err)
  }
}

// Envia mensagem para o grupo de logs configurado no banco
const sendTelegramLog = async (text: string) => {
  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT bot_token AS botToken, logs_group_id AS logsGroupId
       FROM system_telegram_config
       WHERE TRIM(bot_token) <> '' AND TRIM(COALESCE(logs_group_id,'')) <> ''
       LIMIT 1`
    )
    if (!rows.length) return
    const botToken = String(rows[0].botToken ?? '')
    const logsGroupId = String(rows[0].logsGroupId ?? '')
    if (!botToken || !logsGroupId) return
    await sendTelegramMessage(botToken, logsGroupId, text, { parseMode: 'HTML' })
  } catch (err) {
    console.error('[telegram-log]', err)
  }
}

const claimCheckinForUser = async (userId: number) => {
  const parsedUserId = Number(userId)
  if (!parsedUserId || Number.isNaN(parsedUserId)) {
    return { ok: false as const, status: 400, error: 'ID de usuário inválido.' }
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
      return { ok: false as const, status: 404, error: 'Usuário não encontrado.' }
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
      return { ok: false as const, status: 400, error: 'Check-in de hoje já foi resgatado.' }
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
    const rewardAmount = Number(rewards[checkinDay - 1] ?? 1)

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

    return {
      ok: true as const,
      status: 200,
      message: `Check-in do dia ${checkinDay} resgatado com sucesso!`,
      claim: {
        day: checkinDay,
        rewardAmount,
        checkinDate: new Date().toISOString(),
      },
      balance: Number(updatedRows[0]?.balance ?? 0),
    }
  } catch (err) {
    await conn.rollback()
    console.error('[checkin-claim]', err)
    return { ok: false as const, status: 500, error: 'Erro ao resgatar check-in.' }
  } finally {
    conn.release()
  }
}

const processTelegramUpdates = async () => {
  try {
    await ensureTelegramConfigTable()
    await ensureUserTelegramConnectionsTable()
    await ensureTelegramConnectedColumn()
    await ensureTelegramConnectedSync()

    const [configRows] = await pool.query<RowDataPacket[]>(
      `
      SELECT
        bot_token AS botToken,
        group_id AS groupId,
        welcome_message AS welcomeMessage,
        private_chat_only_message AS privateChatOnlyMessage,
        private_link_success_message AS privateLinkSuccessMessage,
        duplicate_connection_message AS duplicateConnectionMessage,
        checkin_success_message AS checkinSuccessMessage,
        checkin_already_claimed_message AS checkinAlreadyClaimedMessage
      FROM system_telegram_config
      WHERE TRIM(bot_token) <> ''
      ORDER BY id ASC
      LIMIT 1
      `
    )

    if (configRows.length === 0) return

    const botToken = String(configRows[0].botToken ?? '').trim()
    const configuredGroupId = String(configRows[0].groupId ?? '').trim()
    const welcomeMessage = String(configRows[0].welcomeMessage ?? '').trim()
    const privateChatOnlyMessage =
      String(configRows[0].privateChatOnlyMessage ?? '').trim() ||
      'Conexão permitida somente no chat privado do bot.'
    const privateLinkSuccessMessage =
      String(configRows[0].privateLinkSuccessMessage ?? '').trim() || 'Conta conectada com sucesso.'
    const duplicateConnectionMessage =
      String(configRows[0].duplicateConnectionMessage ?? '').trim() ||
      'Esta conta já foi conectada anteriormente e não pode ser vinculada novamente.'
    const configuredCheckinSuccessMessage =
      String(configRows[0].checkinSuccessMessage ?? '').trim() ||
      'Check-in do dia {day} resgatado com sucesso!'
    const configuredCheckinAlreadyClaimedMessage =
      String(configRows[0].checkinAlreadyClaimedMessage ?? '').trim() ||
      'Check-in de hoje já foi resgatado.'
    if (!botToken) return

    const updatesUrl = `https://api.telegram.org/bot${botToken}/getUpdates?timeout=25${telegramUpdateOffset > 0 ? `&offset=${telegramUpdateOffset}` : ''}`
    const updatesRes = await fetch(updatesUrl)
    const updatesData = await updatesRes.json() as any

    if (!updatesRes.ok || !updatesData?.ok || !Array.isArray(updatesData?.result)) {
      return
    }

    for (const update of updatesData.result) {
      const updateId = Number(update?.update_id ?? 0)
      if (updateId > 0) telegramUpdateOffset = updateId + 1

      const message = update?.message
      if (!message) continue

      const chatId = String(message?.chat?.id ?? '').trim()
      const chatType = String(message?.chat?.type ?? '').trim().toLowerCase()
      const messageId = Number(message?.message_id ?? 0)
      const telegramReplyOptions =
        Number.isInteger(messageId) && messageId > 0
          ? { replyToMessageId: messageId }
          : undefined
      const telegramUserId = String(message?.from?.id ?? '').trim()
      const telegramUsername = String(message?.from?.username ?? '').trim() || null
      const telegramFirstName = String(message?.from?.first_name ?? '').trim() || null
      const textRaw = String(message?.text ?? message?.caption ?? '').trim()
      const textLower = textRaw.toLowerCase()
      const sanitizeGroupId = (value: string) =>
        String(value ?? '').replace(/[^\d-]/g, '').replace(/^-+/, '-').trim()
      const onlyDigits = (value: string) => String(value ?? '').replace(/\D/g, '').trim()
      const trimTelegram100Prefix = (value: string) => String(value ?? '').replace(/^-100/, '').trim()

      const configuredGroupIdSanitized = sanitizeGroupId(configuredGroupId)
      const chatIdSanitized = sanitizeGroupId(chatId)

      const configuredNo100 = trimTelegram100Prefix(configuredGroupIdSanitized)
      const chatNo100 = trimTelegram100Prefix(chatIdSanitized)

      const configuredDigits = onlyDigits(configuredGroupIdSanitized)
      const chatDigits = onlyDigits(chatIdSanitized)

      const configuredDigitsNo100 = configuredDigits.startsWith('100')
        ? configuredDigits.slice(3)
        : configuredDigits
      const chatDigitsNo100 = chatDigits.startsWith('100')
        ? chatDigits.slice(3)
        : chatDigits

      if (!chatIdSanitized || !telegramUserId) continue

      const isGroupMessage = chatType === 'group' || chatType === 'supergroup'
      const hasConfiguredGroup = Boolean(configuredGroupIdSanitized)

      const isConfiguredGroupMessage =
        isGroupMessage &&
        hasConfiguredGroup &&
        (
          chatIdSanitized === configuredGroupIdSanitized ||
          chatNo100 === configuredNo100 ||
          chatDigits === configuredDigits ||
          chatDigitsNo100 === configuredDigitsNo100
        )

      console.info('[telegram-group-match]', {
        chatId,
        chatIdSanitized,
        chatNo100,
        chatDigits,
        chatDigitsNo100,
        configuredGroupId,
        configuredGroupIdSanitized,
        configuredNo100,
        configuredDigits,
        configuredDigitsNo100,
        chatType,
        isGroupMessage,
        isConfiguredGroupMessage,
        textRaw,
      })

      if (messageId > 0) {
        const messageKey = `${chatId}:${messageId}`
        if (telegramProcessedMessageKeys.has(messageKey)) {
          continue
        }
        telegramProcessedMessageKeys.add(messageKey)
        if (telegramProcessedMessageKeys.size > 2000) {
          const firstKey = telegramProcessedMessageKeys.values().next().value as string | undefined
          if (firstKey) telegramProcessedMessageKeys.delete(firstKey)
        }
      }

      if (isConfiguredGroupMessage) {
        const normalizedCommandText = textLower.replace(/\s+/g, '')
        const isCheckinCommand =
          normalizedCommandText === '/checkin' ||
          normalizedCommandText.startsWith('/checkin@')

        const activationMatch = textRaw.match(/^Ative o saque para mim:\s*([a-z0-9]{16})$/i)
        if (activationMatch) {
          const tokenCandidate = String(activationMatch[1] ?? '').trim().toLowerCase()

          await ensureWithdrawActivationTokensTable()

          const [tokenRows] = await pool.query<RowDataPacket[]>(
            `
            SELECT
              id,
              user_id AS userId,
              status,
              expires_at AS expiresAt
            FROM withdraw_activation_tokens
            WHERE token = ?
            LIMIT 1
            FOR UPDATE
            `,
            [tokenCandidate]
          )

          if (tokenRows.length === 0) {
            await sendTelegramMessage(botToken, chatId, 'Token de ativação inválido.', telegramReplyOptions)
            continue
          }

          const tokenRow = tokenRows[0]
          const tokenId = Number(tokenRow.id ?? 0)
          const tokenUserId = Number(tokenRow.userId ?? 0)
          const tokenStatus = String(tokenRow.status ?? 'pending').toLowerCase()
          const expiresAt = tokenRow.expiresAt ? new Date(tokenRow.expiresAt) : null

          if (tokenStatus !== 'pending') {
            await sendTelegramMessage(botToken, chatId, 'Este token já foi utilizado ou expirou.', telegramReplyOptions)
            continue
          }

          if (!expiresAt || expiresAt.getTime() < Date.now()) {
            await pool.query(
              `
              UPDATE withdraw_activation_tokens
              SET status = 'expired', updated_at = NOW()
              WHERE id = ?
              `,
              [tokenId]
            )
            await sendTelegramMessage(botToken, chatId, 'Token expirado. Gere um novo token no app.', telegramReplyOptions)
            continue
          }

          const [connectionRows] = await pool.query<RowDataPacket[]>(
            `
            SELECT user_id AS userId
            FROM user_telegram_connections
            WHERE telegram_user_id = ?
              AND COALESCE(is_connected, 1) = 1
            ORDER BY id DESC
            LIMIT 1
            `,
            [telegramUserId]
          )

          if (connectionRows.length === 0) {
            await sendTelegramMessage(botToken, chatId, 'Você precisa vincular sua conta primeiro no privado do bot.', telegramReplyOptions)
            continue
          }

          const linkedUserId = Number(connectionRows[0].userId ?? 0)
          if (linkedUserId !== tokenUserId) {
            await sendTelegramMessage(botToken, chatId, 'Este token não pertence à sua conta.', telegramReplyOptions)
            continue
          }

          await pool.query(
            `
            UPDATE withdraw_activation_tokens
            SET
              status = 'activated',
              telegram_user_id = ?,
              activated_chat_id = ?,
              activated_at = NOW(),
              updated_at = NOW()
            WHERE id = ?
            `,
            [telegramUserId, chatId, tokenId]
          )

          await sendTelegramMessage(botToken, chatId, '✅ Saque ativado com sucesso para sua conta.', telegramReplyOptions)
          continue
        }

        if (!isCheckinCommand) {
          continue
        }

        console.info('[telegram-checkin-command]', {
          configuredGroupId,
          configuredGroupIdSanitized,
          chatId,
          chatIdSanitized,
          telegramUserId,
          isConfiguredGroupMessage,
        })

        const [connectionRows] = await pool.query<RowDataPacket[]>(
          `
          SELECT user_id AS userId
          FROM user_telegram_connections
          WHERE telegram_user_id = ?
            AND COALESCE(is_connected, 1) = 1
          ORDER BY id DESC
          LIMIT 1
          `,
          [telegramUserId]
        )

        if (connectionRows.length === 0) {
          const usernameValue = telegramUsername ? `@${telegramUsername}` : '@usuário'
          const meRes = await fetch(`https://api.telegram.org/bot${botToken}/getMe`)
          const meData = await meRes.json().catch(() => null) as any
          const botUsername = String(meData?.result?.username ?? '').trim()
          const botButtonLabel = botUsername ? `@${botUsername}` : 'Vincular conta'
          const botUrl = botUsername ? `https://t.me/${botUsername}` : undefined

          await sendTelegramMessage(
            botToken,
            chatId,
            `⚠️ Lembrete ${usernameValue} Você ainda não vinculou sua conta PGLM e não pode receber recompensas de check-in! Clique no botão abaixo para vincular`,
            {
              ...(botUrl
                ? {
                    replyMarkup: {
                      inline_keyboard: [[{ text: botButtonLabel, url: botUrl }]],
                    },
                  }
                : {}),
              ...(telegramReplyOptions ?? {}),
            }
          )
          continue
        }

        const linkedUserId = Number(connectionRows[0].userId ?? 0)
        const claimResult = await claimCheckinForUser(linkedUserId)

        const checkinDay = Number((claimResult as any)?.claim?.day ?? 0)
        const usernameValue = telegramUsername ? `@${telegramUsername}` : ''
        const displayNameValue =
          usernameValue ||
          String(telegramFirstName ?? '').trim() ||
          'usuário'

        const interpolateTelegramTemplate = (templateRaw: string) =>
          String(templateRaw ?? '')
            .replace(/\{day\}/g, String(checkinDay))
            .replace(/\{username\}/g, usernameValue)
            .replace(/\{displayName\}/g, displayNameValue)

        const successMessage = interpolateTelegramTemplate(configuredCheckinSuccessMessage)
        const alreadyClaimed =
          !claimResult.ok &&
          String((claimResult as any)?.error ?? '').trim().toLowerCase() === 'check-in de hoje já foi resgatado.'
        const errorMessage = alreadyClaimed
          ? interpolateTelegramTemplate(configuredCheckinAlreadyClaimedMessage)
          : String(claimResult.error ?? 'Não foi possível processar seu check-in.')

        await sendTelegramMessage(
          botToken,
          chatId,
          claimResult.ok ? successMessage : errorMessage,
          telegramReplyOptions
        )
        continue
      }

      if (chatType !== 'private') {
        continue
      }

      if (!textRaw) continue

      const isStartCommand =
        textLower === '/start' || textLower.startsWith('/start@')

      if (isStartCommand) {
        if (welcomeMessage) {
          await sendTelegramMessage(botToken, chatId, welcomeMessage)
        } else {
          await sendTelegramMessage(
            botToken,
            chatId,
            'Mensagem de boas-vindas não configurada. Peça ao administrador para configurar em /adf/telegram-config.',
            telegramReplyOptions
          )
        }
        continue
      }

      const normalizedIncomingPhone = normalizePhoneForCompare(textRaw)
      if (!normalizedIncomingPhone) {
        await sendTelegramMessage(
          botToken,
          chatId,
          'Para conectar sua conta, envie APENAS o telefone cadastrado na plataforma (somente no privado do bot). Exemplo: 11999998888',
          telegramReplyOptions
        )
        continue
      }

      const [userRows] = await pool.query<RowDataPacket[]>(
        `
        SELECT id, phone, telegram_conectado AS telegramConectado
        FROM users
        WHERE REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') = ?
        LIMIT 1
        `,
        [normalizedIncomingPhone]
      )

      if (userRows.length === 0) {
        await sendTelegramMessage(
          botToken,
          chatId,
          'Telefone não encontrado. Envie o telefone exatamente como cadastrado.',
          telegramReplyOptions
        )
        continue
      }

      const userId = Number(userRows[0].id)
      const phone = String(userRows[0].phone ?? '')
      const telegramConectado = Number(userRows[0].telegramConectado ?? 0)

      const [existingByChatOrTelegramUserRows] = await pool.query<RowDataPacket[]>(
        `
        SELECT id
        FROM user_telegram_connections
        WHERE (telegram_chat_id = ? OR telegram_user_id = ?)
          AND COALESCE(is_connected, 1) = 1
        LIMIT 1
        `,
        [chatId, telegramUserId]
      )

      if (existingByChatOrTelegramUserRows.length > 0) {
        await sendTelegramMessage(
          botToken,
          chatId,
          duplicateConnectionMessage,
          telegramReplyOptions
        )
        continue
      }

      const [existingByPhoneRows] = await pool.query<RowDataPacket[]>(
        `
        SELECT id
        FROM user_telegram_connections
        WHERE REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') = ?
          AND COALESCE(is_connected, 1) = 1
        LIMIT 1
        `,
        [normalizedIncomingPhone]
      )

      if (existingByPhoneRows.length > 0 || telegramConectado === 1) {
        await pool.query(
          `
          UPDATE users
          SET telegram_conectado = 1
          WHERE id = ?
             OR REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') = ?
          `,
          [userId, normalizedIncomingPhone]
        )

        await sendTelegramMessage(
          botToken,
          chatId,
          duplicateConnectionMessage,
          telegramReplyOptions
        )
        continue
      }

      const conn = await pool.getConnection()
      try {
        await conn.beginTransaction()

        const [existingByUserRowsTx] = await conn.query<RowDataPacket[]>(
          `
          SELECT id
          FROM user_telegram_connections
          WHERE user_id = ?
          LIMIT 1
          FOR UPDATE
          `,
          [userId]
        )

        if (existingByUserRowsTx.length > 0) {
          await conn.query(
            `
            UPDATE users
            SET telegram_conectado = 1
            WHERE id = ?
            `,
            [userId]
          )
          await conn.commit()
          await sendTelegramMessage(
            botToken,
            chatId,
            duplicateConnectionMessage,
            telegramReplyOptions
          )
          continue
        }

        await conn.query(
          `
          INSERT INTO user_telegram_connections
          (
            user_id,
            phone,
            telegram_chat_id,
            telegram_user_id,
            telegram_username,
            telegram_first_name,
            is_connected,
            connected_at
          )
          VALUES (?, ?, ?, ?, ?, ?, 1, NOW())
          ON DUPLICATE KEY UPDATE
            phone = VALUES(phone),
            telegram_chat_id = VALUES(telegram_chat_id),
            telegram_user_id = VALUES(telegram_user_id),
            telegram_username = VALUES(telegram_username),
            telegram_first_name = VALUES(telegram_first_name),
            is_connected = 1,
            updated_at = NOW()
          `,
          [userId, phone, chatId, telegramUserId, telegramUsername, telegramFirstName]
        )

        const [updateUserResult] = await conn.query(
          `
          UPDATE users
          SET telegram_conectado = 1
          WHERE id = ?
          `,
          [userId]
        ) as any

        await conn.query(
          `
          UPDATE users
          SET telegram_conectado = 1
          WHERE REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') = ?
          `,
          [normalizedIncomingPhone]
        )

        const affectedRows = Number(updateUserResult?.affectedRows ?? 0)
        if (affectedRows <= 0) {
          await conn.rollback()
          await sendTelegramMessage(
            botToken,
            chatId,
            'Não foi possível concluir o vínculo da conta. Tente novamente mais tarde.',
            telegramReplyOptions
          )
          continue
        }

        const [confirmTelegramFlagRows] = await conn.query<RowDataPacket[]>(
          `
          SELECT telegram_conectado AS telegramConectado
          FROM users
          WHERE id = ?
             OR REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') = ?
          LIMIT 1
          `,
          [userId, normalizedIncomingPhone]
        )

        const telegramFlagPersisted = confirmTelegramFlagRows.some(
          (row) => Number(row?.telegramConectado ?? 0) === 1
        )

        if (!telegramFlagPersisted) {
          await conn.query(
            `
            UPDATE users
            SET telegram_conectado = 1
            WHERE id = ?
               OR REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') = ?
            `,
            [userId, normalizedIncomingPhone]
          )
        }

        await conn.commit()
        await ensureTelegramConnectedSync()
      } catch (txErr) {
        await conn.rollback()
        console.error('[telegram-link-transaction]', txErr)
        await sendTelegramMessage(
          botToken,
          chatId,
          'Não foi possível concluir o vínculo da conta. Tente novamente mais tarde.',
          telegramReplyOptions
        )
        continue
      } finally {
        conn.release()
      }

      const [finalExistingRows] = await pool.query<RowDataPacket[]>(
        `
        SELECT id
        FROM user_telegram_connections
        WHERE
          (
            user_id = ?
            OR REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') = ?
          )
          AND
          (
            telegram_chat_id = ?
            OR telegram_user_id = ?
          )
          AND COALESCE(is_connected, 1) = 1
        LIMIT 1
        `,
        [userId, normalizedIncomingPhone, chatId, telegramUserId]
      )

      if (finalExistingRows.length <= 0) {
        console.warn('[telegram-link-final-guard] vínculo não confirmado após transação', {
          userId,
          normalizedIncomingPhone,
          chatId,
          telegramUserId,
        })
        await sendTelegramMessage(
          botToken,
          chatId,
          'Não foi possível concluir o vínculo da conta. Tente novamente mais tarde.',
          telegramReplyOptions
        )
        continue
      }

      // 🔧 CHECK FINAL: confirma que é conexão NOVA (não duplicada)
      const [finalUserConnectionCheck] = await pool.query<RowDataPacket[]>(`
        SELECT COUNT(*) as connectionCount
        FROM user_telegram_connections 
        WHERE user_id = ?
      `, [userId])

      const existingConnections = Number(finalUserConnectionCheck[0]?.connectionCount ?? 0)
      
      if (existingConnections > 1) {
        console.warn('[telegram-link-duplicate-detected] múltiplas conexões detectadas para mesmo user_id', {
          userId,
          normalizedIncomingPhone,
          chatId,
          telegramUserId,
          totalConnections: existingConnections
        })
        await sendTelegramMessage(
          botToken,
          chatId,
          '❌ Esta conta já possui conexão ativa com o Telegram.',
          telegramReplyOptions
        )
        continue
      }

      console.info('[telegram-link-success-confirmed]', {
        userId,
        normalizedIncomingPhone,
        chatId,
        telegramUserId,
      })

      io.to(`user:${userId}`).emit('telegram:connected', {
        ok: true,
        userId,
        phone,
        telegramChatId: chatId,
        telegramUserId,
        connectedAt: new Date().toISOString(),
      })

      await sendTelegramMessage(botToken, chatId, privateLinkSuccessMessage, telegramReplyOptions)
    }
  } catch (err) {
    console.error('[telegram-polling]', err)
  }
}

const startTelegramPolling = () => {
  if (telegramPollingStarted) return
  telegramPollingStarted = true

  processTelegramUpdates().catch(() => null)
  telegramPollingInterval = setInterval(() => {
    processTelegramUpdates().catch(() => null)
  }, 5000)
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
      SELECT id, expected_profit AS expectedProfit, amount_paid AS amountPaid
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

    const [userRows] = await conn.query<RowDataPacket[]>(
      'SELECT balance FROM users WHERE id = ? LIMIT 1 FOR UPDATE',
      [userId]
    )

    if (userRows.length === 0) {
      await conn.rollback()
      return
    }

    let totalProfit = 0
    let totalCapitalReturn = 0
    const purchaseIds: number[] = []

    for (const row of expiredRows) {
      const purchaseId = Number(row.id)
      const profit = Number(row.expectedProfit ?? 0)
      const capital = Number(row.amountPaid ?? 0)
      if (purchaseId > 0) purchaseIds.push(purchaseId)
      if (profit > 0) totalProfit += profit
      if (capital > 0) totalCapitalReturn += capital
    }

    // Total a creditar = lucro + devolução do capital investido
    const totalCredit = Number((totalProfit + totalCapitalReturn).toFixed(2))

    const oldBalance = Number(userRows[0].balance ?? 0)

    if (totalCredit > 0) {
      await conn.query(
        `
        UPDATE users
        SET balance = COALESCE(balance, 0) + ?
        WHERE id = ?
        `,
        [totalCredit, userId]
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

    const [updatedRows] = await conn.query<RowDataPacket[]>(
      'SELECT balance FROM users WHERE id = ? LIMIT 1',
      [userId]
    )

    const newBalance = Number(updatedRows[0]?.balance ?? oldBalance)

    if (purchaseIds.length > 0 && totalCredit > 0) {
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

      const lastPurchaseId = purchaseIds[purchaseIds.length - 1] ?? null

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
          'cycle',
          lastPurchaseId,
          'cycle_investment_completed_auto_credit',
          Number(oldBalance.toFixed(2)),
          Number(newBalance.toFixed(2)),
          totalCredit,
          JSON.stringify({
            purchaseIds,
            completedCount: purchaseIds.length,
            totalProfit: Number(totalProfit.toFixed(2)),
            totalCapitalReturn: Number(totalCapitalReturn.toFixed(2)),
            totalCredit,
            previousBalance: Number(oldBalance.toFixed(2)),
            currentBalance: Number(newBalance.toFixed(2)),
          }),
        ]
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

// ─── Log de todas as requisições HTTP ────────────────────────────────────────
app.use((req, res, next) => {
  const startedAt = Date.now()
  const requestId = Math.random().toString(36).slice(2, 10)
  console.log(`[http] -> ${requestId} ${req.method} ${req.originalUrl}`)
  res.on('finish', () => {
    const ms = Date.now() - startedAt
    const level = res.statusCode >= 500 ? 'ERROR' : res.statusCode >= 400 ? 'WARN' : 'INFO'
    console.log(`[http] [${level}] <- ${requestId} ${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`)
  })
  next()
})

// ─── Headers de segurança HTTP ───────────────────────────────────────────────
app.use((_req, res, next) => {
  // Impede carregamento em iframes (clickjacking)
  res.setHeader('X-Frame-Options', 'DENY')
  // Impede sniffing de content-type
  res.setHeader('X-Content-Type-Options', 'nosniff')
  // Força HTTPS em browsers modernos (1 ano)
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  // Bloqueia scripts/recursos não autorizados (XSS)
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none';"
  )
  // Esconde tecnologia do servidor
  res.removeHeader('X-Powered-By')
  next()
})

// ─── Rate Limiter em memória ──────────────────────────────────────────────────
interface RateLimitEntry {
  count: number
  resetAt: number
}
const rateLimitStore = new Map<string, RateLimitEntry>()

// Limpa entradas expiradas a cada 5 minutos para evitar vazamento de memória
setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of rateLimitStore.entries()) {
    if (now > entry.resetAt) rateLimitStore.delete(key)
  }
}, 5 * 60 * 1000)

const createRateLimiter = (maxRequests: number, windowMs: number, message?: string) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = String(req.ip ?? req.socket?.remoteAddress ?? 'unknown')
    const key = `${ip}:${req.path}`
    const now = Date.now()
    const entry = rateLimitStore.get(key)

    if (!entry || now > entry.resetAt) {
      rateLimitStore.set(key, { count: 1, resetAt: now + windowMs })
      next()
      return
    }

    entry.count += 1

    if (entry.count > maxRequests) {
      const retryAfterSec = Math.ceil((entry.resetAt - now) / 1000)
      res.setHeader('Retry-After', String(retryAfterSec))
      res.status(429).json({
        ok: false,
        error: message ?? 'Muitas requisições. Aguarde alguns segundos e tente novamente.',
      })
      return
    }

    next()
  }
}

// Limitadores específicos por rota
const redeemCodeLimiter = createRateLimiter(5, 60_000, 'Limite de resgates atingido. Aguarde 1 minuto.')
const spinLimiter = createRateLimiter(10, 60_000, 'Limite de giros atingido. Aguarde 1 minuto.')
const authLimiter = createRateLimiter(10, 60_000, 'Muitas tentativas de login. Aguarde 1 minuto.')
const generalApiLimiter = createRateLimiter(120, 60_000)

// ─── Presença online em tempo real (WebSocket + heartbeat HTTP) ──────────────
// Mapa: chave (userId ou sessionKey) → timestamp do último ping (ms)
const onlinePresence = new Map<string, number>()
const PRESENCE_TTL_MS = 65_000 // 65s — heartbeat a cada 30s, expiração com margem

// Helper: conta entradas ativas e emite via WebSocket para todos (count + lista de IDs)
const broadcastOnlineCount = () => {
  const cutoff = Date.now() - PRESENCE_TTL_MS
  let count = 0
  const onlineUserIds: number[] = []
  for (const [key, ts] of onlinePresence.entries()) {
    if (ts >= cutoff) {
      count++
      const num = Number(key)
      if (!isNaN(num) && num > 0) onlineUserIds.push(num)
    }
  }
  io.emit('online-count', { onlineCount: count, onlineUserIds })
  return count
}

// Limpa entradas expiradas a cada 30 segundos e broadcast o novo count
setInterval(() => {
  const cutoff = Date.now() - PRESENCE_TTL_MS
  let changed = false
  for (const [key, ts] of onlinePresence.entries()) {
    if (ts < cutoff) {
      onlinePresence.delete(key)
      changed = true
    }
  }
  if (changed) broadcastOnlineCount()
}, 30_000)

// POST /api/presence/heartbeat — chamado pelo frontend a cada 30s
app.post('/api/presence/heartbeat', (req, res) => {
  const userId = String(req.body?.userId ?? '').trim()
  // Só contabiliza usuários logados e cadastrados (com userId numérico válido)
  if (!userId || userId === '0' || isNaN(Number(userId))) {
    res.json({ ok: true }) // ignora silenciosamente sessões anônimas
    return
  }
  const isNew = !onlinePresence.has(userId)
  onlinePresence.set(userId, Date.now())
  // Só faz broadcast quando é um novo cliente (evita flood a cada heartbeat renovado)
  if (isNew) broadcastOnlineCount()
  res.json({ ok: true })
})

// GET /api/presence/online-count — fallback REST (para o primeiro load do admin)
app.get('/api/presence/online-count', (req, res) => {
  const cutoff = Date.now() - PRESENCE_TTL_MS
  let count = 0
  for (const ts of onlinePresence.values()) {
    if (ts >= cutoff) count++
  }
  res.json({ ok: true, onlineCount: count })
})

// GET /api/presence/online-users — retorna lista de userIds atualmente online
app.get('/api/presence/online-users', (req, res) => {
  const cutoff = Date.now() - PRESENCE_TTL_MS
  const onlineUserIds: number[] = []
  for (const [key, ts] of onlinePresence.entries()) {
    if (ts >= cutoff) {
      const num = Number(key)
      if (!isNaN(num) && num > 0) onlineUserIds.push(num)
    }
  }
  res.json({ ok: true, onlineUserIds })
})

// ─── Referral Commission Levels (priority static routes) ─────────────────────
app.get('/api/referral/commission-levels/debug', async (_req, res) => {
  try {
    await ensureCommissionLevelsTable()
    res.setHeader('x-commission-route', 'v4-top-static-debug')

    const [rows] = await pool.query<RowDataPacket[]>(
      `
      SELECT
        id,
        level,
        name,
        commission_percent AS commissionPercent,
        is_active AS isActive,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM commission_levels
      ORDER BY level ASC, id ASC
      `
    )

    res.json({
      ok: true,
      debug: true,
      database: { dbName: DB_NAME, dbHost: DB_HOST, dbPort: DB_PORT },
      totalLevels: rows.length,
      rawLevels: rows,
    })
  } catch (err) {
    console.error('[commission-levels-debug-v4]', err)
    res.status(500).json({ ok: false, error: 'Erro ao carregar debug dos níveis de comissão.' })
  }
})

app.get('/api/referral/commission-levels', async (_req, res) => {
  try {
    await ensureCommissionLevelsTable()
    res.setHeader('x-commission-route', 'v4-top-static')

    const [rows] = await pool.query<RowDataPacket[]>(
      `
      SELECT
        id,
        level,
        name,
        commission_percent AS commissionPercent,
        is_active AS isActive
      FROM commission_levels
      WHERE is_active = 1
      ORDER BY level ASC, id ASC
      `
    )

    const levels = rows.map((row) => ({
      id: Number(row.id),
      level: Number(row.level ?? 0),
      name: String(row.name ?? ''),
      commissionPercent: Number(row.commissionPercent ?? 0),
      isActive: Number(row.isActive ?? 1) === 1,
    }))

    res.json({ ok: true, levels, routeVersion: 'v4-top-static' })
  } catch (err) {
    console.error('[commission-levels-v4]', err)
    res.status(500).json({ ok: false, error: 'Erro ao carregar níveis de comissão.' })
  }
})

const bootstrapDatabase = async () => {
  await ensureDatabaseExists()
  await ensureTelegramConfigTable()
  await ensureUserTelegramConnectionsTable()
  await ensureTelegramConnectedColumn()
  await ensureTelegramConnectedSync()
  await ensureWithdrawActivationTokensTable()
  await ensureCommissionLevelsTable()
  await ensureVipAndMiningTables()

  // ── Saldo da loja (shop_balance) — separado do saldo da plataforma ─────────
  try {
    await pool.query(`ALTER TABLE users ADD COLUMN shop_balance DECIMAL(12,2) NOT NULL DEFAULT 0`)
    console.log('[bootstrap-database] shop_balance column added to users')
  } catch {
    // coluna já existe
  }

  // ── Tabela de transações do saldo da loja ─────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shop_balance_transactions (
      id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id       BIGINT UNSIGNED NOT NULL,
      type          ENUM('credit','debit') NOT NULL,
      amount        DECIMAL(12,2) NOT NULL,
      reason        VARCHAR(255) NOT NULL DEFAULT '',
      reference_id  VARCHAR(120) NULL,
      old_balance   DECIMAL(12,2) NULL,
      new_balance   DECIMAL(12,2) NULL,
      created_by    BIGINT UNSIGNED NULL COMMENT 'admin user_id que creditou, NULL se sistema',
      created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_sbt_user (user_id),
      KEY idx_sbt_created (created_at)
    )
  `)

  // ── Tabela de depósitos PIX da loja (shop_balance) ───────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shop_deposits (
      id                      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id                 BIGINT UNSIGNED NOT NULL,
      provider_transaction_id VARCHAR(200)    NULL,
      amount                  DECIMAL(12,2)   NOT NULL,
      status                  VARCHAR(50)     NOT NULL DEFAULT 'pending',
      pix_code                TEXT            NULL,
      qr_image                TEXT            NULL,
      provider_payload        LONGTEXT        NULL,
      paid_at                 DATETIME        NULL,
      created_at              DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at              DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_sd_user   (user_id),
      KEY idx_sd_tx     (provider_transaction_id),
      KEY idx_sd_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  console.log('[bootstrap-database] telegram config e conexões garantidas')
  console.log('[bootstrap-database] withdraw_activation_tokens table ensured')
  console.log('[bootstrap-database] commission_levels table ensured')
  console.log('[bootstrap-database] vip/mining tables ensured')
  console.log('[bootstrap-database] shop_balance e shop_balance_transactions garantidos')
  console.log('[bootstrap-database] shop_deposits garantida')
}

bootstrapDatabase().catch((err) => {
  console.error('[bootstrap-database]', err)
})

startTelegramPolling()

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
const ensureUserRouletteSpinsTable = async () => {
  await pool.query(
    `
    CREATE TABLE IF NOT EXISTS user_roulette_spins (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id BIGINT UNSIGNED NOT NULL,
      available_spins INT NOT NULL DEFAULT 0,
      total_earned INT NOT NULL DEFAULT 0,
      total_used INT NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_user_roulette_spins_user_id (user_id),
      KEY idx_user_roulette_spins_available (available_spins)
    )
    `
  )
}

const ensureRouletteCodesTable = async () => {
  await pool.query(
    `
    CREATE TABLE IF NOT EXISTS roulette_codes (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      code VARCHAR(120) NOT NULL,
      reward_label VARCHAR(255) NULL,
      description TEXT NULL,
      created_by_user_id BIGINT UNSIGNED NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      max_total_uses INT NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_roulette_codes_code (code),
      KEY idx_roulette_codes_active (is_active),
      KEY idx_roulette_codes_created_by (created_by_user_id)
    )
    `
  )
  // Garante coluna max_total_uses em tabelas já existentes
  try {
    await pool.query(`ALTER TABLE roulette_codes ADD COLUMN max_total_uses INT NOT NULL DEFAULT 0`)
  } catch { /* coluna já existe */ }
}

const DEFAULT_ROULETTE_PROBABILITIES: Array<{ label: string; percent: number; sortOrder: number }> = [
  { label: '1 BRL', percent: 40, sortOrder: 0 },
  { label: '16 BRL', percent: 20, sortOrder: 1 },
  { label: '35 BRL', percent: 14, sortOrder: 2 },
  { label: '50 BRL', percent: 10, sortOrder: 3 },
  { label: '73 BRL', percent: 8, sortOrder: 4 },
  { label: '90 BRL', percent: 5, sortOrder: 5 },
  { label: '183 BRL', percent: 2, sortOrder: 6 },
  { label: '16600 BRL', percent: 1, sortOrder: 7 },
]

const ensureRouletteProbabilitiesTable = async () => {
  // Cria a tabela se não existir
  await pool.query(
    `
    CREATE TABLE IF NOT EXISTS roulette_probabilities (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      label VARCHAR(120) NOT NULL,
      percent DECIMAL(8,4) NOT NULL DEFAULT 0.0000,
      sort_order INT NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_roulette_probabilities_label (label),
      KEY idx_roulette_probabilities_sort_order (sort_order)
    )
    `
  )

  // Só insere os defaults se a tabela estiver vazia (não sobrescreve configurações salvas)
  const [countRows] = await pool.query<RowDataPacket[]>(
    'SELECT COUNT(*) AS total FROM roulette_probabilities'
  )
  const total = Number((countRows as RowDataPacket[])[0]?.total ?? 0)
  if (total === 0) {
    for (const item of DEFAULT_ROULETTE_PROBABILITIES) {
      await pool.query(
        `
        INSERT IGNORE INTO roulette_probabilities (label, percent, sort_order)
        VALUES (?, ?, ?)
        `,
        [item.label, Number(item.percent.toFixed(4)), item.sortOrder]
      )
    }
  }
}

app.get('/api/admin/roulette-probabilities', requireMaxAdmin, async (_req: AuthenticatedRequest, res) => {
  try {
    await ensureRouletteProbabilitiesTable()

    const [rows] = await pool.query<RowDataPacket[]>(
      `
      SELECT
        label,
        percent,
        sort_order AS sortOrder
      FROM roulette_probabilities
      ORDER BY sort_order ASC, id ASC
      `
    )

    const probabilities = rows.map((row) => ({
      label: String(row.label ?? ''),
      percent: Number(row.percent ?? 0),
      sortOrder: Number(row.sortOrder ?? 0),
    }))

    res.json({ ok: true, probabilities })
  } catch (err) {
    console.error('[admin-roulette-probabilities-get] ERRO:', err)
    res.status(500).json({ ok: false, error: 'Erro ao carregar probabilidades da roleta.', detail: String(err) })
  }
})

app.put('/api/admin/roulette-probabilities', requireMaxAdmin, async (req: AuthenticatedRequest, res) => {
  const payload = req.body as {
    probabilities?: Array<{ label?: string; percent?: number | string }>
  }

  const list = Array.isArray(payload?.probabilities) ? payload.probabilities : []
  if (list.length === 0) {
    res.status(400).json({ ok: false, error: 'Informe a lista de probabilidades.' })
    return
  }

  const normalized = list.map((item, index) => ({
    label: String(item?.label ?? '').trim(),
    percent: Number(String(item?.percent ?? '').replace(',', '.')),
    sortOrder: index,
  }))

  if (normalized.some((item) => !item.label)) {
    res.status(400).json({ ok: false, error: 'Cada item deve possuir label.' })
    return
  }

  if (normalized.some((item) => !Number.isFinite(item.percent) || item.percent < 0)) {
    res.status(400).json({ ok: false, error: 'Todos os percentuais devem ser números válidos >= 0.' })
    return
  }

  const uniqueLabels = new Set(normalized.map((item) => item.label.toLowerCase()))
  if (uniqueLabels.size !== normalized.length) {
    res.status(400).json({ ok: false, error: 'Não é permitido repetir labels na configuração.' })
    return
  }

  // Garante tabela antes de abrir transação (evita conflito entre pool e conn)
  await ensureRouletteProbabilitiesTable()

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    // Apaga todos e reinsere com os novos valores
    await conn.query('DELETE FROM roulette_probabilities')

    for (const item of normalized) {
      await conn.query(
        `
        INSERT INTO roulette_probabilities (label, percent, sort_order)
        VALUES (?, ?, ?)
        `,
        [item.label, Number(item.percent.toFixed(4)), item.sortOrder]
      )
    }

    await conn.commit()

    res.json({
      ok: true,
      message: 'Probabilidades salvas com sucesso.',
      probabilities: normalized.map((item) => ({
        label: item.label,
        percent: Number(item.percent.toFixed(4)),
        sortOrder: item.sortOrder,
      })),
    })
  } catch (err) {
    await conn.rollback()
    console.error('[admin-roulette-probabilities-put] ERRO:', err)
    res.status(500).json({ ok: false, error: 'Erro ao salvar probabilidades da roleta.', detail: String(err) })
  } finally {
    conn.release()
  }
})

app.get('/api/admin/roulette-codes', requireMaxAdmin, async (_req: AuthenticatedRequest, res) => {
  try {
    await ensureRouletteCodesTable()

    const [rows] = await pool.query<RowDataPacket[]>(
      `
      SELECT
        rc.id,
        rc.code,
        rc.reward_label AS reward,
        rc.description,
        rc.is_active AS isActive,
        rc.max_total_uses AS maxTotalUses,
        rc.created_by_user_id AS createdByUserId,
        rc.created_at AS createdAt,
        COUNT(rcr.id) AS redeemedCount
      FROM roulette_codes rc
      LEFT JOIN roulette_code_redemptions rcr ON rcr.roulette_code_id = rc.id
      GROUP BY rc.id
      ORDER BY rc.id DESC
      `
    )

    const rouletteCodes = rows.map((row) => ({
      id: Number(row.id ?? 0),
      code: String(row.code ?? ''),
      reward: String(row.reward ?? ''),
      description: String(row.description ?? ''),
      isActive: Number(row.isActive ?? 1) === 1,
      maxTotalUses: Number(row.maxTotalUses ?? 0),
      redeemedCount: Number(row.redeemedCount ?? 0),
      isRedeemed: Number(row.redeemedCount ?? 0) > 0,
      createdByUserId: row.createdByUserId == null ? null : Number(row.createdByUserId),
      createdAt: row.createdAt ?? null,
    }))

    res.json({ ok: true, rouletteCodes })
  } catch (err) {
    console.error('[admin-roulette-codes-list]', err)
    res.status(500).json({ ok: false, error: 'Erro ao listar códigos da roleta.' })
  }
})

app.post('/api/admin/roulette-codes', requireMaxAdmin, async (req: AuthenticatedRequest, res) => {
  const { code, reward, description, maxTotalUses } = req.body as {
    code?: string
    reward?: string
    description?: string
    maxTotalUses?: number | string
  }

  const normalizedCode = String(code ?? '').trim().toUpperCase()
  const normalizedReward = String(reward ?? '').trim()
  const normalizedDescription = String(description ?? '').trim()
  const parsedMaxTotalUses = Math.max(0, Math.floor(Number(String(maxTotalUses ?? '0').replace(',', '.')) || 0))

  if (!normalizedCode) {
    res.status(400).json({ ok: false, error: 'Informe um código para a roleta.' })
    return
  }

  try {
    await ensureRouletteCodesTable()

    const [result] = await pool.query(
      `
      INSERT INTO roulette_codes
      (code, reward_label, description, created_by_user_id, is_active, max_total_uses)
      VALUES (?, ?, ?, ?, 1, ?)
      `,
      [
        normalizedCode,
        normalizedReward || null,
        normalizedDescription || null,
        Number(req.authUser?.id ?? 0) || null,
        parsedMaxTotalUses,
      ]
    ) as any

    res.status(201).json({
      ok: true,
      message: `Código "${normalizedCode}" criado com sucesso.`,
      rouletteCode: {
        id: Number(result?.insertId ?? 0),
        code: normalizedCode,
        reward: normalizedReward,
        description: normalizedDescription,
        maxTotalUses: parsedMaxTotalUses,
      },
    })
  } catch (err: any) {
    if (String(err?.code ?? '') === 'ER_DUP_ENTRY') {
      res.status(409).json({ ok: false, error: 'Este código da roleta já existe.' })
      return
    }

    console.error('[admin-roulette-codes-create]', err)
    res.status(500).json({ ok: false, error: 'Erro ao criar código da roleta.' })
  }
})

app.delete('/api/admin/roulette-codes/:id', requireMaxAdmin, async (req: AuthenticatedRequest, res) => {
  const codeId = Number(req.params.id)
  if (!codeId || Number.isNaN(codeId)) {
    res.status(400).json({ ok: false, error: 'ID inválido.' })
    return
  }
  try {
    await ensureRouletteCodesTable()
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT id, code FROM roulette_codes WHERE id = ? LIMIT 1',
      [codeId]
    )
    if (rows.length === 0) {
      res.status(404).json({ ok: false, error: 'Código não encontrado.' })
      return
    }
    await pool.query('DELETE FROM roulette_codes WHERE id = ?', [codeId])
    res.json({ ok: true, message: `Código "${String(rows[0].code)}" excluído com sucesso.` })
  } catch (err) {
    console.error('[admin-roulette-codes-delete]', err)
    res.status(500).json({ ok: false, error: 'Erro ao excluir código da roleta.' })
  }
})

// ─── Resgatar código de roleta (usuário) ─────────────────────────────────────
app.post('/api/roleta/redeem-code', redeemCodeLimiter, async (req, res) => {
  const { userId, code } = req.body as { userId?: number; code?: string }
  const parsedUserId = Number(userId)
  const normalizedCode = String(code ?? '').trim().toUpperCase()

  if (!parsedUserId || Number.isNaN(parsedUserId)) {
    res.status(400).json({ ok: false, error: 'ID de usuário inválido.' })
    return
  }
  if (!normalizedCode) {
    res.status(400).json({ ok: false, error: 'Código inválido.' })
    return
  }

  try {
    await ensureRouletteCodesTable()

    // Garante tabela de resgates
    await pool.query(`
      CREATE TABLE IF NOT EXISTS roulette_code_redemptions (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        roulette_code_id BIGINT UNSIGNED NOT NULL,
        user_id BIGINT UNSIGNED NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_rcr_code_user (roulette_code_id, user_id),
        KEY idx_rcr_user_id (user_id),
        KEY idx_rcr_code_id (roulette_code_id)
      )
    `)

    // Busca o código
    const [codeRows] = await pool.query<RowDataPacket[]>(
      `SELECT id, code, reward_label, is_active, max_total_uses FROM roulette_codes WHERE code = ? LIMIT 1`,
      [normalizedCode]
    )

    if (codeRows.length === 0) {
      res.status(404).json({ ok: false, error: 'Código não encontrado ou inválido.' })
      sendTelegramLog(
        `❌ <b>Falha no Resgate</b>\n` +
        `👤 Usuário ID: <code>${parsedUserId}</code>\n` +
        `🎟️ Código: <code>${normalizedCode}</code>\n` +
        `⚠️ Motivo: Código não encontrado\n` +
        `📅 ${new Date().toLocaleString('pt-BR')}`
      ).catch(() => {})
      return
    }

    const codeData = codeRows[0]

    if (!Number(codeData.is_active ?? 1)) {
      res.status(400).json({ ok: false, error: 'Este código está inativo.' })
      sendTelegramLog(
        `❌ <b>Falha no Resgate</b>\n` +
        `👤 Usuário ID: <code>${parsedUserId}</code>\n` +
        `🎟️ Código: <code>${normalizedCode}</code>\n` +
        `⚠️ Motivo: Código inativo\n` +
        `📅 ${new Date().toLocaleString('pt-BR')}`
      ).catch(() => {})
      return
    }

    // Verifica se o usuário já resgatou este código
    const [alreadyRows] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM roulette_code_redemptions WHERE roulette_code_id = ? AND user_id = ? LIMIT 1',
      [Number(codeData.id), parsedUserId]
    )
    if (alreadyRows.length > 0) {
      res.status(409).json({ ok: false, error: 'Você já resgatou este código.' })
      sendTelegramLog(
        `❌ <b>Falha no Resgate</b>\n` +
        `👤 Usuário ID: <code>${parsedUserId}</code>\n` +
        `🎟️ Código: <code>${normalizedCode}</code>\n` +
        `⚠️ Motivo: Usuário já resgatou este código\n` +
        `📅 ${new Date().toLocaleString('pt-BR')}`
      ).catch(() => {})
      return
    }

    // Verifica limite total de usos (0 = ilimitado)
    const maxTotalUses = Number(codeData.max_total_uses ?? 0)
    if (maxTotalUses > 0) {
      const [countRows] = await pool.query<RowDataPacket[]>(
        'SELECT COUNT(*) AS total FROM roulette_code_redemptions WHERE roulette_code_id = ?',
        [Number(codeData.id)]
      )
      const usedCount = Number((countRows as RowDataPacket[])[0]?.total ?? 0)
      if (usedCount >= maxTotalUses) {
        res.status(400).json({ ok: false, error: 'Este código já atingiu o limite máximo de usos.' })
        sendTelegramLog(
          `❌ <b>Falha no Resgate</b>\n` +
          `👤 Usuário ID: <code>${parsedUserId}</code>\n` +
          `🎟️ Código: <code>${normalizedCode}</code>\n` +
          `⚠️ Motivo: Limite máximo de usos atingido (${usedCount}/${maxTotalUses})\n` +
          `📅 ${new Date().toLocaleString('pt-BR')}`
        ).catch(() => {})
        return
      }
    }

    // Define quantos giros conceder: reward_label numérico = quantidade de giros (padrão: 1)
    const rewardLabel = String(codeData.reward_label ?? '').trim()
    const spinsToAdd = Math.max(1, Number(rewardLabel) || 1)

    // Registra o resgate
    await pool.query(
      'INSERT INTO roulette_code_redemptions (roulette_code_id, user_id) VALUES (?, ?)',
      [Number(codeData.id), parsedUserId]
    )

    // Concede os giros ao usuário
    await ensureUserRouletteSpinsTable()
    await pool.query(
      `
      INSERT INTO user_roulette_spins (user_id, available_spins, total_earned, total_used)
      VALUES (?, ?, ?, 0)
      ON DUPLICATE KEY UPDATE
        available_spins = COALESCE(available_spins, 0) + ?,
        total_earned = COALESCE(total_earned, 0) + ?,
        updated_at = NOW()
      `,
      [parsedUserId, spinsToAdd, spinsToAdd, spinsToAdd, spinsToAdd]
    )

    // Busca giros disponíveis atualizados
    const [spinsRows] = await pool.query<RowDataPacket[]>(
      'SELECT available_spins AS availableSpins FROM user_roulette_spins WHERE user_id = ? LIMIT 1',
      [parsedUserId]
    )
    const availableSpins = Number(spinsRows[0]?.availableSpins ?? spinsToAdd)

    res.json({
      ok: true,
      message: `Código resgatado com sucesso! Você recebeu ${spinsToAdd} giro${spinsToAdd > 1 ? 's' : ''} na roleta.`,
      spinsAdded: spinsToAdd,
      availableSpins,
    })

    // Log de resgate bem-sucedido (fire-and-forget)
    sendTelegramLog(
      `✅ <b>Código Resgatado</b>\n` +
      `👤 Usuário ID: <code>${parsedUserId}</code>\n` +
      `🎟️ Código: <code>${normalizedCode}</code>\n` +
      `🎰 Giros concedidos: <b>${spinsToAdd}</b>\n` +
      `📅 ${new Date().toLocaleString('pt-BR')}`
    ).catch(() => {})

  } catch (err: any) {
    if (String(err?.code ?? '') === 'ER_DUP_ENTRY') {
      res.status(409).json({ ok: false, error: 'Você já resgatou este código.' })
      sendTelegramLog(
        `❌ <b>Falha no Resgate (código duplicado)</b>\n` +
        `👤 Usuário ID: <code>${parsedUserId}</code>\n` +
        `🎟️ Código: <code>${normalizedCode}</code>\n` +
        `⚠️ Motivo: Usuário já resgatou este código\n` +
        `📅 ${new Date().toLocaleString('pt-BR')}`
      ).catch(() => {})
      return
    }
    console.error('[roleta-redeem-code]', err)
    res.status(500).json({ ok: false, error: 'Erro ao resgatar código da roleta.' })
  }
})

app.post('/api/auth/register', authLimiter, async (req, res) => {
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

    // Giro da roleta NÃO é concedido no cadastro.
    // O giro só é concedido quando o indicado (nível 1) fizer o primeiro depósito.

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
    try {
      await pool.query(
        `
        ALTER TABLE users
        ADD COLUMN monthly_salary_contract VARCHAR(255) NULL
        `
      )
    } catch {
      // coluna já existe
    }

    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT balance, shop_balance, total_deposits, monthly_salary_contract AS monthlySalaryContract FROM users WHERE id = ?',
      [userId]
    )

    if (rows.length === 0) {
      res.status(404).json({ error: 'Usuário não encontrado.' })
      return
    }

    const row = rows[0] as {
      balance: number | string
      shop_balance: number | string
      total_deposits: number | string
      monthlySalaryContract?: string | null
    }

    res.json({
      balance: Number(row.balance ?? 0),
      shopBalance: Number(row.shop_balance ?? 0),
      totalDeposits: Number(row.total_deposits ?? 0),
      monthlySalaryContract: row.monthlySalaryContract == null ? null : String(row.monthlySalaryContract),
    })
  } catch (err) {
    console.error('[user-summary]', err)
    res.status(500).json({ error: 'Erro interno no servidor.' })
  }
})

// ─── Login ───────────────────────────────────────────────────────────────────
app.post('/api/auth/login', authLimiter, async (req, res) => {
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
      callbackUrl: 'https://api.pgl-m.com/api/CASHIN/webhook',
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

    /*
     * Estrutura da Lumopay:
     * { "event": "payment.paid", "data": { "transaction_id": "...", "amount": 3, "status": "paid", ... } }
     * amount é em REAIS (não centavos).
     */
    const inner = data?.data ?? data

    const status = String(inner?.status ?? data?.event ?? data?.status ?? '')
    const amountBRL = Number(inner?.amount ?? data?.amount ?? 0)   // já em reais
    const userId = Number(inner?.metadata?.userId ?? data?.metadata?.userId ?? data?.userId ?? 0)
    const providerTransactionId =
      inner?.transaction_id ??
      inner?.id ??
      data?.transaction_id ??
      data?.id ??
      null

    const normalizedStatus = (status || 'pending').toLowerCase()
    const isPaid = normalizedStatus === 'paid' || normalizedStatus === 'payment.paid'

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

          const [depositorRows] = await pool.query<RowDataPacket[]>(
            `
            SELECT referred_by_user_id AS referredByUserId
            FROM users
            WHERE id = ?
            LIMIT 1
            `,
            [Number(existing.user_id)]
          )

          const referredByUserId = Number(depositorRows[0]?.referredByUserId ?? 0)
          if (referredByUserId > 0) {
            // Giro na roleta só é concedido no PRIMEIRO depósito do indicado (nível 1)
            const [prevDepositsRows] = await pool.query<RowDataPacket[]>(
              `
              SELECT COUNT(*) AS total
              FROM cashin_payments
              WHERE user_id = ?
                AND status IN ('paid', 'payment.paid')
                AND id != ?
              `,
              [Number(existing.user_id), Number(existing.id)]
            )
            const prevDeposits = Number((prevDepositsRows as RowDataPacket[])[0]?.total ?? 0)
            if (prevDeposits === 0) {
              await ensureUserRouletteSpinsTable()
              await pool.query(
                `
                INSERT INTO user_roulette_spins (user_id, available_spins, total_earned, total_used)
                VALUES (?, 1, 1, 0)
                ON DUPLICATE KEY UPDATE
                  available_spins = COALESCE(available_spins, 0) + 1,
                  total_earned = COALESCE(total_earned, 0) + 1,
                  updated_at = NOW()
                `,
                [referredByUserId]
              )
            }
          }

          // Concede 1 giro na Caixa Box ao próprio depositante se depositar R$50 ou mais
          const depositAmount = Number(existing.amount ?? amountBRL)
          if (depositAmount >= 50) {
            await ensureCaixasBoxTables()
            await pool.query(
              `
              INSERT INTO user_caixas_box_spins (user_id, available_spins, total_earned, total_used)
              VALUES (?, 1, 1, 0)
              ON DUPLICATE KEY UPDATE
                available_spins = COALESCE(available_spins, 0) + 1,
                total_earned = COALESCE(total_earned, 0) + 1,
                updated_at = NOW()
              `,
              [Number(existing.user_id)]
            )
          }

          await applyReferralCommissionsForDeposit(
            Number(existing.id),
            Number(existing.user_id),
            Number(existing.amount ?? amountBRL)
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
          String(inner?.metadata?.method ?? data?.metadata?.method ?? 'pix'),
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

        const [depositorRows] = await pool.query<RowDataPacket[]>(
          `
          SELECT referred_by_user_id AS referredByUserId
          FROM users
          WHERE id = ?
          LIMIT 1
          `,
          [userId]
        )

        const referredByUserId = Number(depositorRows[0]?.referredByUserId ?? 0)
        if (referredByUserId > 0) {
          // Giro na roleta só é concedido no PRIMEIRO depósito do indicado (nível 1)
          const [prevDepositsRows2] = await pool.query<RowDataPacket[]>(
            `
            SELECT COUNT(*) AS total
            FROM cashin_payments
            WHERE user_id = ?
              AND status IN ('paid', 'payment.paid')
            `,
            [userId]
          )
          const prevDeposits2 = Number((prevDepositsRows2 as RowDataPacket[])[0]?.total ?? 0)
          // prevDeposits2 === 1 porque o INSERT acima já inseriu este depósito como paid
          if (prevDeposits2 <= 1) {
            await ensureUserRouletteSpinsTable()
            await pool.query(
              `
              INSERT INTO user_roulette_spins (user_id, available_spins, total_earned, total_used)
              VALUES (?, 1, 1, 0)
              ON DUPLICATE KEY UPDATE
                available_spins = COALESCE(available_spins, 0) + 1,
                total_earned = COALESCE(total_earned, 0) + 1,
                updated_at = NOW()
              `,
              [referredByUserId]
            )
          }
        }

        // Concede 1 giro na Caixa Box ao próprio depositante se depositar R$50 ou mais
        if (amountBRL >= 50) {
          await ensureCaixasBoxTables()
          await pool.query(
            `
            INSERT INTO user_caixas_box_spins (user_id, available_spins, total_earned, total_used)
            VALUES (?, 1, 1, 0)
            ON DUPLICATE KEY UPDATE
              available_spins = COALESCE(available_spins, 0) + 1,
              total_earned = COALESCE(total_earned, 0) + 1,
              updated_at = NOW()
            `,
            [userId]
          )
        }

        const [createdRows] = await pool.query<RowDataPacket[]>(
          `
          SELECT id
          FROM cashin_payments
          WHERE provider_transaction_id = ?
          ORDER BY id DESC
          LIMIT 1
          `,
          [providerTransactionId ? String(providerTransactionId) : '']
        )

        if (createdRows.length > 0) {
          await applyReferralCommissionsForDeposit(
            Number(createdRows[0].id),
            userId,
            amountBRL
          )
        }
      }
    }

    res.status(200).send('OK')
  } catch (err) {
    console.error('[cashin-webhook]', err)
    res.status(500).send('Erro')
  }
})

/* GET /api/cashin/status/:transactionId — polling de status do pagamento */
app.get('/api/cashin/status/:transactionId', async (req: Request, res: Response): Promise<void> => {
  const { transactionId } = req.params
  if (!transactionId) {
    res.status(400).json({ error: 'transactionId obrigatório.' })
    return
  }
  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT id, status, amount, user_id, paid_at AS paidAt
       FROM cashin_payments
       WHERE provider_transaction_id = ?
       LIMIT 1`,
      [String(transactionId)]
    )
    if (!rows.length) {
      res.status(404).json({ error: 'Pagamento não encontrado.' })
      return
    }
    const row = rows[0] as { id: number; status: string; amount: number | string; user_id: number; paidAt: string | null }
    const status = String(row.status ?? 'pending').toLowerCase()
    const isPaid = status === 'paid' || status === 'payment.paid'

    /* se pago, busca saldo atualizado do usuário */
    let balance: number | null = null
    if (isPaid && row.user_id) {
      const [userRows] = await pool.query<RowDataPacket[]>(
        'SELECT balance FROM users WHERE id = ? LIMIT 1',
        [row.user_id]
      )
      if (userRows.length) balance = Number(userRows[0].balance ?? 0)
    }

    res.json({
      ok:     true,
      status,
      isPaid,
      amount: Number(row.amount ?? 0),
      paidAt: row.paidAt ? String(row.paidAt) : null,
      balance,
    })
  } catch (err) {
    console.error('[cashin-status]', err)
    res.status(500).json({ error: 'Erro ao consultar status.' })
  }
})

// ════════════════════════════════════════════════════════════════════════════
// DEPÓSITO PIX — LOJA (credita shop_balance, não balance)
// ════════════════════════════════════════════════════════════════════════════

/* POST /api/shop/deposit
   Autenticado via Bearer JWT.
   Body: { amount: number }
   Cria cobrança PIX na Lumopay e salva em shop_deposits.
   O webhook /api/shop/deposit/webhook credita shop_balance quando pago.
*/
app.post('/api/shop/deposit', requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const userId = req.authUser!.id
  const { amount } = req.body as { amount?: number }

  const parsedAmount = Number(amount)
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    res.status(400).json({ error: 'Valor de depósito inválido.' })
    return
  }
  if (parsedAmount > 5000) {
    res.status(400).json({ error: 'Valor máximo para depósito na loja: R$ 5.000,00' })
    return
  }

  try {
    const [users] = await pool.query<RowDataPacket[]>(
      'SELECT id, name, phone FROM users WHERE id = ? LIMIT 1',
      [userId]
    )
    if (!users.length) {
      res.status(404).json({ error: 'Usuário não encontrado.' })
      return
    }
    const user = users[0] as { id: number; name: string; phone: string }

    const payload = {
      amount:               Math.round(parsedAmount),
      customerEmail:        `user${user.id}@pglm-loja.local`,
      customerName:         user.name,
      customerDocument:     '11615845445',
      customerDocumentType: 'cpf',
      customerPhone:        (user.phone || '').replace(/\D/g, '') || '11999998888',
      description:          `Depósito loja PGLM - usuário #${user.id}`,
      callbackUrl:          `https://api.pgl-m.com/api/shop/deposit/webhook`,
      metadata: { userId: user.id, source: 'loja' },
    }

    const lumoResponse = await fetch('https://api.lumopayment.com/api/payments/transactions', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': LUMO_API_KEY },
      body:    JSON.stringify(payload),
    })
    const lumoData = await lumoResponse.json() as any

    if (!lumoResponse.ok || !lumoData?.success) {
      res.status(502).json({ error: 'Falha ao criar cobrança PIX.', provider: lumoData })
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

    const providerStatus = String(lumoData?.data?.status ?? lumoData?.status ?? 'pending')

    const [insertResult] = await pool.query(
      `INSERT INTO shop_deposits
       (user_id, provider_transaction_id, amount, status, pix_code, qr_image, provider_payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        transactionId ? String(transactionId) : null,
        parsedAmount,
        providerStatus,
        qrCode  || null,
        qrImage || null,
        JSON.stringify(lumoData),
      ]
    ) as any

    res.json({
      ok:            true,
      depositId:     insertResult?.insertId ?? null,
      transactionId,
      amount:        parsedAmount,
      qrCode,
      provider:      lumoData,
    })
  } catch (err) {
    console.error('[shop-deposit-create]', err)
    res.status(500).json({ error: 'Erro interno ao criar cobrança.' })
  }
})

/* POST /api/shop/deposit/webhook
   Chamado pela Lumopay quando o pagamento é confirmado.
   Valida assinatura HMAC-SHA256, credita shop_balance e registra em shop_balance_transactions.
*/
app.post('/api/shop/deposit/webhook', express.raw({ type: '*/*' }), async (req: Request, res: Response): Promise<void> => {
  try {
    const signatureHeader = req.headers['x-signature']
    const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader ?? ''

    const rawBody: Buffer = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body))

    const calculated = crypto
      .createHmac('sha256', LUMO_WEBHOOK_SECRET)
      .update(rawBody)
      .digest('hex')

    if (!signature || !crypto.timingSafeEqual(Buffer.from(calculated), Buffer.from(String(signature)))) {
      res.status(401).send('Assinatura inválida')
      return
    }

    const payload = JSON.parse(rawBody.toString('utf8')) as any

    /*
     * Estrutura da Lumopay:
     * { "event": "payment.paid", "data": { "transaction_id": "...", "amount": 3, "status": "paid", ... } }
     *
     * "amount" é em REAIS (não centavos).
     * O status pode vir em payload.event ("payment.paid") ou payload.data.status ("paid").
     */
    const inner = payload?.data ?? payload

    const rawStatus = String(inner?.status ?? payload?.event ?? payload?.status ?? '')
    const normalizedStatus = rawStatus.toLowerCase()
    const isPaid = normalizedStatus === 'paid' || normalizedStatus === 'payment.paid'

    /* amount em reais — a Lumopay envia sem multiplicar por 100 */
    const amountFromPayload = Number(inner?.amount ?? payload?.amount ?? 0)

    const providerTransactionId: string | null =
      inner?.transaction_id ??
      inner?.id ??
      payload?.transaction_id ??
      payload?.id ??
      null

    console.log(`[shop-deposit-webhook] event=${payload?.event} tx=${providerTransactionId} status=${normalizedStatus} amount=${amountFromPayload}`)

    if (!providerTransactionId) {
      console.warn('[shop-deposit-webhook] sem transaction_id, ignorando')
      res.status(200).send('OK')
      return
    }

    const [depositRows] = await pool.query<RowDataPacket[]>(
      'SELECT id, status, user_id, amount FROM shop_deposits WHERE provider_transaction_id = ? LIMIT 1',
      [String(providerTransactionId)]
    )

    if (!depositRows.length) {
      console.warn(`[shop-deposit-webhook] depósito não encontrado para tx=${providerTransactionId}`)
      res.status(200).send('OK')
      return
    }

    const deposit = depositRows[0] as { id: number; status: string; user_id: number; amount: number | string }
    const wasAlreadyPaid = ['paid', 'payment.paid'].includes(String(deposit.status).toLowerCase())

    /* atualiza status e paid_at na tabela */
    await pool.query(
      `UPDATE shop_deposits
       SET status = ?, provider_payload = ?,
           paid_at    = CASE WHEN ? = 1 AND paid_at IS NULL THEN NOW() ELSE paid_at END,
           updated_at = NOW()
       WHERE id = ?`,
      [normalizedStatus, JSON.stringify(payload), isPaid ? 1 : 0, deposit.id]
    )

    if (isPaid && !wasAlreadyPaid) {
      /* usa o amount salvo no depósito (o que o usuário solicitou) */
      const creditAmount = Number(deposit.amount ?? amountFromPayload)
      const conn = await pool.getConnection()
      try {
        await conn.beginTransaction()

        const [lockRows] = await conn.query<RowDataPacket[]>(
          'SELECT shop_balance FROM users WHERE id = ? LIMIT 1 FOR UPDATE',
          [deposit.user_id]
        )
        const oldBalance = Number(lockRows[0]?.shop_balance ?? 0)
        const newBalance = oldBalance + creditAmount

        await conn.query(
          'UPDATE users SET shop_balance = ? WHERE id = ?',
          [newBalance, deposit.user_id]
        )
        await conn.query(
          `INSERT INTO shop_balance_transactions
           (user_id, type, amount, reason, reference_id, old_balance, new_balance, created_by)
           VALUES (?, 'credit', ?, 'Depósito PIX loja', ?, ?, ?, NULL)`,
          [deposit.user_id, creditAmount, String(deposit.id), oldBalance, newBalance]
        )

        await conn.commit()
        console.log(`[shop-deposit-webhook] ✅ user ${deposit.user_id} +R$${creditAmount} → shop_balance=${newBalance}`)
      } catch (txErr) {
        await conn.rollback()
        throw txErr
      } finally {
        conn.release()
      }
    } else if (wasAlreadyPaid) {
      console.log(`[shop-deposit-webhook] depósito ${deposit.id} já estava pago, ignorando crédito`)
    }

    res.status(200).send('OK')
  } catch (err) {
    console.error('[shop-deposit-webhook]', err)
    res.status(500).send('Erro')
  }
})

/* GET /api/shop/deposit/history — histórico de depósitos da loja do usuário autenticado */
app.get('/api/shop/deposit/history', requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const userId = req.authUser!.id
  const limit  = Math.min(Number(req.query.limit ?? 30), 100)
  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT id, amount, status, provider_transaction_id AS externalId,
              pix_code AS pixCode, paid_at AS paidAt, created_at AS createdAt
       FROM shop_deposits
       WHERE user_id = ?
       ORDER BY id DESC
       LIMIT ?`,
      [userId, limit]
    )
    res.json({
      ok: true,
      deposits: (rows as RowDataPacket[]).map(r => ({
        id:         Number(r.id),
        amount:     Number(r.amount ?? 0),
        status:     String(r.status ?? 'pending'),
        externalId: r.externalId ? String(r.externalId) : null,
        pixCode:    r.pixCode    ? String(r.pixCode)    : null,
        paidAt:     r.paidAt     ? String(r.paidAt)     : null,
        createdAt:  r.createdAt  ? String(r.createdAt)  : null,
      })),
    })
  } catch (err) {
    console.error('[shop-deposit-history]', err)
    res.status(500).json({ error: 'Erro ao buscar histórico.' })
  }
})

/* POST /api/shop/deposit/reprocess — admin: reprocessa depósito pago que não foi creditado */
app.post('/api/shop/deposit/reprocess', requireAuth, async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  if (!req.authUser?.isAdmin) {
    res.status(403).json({ error: 'Acesso restrito.' })
    return
  }
  const { depositId } = req.body as { depositId?: number }
  if (!depositId) {
    res.status(400).json({ error: 'depositId obrigatório.' })
    return
  }
  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT id, status, user_id, amount FROM shop_deposits WHERE id = ? LIMIT 1',
      [depositId]
    )
    if (!rows.length) {
      res.status(404).json({ error: 'Depósito não encontrado.' })
      return
    }
    const deposit = rows[0] as { id: number; status: string; user_id: number; amount: number | string }
    const wasAlreadyPaid = ['paid', 'payment.paid'].includes(String(deposit.status).toLowerCase())
    if (wasAlreadyPaid) {
      res.json({ ok: false, message: 'Depósito já estava marcado como pago.' })
      return
    }
    const creditAmount = Number(deposit.amount)
    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()
      const [lockRows] = await conn.query<RowDataPacket[]>(
        'SELECT shop_balance FROM users WHERE id = ? LIMIT 1 FOR UPDATE',
        [deposit.user_id]
      )
      const oldBalance = Number(lockRows[0]?.shop_balance ?? 0)
      const newBalance = oldBalance + creditAmount
      await conn.query('UPDATE users SET shop_balance = ? WHERE id = ?', [newBalance, deposit.user_id])
      await conn.query(
        `INSERT INTO shop_balance_transactions
         (user_id, type, amount, reason, reference_id, old_balance, new_balance, created_by)
         VALUES (?, 'credit', ?, 'Depósito PIX loja (reprocessado)', ?, ?, ?, ?)`,
        [deposit.user_id, creditAmount, String(deposit.id), oldBalance, newBalance, req.authUser!.id]
      )
      await conn.query(
        `UPDATE shop_deposits SET status = 'paid', paid_at = NOW(), updated_at = NOW() WHERE id = ?`,
        [deposit.id]
      )
      await conn.commit()
      console.log(`[shop-deposit-reprocess] admin ${req.authUser!.id} reprocessou depósito ${deposit.id} → user ${deposit.user_id} +R$${creditAmount}`)
      res.json({ ok: true, message: `R$${creditAmount} creditado para user ${deposit.user_id}.`, newBalance })
    } catch (e) {
      await conn.rollback()
      throw e
    } finally {
      conn.release()
    }
  } catch (err) {
    console.error('[shop-deposit-reprocess]', err)
    res.status(500).json({ error: 'Erro ao reprocessar depósito.' })
  }
})

// ─── Start ───────────────────────────────────────────────────────────────────
app.get('/api/monthly-salary-plans', async (_req, res) => {
  try {
    await ensureMonthlySalaryPlansTable()

    const [rows] = await pool.query<RowDataPacket[]>(
      `
      SELECT
        id,
        title,
        image_url AS imageUrl,
        monthly_salary AS monthlySalary,
        required_level1_deposited AS requiredLevel1Deposited,
        required_level2_deposited AS requiredLevel2Deposited,
        required_level3_deposited AS requiredLevel3Deposited,
        is_active AS isActive,
        sort_order AS sortOrder
      FROM monthly_salary_plans
      WHERE is_active = 1
      ORDER BY sort_order ASC, id ASC
      `
    )

    const plans = rows.map((row) => ({
      id: Number(row.id),
      title: String(row.title ?? ''),
      imageUrl: String(row.imageUrl ?? ''),
      monthlySalary: Number(row.monthlySalary ?? 0),
      requiredLevel1Deposited: Number(row.requiredLevel1Deposited ?? 0),
      requiredLevel2Deposited: Number(row.requiredLevel2Deposited ?? 0),
      requiredLevel3Deposited: Number(row.requiredLevel3Deposited ?? 0),
      isActive: Number(row.isActive ?? 1) === 1,
      sortOrder: Number(row.sortOrder ?? 0),
    }))

    res.json({ ok: true, plans })
  } catch (err) {
    console.error('[monthly-salary-plans-list]', err)
    res.status(500).json({ ok: false, error: 'Erro ao carregar planos de salário mensal.' })
  }
})

app.get('/api/admin/monthly-salary-plans', requireMaxAdmin, async (_req, res) => {
  try {
    await ensureMonthlySalaryPlansTable()

    const [rows] = await pool.query<RowDataPacket[]>(
      `
      SELECT
        id,
        title,
        image_url AS imageUrl,
        monthly_salary AS monthlySalary,
        required_level1_deposited AS requiredLevel1Deposited,
        required_level2_deposited AS requiredLevel2Deposited,
        required_level3_deposited AS requiredLevel3Deposited,
        is_active AS isActive,
        sort_order AS sortOrder
      FROM monthly_salary_plans
      ORDER BY sort_order ASC, id ASC
      `
    )

    const plans = rows.map((row) => ({
      id: Number(row.id),
      title: String(row.title ?? ''),
      imageUrl: String(row.imageUrl ?? ''),
      monthlySalary: Number(row.monthlySalary ?? 0),
      requiredLevel1Deposited: Number(row.requiredLevel1Deposited ?? 0),
      requiredLevel2Deposited: Number(row.requiredLevel2Deposited ?? 0),
      requiredLevel3Deposited: Number(row.requiredLevel3Deposited ?? 0),
      isActive: Number(row.isActive ?? 1) === 1,
      sortOrder: Number(row.sortOrder ?? 0),
    }))

    res.json({ ok: true, plans })
  } catch (err) {
    console.error('[admin-monthly-salary-plans-list]', err)
    res.status(500).json({ ok: false, error: 'Erro ao carregar planos de salário mensal.' })
  }
})

app.post('/api/admin/monthly-salary-plans', requireMaxAdmin, async (req, res) => {
  const {
    title,
    imageUrl,
    monthlySalary,
    requiredLevel1Deposited,
    requiredLevel2Deposited,
    requiredLevel3Deposited,
    isActive,
    sortOrder,
  } = req.body as {
    title?: string
    imageUrl?: string
    monthlySalary?: number | string
    requiredLevel1Deposited?: number | string
    requiredLevel2Deposited?: number | string
    requiredLevel3Deposited?: number | string
    isActive?: boolean | number | string
    sortOrder?: number | string
  }

  const parsedTitle = String(title ?? '').trim()
  const parsedImageUrl = String(imageUrl ?? '').trim()
  const parsedMonthlySalary = Number(String(monthlySalary ?? '').replace(',', '.'))
  const parsedL1 = Number(String(requiredLevel1Deposited ?? 0))
  const parsedL2 = Number(String(requiredLevel2Deposited ?? 0))
  const parsedL3 = Number(String(requiredLevel3Deposited ?? 0))
  const parsedSortOrder = Number(String(sortOrder ?? 0))
  const parsedIsActive =
    isActive === true || isActive === 1 || String(isActive ?? '').toLowerCase() === 'true' ? 1 : 0

  if (!parsedTitle) {
    res.status(400).json({ ok: false, error: 'Título do plano é obrigatório.' })
    return
  }

  if (!Number.isFinite(parsedMonthlySalary) || parsedMonthlySalary < 0) {
    res.status(400).json({ ok: false, error: 'Salário mensal inválido.' })
    return
  }

  if (!Number.isInteger(parsedL1) || parsedL1 < 0 || !Number.isInteger(parsedL2) || parsedL2 < 0 || !Number.isInteger(parsedL3) || parsedL3 < 0) {
    res.status(400).json({ ok: false, error: 'Requisitos de níveis inválidos.' })
    return
  }

  if (!Number.isInteger(parsedSortOrder)) {
    res.status(400).json({ ok: false, error: 'Ordem inválida.' })
    return
  }

  try {
    await ensureMonthlySalaryPlansTable()

    const [result] = await pool.query(
      `
      INSERT INTO monthly_salary_plans
      (
        title,
        image_url,
        monthly_salary,
        required_level1_deposited,
        required_level2_deposited,
        required_level3_deposited,
        is_active,
        sort_order
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      [
        parsedTitle,
        parsedImageUrl || null,
        Number(parsedMonthlySalary.toFixed(2)),
        parsedL1,
        parsedL2,
        parsedL3,
        parsedIsActive,
        parsedSortOrder,
      ]
    ) as any

    res.status(201).json({
      ok: true,
      message: 'Plano criado com sucesso.',
      plan: {
        id: Number(result?.insertId ?? 0),
        title: parsedTitle,
      },
    })
  } catch (err) {
    console.error('[admin-monthly-salary-plans-create]', err)
    res.status(500).json({ ok: false, error: 'Erro ao criar plano de salário mensal.' })
  }
})

app.put('/api/admin/monthly-salary-plans/:id', requireMaxAdmin, async (req, res) => {
  const planId = Number(req.params.id)
  const {
    title,
    imageUrl,
    monthlySalary,
    requiredLevel1Deposited,
    requiredLevel2Deposited,
    requiredLevel3Deposited,
    isActive,
    sortOrder,
  } = req.body as {
    title?: string
    imageUrl?: string
    monthlySalary?: number | string
    requiredLevel1Deposited?: number | string
    requiredLevel2Deposited?: number | string
    requiredLevel3Deposited?: number | string
    isActive?: boolean | number | string
    sortOrder?: number | string
  }

  if (!planId || Number.isNaN(planId)) {
    res.status(400).json({ ok: false, error: 'ID do plano inválido.' })
    return
  }

  const parsedTitle = String(title ?? '').trim()
  const parsedImageUrl = String(imageUrl ?? '').trim()
  const parsedMonthlySalary = Number(String(monthlySalary ?? '').replace(',', '.'))
  const parsedL1 = Number(String(requiredLevel1Deposited ?? 0))
  const parsedL2 = Number(String(requiredLevel2Deposited ?? 0))
  const parsedL3 = Number(String(requiredLevel3Deposited ?? 0))
  const parsedSortOrder = Number(String(sortOrder ?? 0))
  const parsedIsActive =
    isActive === true || isActive === 1 || String(isActive ?? '').toLowerCase() === 'true' ? 1 : 0

  if (!parsedTitle) {
    res.status(400).json({ ok: false, error: 'Título do plano é obrigatório.' })
    return
  }

  if (!Number.isFinite(parsedMonthlySalary) || parsedMonthlySalary < 0) {
    res.status(400).json({ ok: false, error: 'Salário mensal inválido.' })
    return
  }

  if (!Number.isInteger(parsedL1) || parsedL1 < 0 || !Number.isInteger(parsedL2) || parsedL2 < 0 || !Number.isInteger(parsedL3) || parsedL3 < 0) {
    res.status(400).json({ ok: false, error: 'Requisitos de níveis inválidos.' })
    return
  }

  if (!Number.isInteger(parsedSortOrder)) {
    res.status(400).json({ ok: false, error: 'Ordem inválida.' })
    return
  }

  try {
    await ensureMonthlySalaryPlansTable()

    const [result] = await pool.query(
      `
      UPDATE monthly_salary_plans
      SET
        title = ?,
        image_url = ?,
        monthly_salary = ?,
        required_level1_deposited = ?,
        required_level2_deposited = ?,
        required_level3_deposited = ?,
        is_active = ?,
        sort_order = ?,
        updated_at = NOW()
      WHERE id = ?
      `,
      [
        parsedTitle,
        parsedImageUrl || null,
        Number(parsedMonthlySalary.toFixed(2)),
        parsedL1,
        parsedL2,
        parsedL3,
        parsedIsActive,
        parsedSortOrder,
        planId,
      ]
    ) as any

    if (Number(result?.affectedRows ?? 0) <= 0) {
      res.status(404).json({ ok: false, error: 'Plano não encontrado.' })
      return
    }

    res.json({ ok: true, message: 'Plano atualizado com sucesso.' })
  } catch (err) {
    console.error('[admin-monthly-salary-plans-update]', err)
    res.status(500).json({ ok: false, error: 'Erro ao atualizar plano de salário mensal.' })
  }
})

app.delete('/api/admin/monthly-salary-plans/:id', requireMaxAdmin, async (req, res) => {
  const planId = Number(req.params.id)

  if (!planId || Number.isNaN(planId)) {
    res.status(400).json({ ok: false, error: 'ID do plano inválido.' })
    return
  }

  try {
    await ensureMonthlySalaryPlansTable()

    const [result] = await pool.query(
      'DELETE FROM monthly_salary_plans WHERE id = ?',
      [planId]
    ) as any

    if (Number(result?.affectedRows ?? 0) <= 0) {
      res.status(404).json({ ok: false, error: 'Plano não encontrado.' })
      return
    }

    res.json({ ok: true, message: 'Plano apagado com sucesso.' })
  } catch (err) {
    console.error('[admin-monthly-salary-plans-delete]', err)
    res.status(500).json({ ok: false, error: 'Erro ao apagar plano de salário mensal.' })
  }
})

app.post('/api/monthly-salary-plans/claim', async (req, res) => {
  const { userId, planId } = req.body as { userId?: number; planId?: number }

  const parsedUserId = Number(userId)
  const parsedPlanId = Number(planId)

  if (!parsedUserId || Number.isNaN(parsedUserId)) {
    res.status(400).json({ ok: false, error: 'ID de usuário inválido.' })
    return
  }

  if (!parsedPlanId || Number.isNaN(parsedPlanId)) {
    res.status(400).json({ ok: false, error: 'ID do plano inválido.' })
    return
  }

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()
    await ensureMonthlySalaryPlansTable()

    try {
      await conn.query(
        `
        ALTER TABLE users
        ADD COLUMN monthly_salary_contract VARCHAR(255) NULL
        `
      )
    } catch {
      // coluna já existe
    }

    const [userRows] = await conn.query<RowDataPacket[]>(
      `
      SELECT id, phone, monthly_salary_contract AS monthlySalaryContract
      FROM users
      WHERE id = ?
      LIMIT 1
      FOR UPDATE
      `,
      [parsedUserId]
    )

    if (userRows.length === 0) {
      await conn.rollback()
      res.status(404).json({ ok: false, error: 'Usuário não encontrado.' })
      return
    }

    const [planRows] = await conn.query<RowDataPacket[]>(
      `
      SELECT
        id,
        title,
        monthly_salary AS monthlySalary,
        required_level1_deposited AS requiredLevel1Deposited,
        required_level2_deposited AS requiredLevel2Deposited,
        required_level3_deposited AS requiredLevel3Deposited,
        is_active AS isActive
      FROM monthly_salary_plans
      WHERE id = ?
      LIMIT 1
      FOR UPDATE
      `,
      [parsedPlanId]
    )

    if (planRows.length === 0 || Number(planRows[0].isActive ?? 0) !== 1) {
      await conn.rollback()
      res.status(404).json({ ok: false, error: 'Plano de salário mensal não encontrado ou inativo.' })
      return
    }

    const plan = planRows[0]
    const monthlySalaryAmount = Number(plan.monthlySalary ?? 0)
    const monthlySalaryFormatted = monthlySalaryAmount.toLocaleString('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    })
    const requiredL1 = Number(plan.requiredLevel1Deposited ?? 0)
    const requiredL2 = Number(plan.requiredLevel2Deposited ?? 0)
    const requiredL3 = Number(plan.requiredLevel3Deposited ?? 0)

    const [refCountRows] = await conn.query<RowDataPacket[]>(
      `
      WITH RECURSIVE referral_tree AS (
        SELECT
          u.id,
          1 AS level
        FROM users u
        WHERE u.referred_by_user_id = ?

        UNION ALL

        SELECT
          u2.id,
          rt.level + 1 AS level
        FROM users u2
        INNER JOIN referral_tree rt ON u2.referred_by_user_id = rt.id
        WHERE rt.level < 3
      ),
      paid_users AS (
        SELECT DISTINCT cp.user_id
        FROM cashin_payments cp
        WHERE LOWER(cp.status) IN ('paid', 'payment.paid')
      )
      SELECT
        COUNT(DISTINCT CASE WHEN rt.level = 1 AND pu.user_id IS NOT NULL THEN rt.id END) AS level1Deposited,
        COUNT(DISTINCT CASE WHEN rt.level = 2 AND pu.user_id IS NOT NULL THEN rt.id END) AS level2Deposited,
        COUNT(DISTINCT CASE WHEN rt.level = 3 AND pu.user_id IS NOT NULL THEN rt.id END) AS level3Deposited
      FROM referral_tree rt
      LEFT JOIN paid_users pu ON pu.user_id = rt.id
      `,
      [parsedUserId]
    )

    const level1Deposited = Number(refCountRows[0]?.level1Deposited ?? 0)
    const level2Deposited = Number(refCountRows[0]?.level2Deposited ?? 0)
    const level3Deposited = Number(refCountRows[0]?.level3Deposited ?? 0)

    const hasRequirements =
      level1Deposited >= requiredL1 &&
      level2Deposited >= requiredL2 &&
      level3Deposited >= requiredL3

    if (!hasRequirements) {
      await conn.rollback()
      res.status(400).json({
        ok: false,
        error: 'Usuário não atende os requisitos para obter este contrato.',
        requirements: {
          requiredLevel1Deposited: requiredL1,
          requiredLevel2Deposited: requiredL2,
          requiredLevel3Deposited: requiredL3,
        },
        current: {
          level1Deposited,
          level2Deposited,
          level3Deposited,
        },
      })
      return
    }

    const contractLabel = String(plan.title ?? 'Start V1').trim() || 'Start V1'
    const currentContract = String(userRows[0]?.monthlySalaryContract ?? '').trim()

    if (currentContract && currentContract === contractLabel) {
      await conn.rollback()
      res.status(400).json({ ok: false, error: 'Este plano já foi obtido anteriormente.' })
      return
    }

    await conn.query(
      `
      UPDATE users
      SET monthly_salary_contract = ?
      WHERE id = ?
      `,
      [contractLabel, parsedUserId]
    )

    await conn.commit()

    try {
      const [telegramRows] = await pool.query<RowDataPacket[]>(
        `
        SELECT
          bot_token AS botToken,
          group_id AS groupId
        FROM system_telegram_config
        WHERE TRIM(bot_token) <> ''
          AND TRIM(group_id) <> ''
        ORDER BY id ASC
        LIMIT 1
        `
      )

      const botToken = String(telegramRows[0]?.botToken ?? '').trim()
      const groupId = String(telegramRows[0]?.groupId ?? '').trim()

      const rawPhone = String(userRows[0]?.phone ?? '').replace(/\D/g, '')
      const maskedPhone =
        rawPhone.length >= 8
          ? `${rawPhone.slice(0, 1)}***${rawPhone.slice(Math.max(rawPhone.length - 5, 1), Math.max(rawPhone.length - 4, 2))}***${rawPhone.slice(-2)}`
          : (rawPhone || '***')

      if (botToken && groupId) {
        const announcementMessage = `📢 【Anúncio Oficial NOOR: Boletim de Promoção de Promotores】 🎁

Parabéns ao usuário Telefone: ${maskedPhone} por ter sido promovido a Promotor ${contractLabel}

Agora ele receberá um salario mensal de ${monthlySalaryFormatted} em sua conta creditado todos os meses.

💡 Ao convidar amigos para se cadastrar e operar na plataforma, você não só ganha generosas recompensas em dinheiro por promoção, como também recebe comissões permanentes sobre taxas e ganhos de suas subcontas.`

        await sendTelegramMessage(botToken, groupId, announcementMessage)
      }
    } catch (telegramErr) {
      console.error('[monthly-salary-claim-telegram-announcement]', telegramErr)
    }

    res.json({
      ok: true,
      message: 'Contrato obtido com sucesso.',
      contract: contractLabel,
      plan: {
        id: Number(plan.id),
        title: String(plan.title ?? ''),
      },
    })
  } catch (err) {
    await conn.rollback()
    console.error('[monthly-salary-claim]', err)
    res.status(500).json({ ok: false, error: 'Erro ao obter contrato de salário mensal.' })
  } finally {
    conn.release()
  }
})

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
    await ensureCycleProductsTable()
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
        sort_order AS sortOrder,
        plan_type AS planType,
        stock_quantity AS stockQuantity,
        expires_at AS expiresAt,
        COALESCE(require_commission_level1_count, require_commission_level_1_count, 0) AS requireCommissionLevel1Count,
        COALESCE(require_commission_level2_count, require_commission_level_2_count, 0) AS requireCommissionLevel2Count,
        COALESCE(require_commission_level3_count, require_commission_level_3_count, 0) AS requireCommissionLevel3Count
      FROM cycle_products
      WHERE is_active = 1
      ORDER BY sort_order ASC, id ASC
      `
    )

    const products = rows.map((row) => {
      const rawPlanType = String(row.planType ?? 'normal').trim().toLowerCase()
      const planType =
        rawPlanType === 'vip' || rawPlanType === 'vip_day'
          ? rawPlanType
          : 'normal'

      return {
        id: Number(row.id),
        name: String(row.name ?? ''),
        description: String(row.description ?? ''),
        amount: Number(row.amount ?? 0),
        profit: Number(row.profit ?? 0),
        cycleDays: Number(row.cycleDays ?? 0),
        imageUrl: String(row.imageUrl ?? ''),
        isActive: Number(row.isActive ?? 1) === 1,
        sortOrder: Number(row.sortOrder ?? 0),
        planType,
        stockQuantity: Number(row.stockQuantity ?? 0),
        expiresAt: row.expiresAt ?? null,
        requireCommissionLevel1Count: Number(row.requireCommissionLevel1Count ?? 0),
        requireCommissionLevel2Count: Number(row.requireCommissionLevel2Count ?? 0),
        requireCommissionLevel3Count: Number(row.requireCommissionLevel3Count ?? 0),
      }
    })

    res.json({ ok: true, products })
  } catch (err) {
    console.error('[dashboard-cycle-products]', err)
    res.status(500).json({ ok: false, error: 'Erro ao listar planos de ciclo.' })
  }
})

app.get('/api/admin/cycle-products', requireMaxAdmin, async (_req, res) => {
  try {
    await ensureCycleProductsTable()

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
        sort_order AS sortOrder,
        plan_type AS planType,
        stock_quantity AS stockQuantity,
        expires_at AS expiresAt,
        COALESCE(require_commission_level1_count, require_commission_level_1_count, 0) AS requireCommissionLevel1Count,
        COALESCE(require_commission_level2_count, require_commission_level_2_count, 0) AS requireCommissionLevel2Count,
        COALESCE(require_commission_level3_count, require_commission_level_3_count, 0) AS requireCommissionLevel3Count,
        created_at AS createdAt
      FROM cycle_products
      ORDER BY sort_order ASC, id ASC
      `
    )

    const products = rows.map((row) => ({
      id: Number(row.id),
      name: String(row.name ?? ''),
      description: String(row.description ?? ''),
      imageUrl: String(row.imageUrl ?? ''),
      price: Number(row.amount ?? 0),
      redeemRewardValue: Number(row.profit ?? 0),
      cycleDays: Number(row.cycleDays ?? 0),
      isActive: Number(row.isActive ?? 1) === 1,
      sortOrder: Number(row.sortOrder ?? 0),
      planType: String(row.planType ?? 'normal'),
      stockQuantity: Number(row.stockQuantity ?? 0),
      expiresAt: row.expiresAt ?? null,
      requireCommissionLevel1Count: Number(row.requireCommissionLevel1Count ?? 0),
      requireCommissionLevel2Count: Number(row.requireCommissionLevel2Count ?? 0),
      requireCommissionLevel3Count: Number(row.requireCommissionLevel3Count ?? 0),
      createdAt: row.createdAt ?? null,
    }))

    res.json({ ok: true, products })
  } catch (err) {
    console.error('[admin-cycle-products-list]', err)
    res.status(500).json({ ok: false, error: 'Erro ao carregar produtos de ciclo.' })
  }
})

app.post('/api/admin/cycle-products', requireMaxAdmin, async (req, res) => {
  const {
    name, description, imageUrl, price, redeemRewardValue, isActive,
    cycleDays, sortOrder, planType, stockQuantity, expiresAt,
    requireCommissionLevel1Count, requireCommissionLevel2Count, requireCommissionLevel3Count,
  } = req.body as {
    name?: string
    description?: string
    imageUrl?: string
    price?: number | string
    redeemRewardValue?: number | string
    isActive?: boolean | number | string
    cycleDays?: number | string
    sortOrder?: number | string
    planType?: string
    stockQuantity?: number | string
    expiresAt?: string | null
    requireCommissionLevel1Count?: number | string
    requireCommissionLevel2Count?: number | string
    requireCommissionLevel3Count?: number | string
  }

  const parsedName = String(name ?? '').trim()
  const parsedDescription = String(description ?? '').trim()
  const parsedImageUrl = String(imageUrl ?? '').trim()
  const parsedPrice = Number(String(price ?? '').replace(',', '.'))
  const parsedRedeemRewardValue = Number(String(redeemRewardValue ?? '').replace(',', '.'))
  const parsedCycleDays = Number(String(cycleDays ?? 0))
  const parsedSortOrder = Number(String(sortOrder ?? 0))
  const parsedIsActive =
    isActive === true || isActive === 1 || String(isActive ?? '').toLowerCase() === 'true' ? 1 : 0
  const parsedStockQuantity = Number(String(stockQuantity ?? 0))
  const parsedPlanTypeRaw = String(planType ?? 'normal').trim().toLowerCase()
  const parsedPlanType =
    parsedPlanTypeRaw === 'vip' || parsedPlanTypeRaw === 'vip_day'
      ? parsedPlanTypeRaw
      : 'normal'
  const parsedLevel1 = Math.max(0, Number(String(requireCommissionLevel1Count ?? 0)))
  const parsedLevel2 = Math.max(0, Number(String(requireCommissionLevel2Count ?? 0)))
  const parsedLevel3 = Math.max(0, Number(String(requireCommissionLevel3Count ?? 0)))
  const parsedExpiresAt = parsedPlanType === 'vip_day' && expiresAt ? String(expiresAt) : null

  if (!parsedName) {
    res.status(400).json({ ok: false, error: 'Nome do produto é obrigatório.' })
    return
  }

  if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) {
    res.status(400).json({ ok: false, error: 'Preço inválido.' })
    return
  }

  if (!Number.isFinite(parsedRedeemRewardValue) || parsedRedeemRewardValue < 0) {
    res.status(400).json({ ok: false, error: 'Valor de resgate inválido.' })
    return
  }

  if (!Number.isInteger(parsedCycleDays) || parsedCycleDays < 0) {
    res.status(400).json({ ok: false, error: 'Ciclo (dias) inválido.' })
    return
  }

  try {
    await ensureCycleProductsTable()

    const [result] = await pool.query(
      `
      INSERT INTO cycle_products
      (
        name,
        description,
        amount,
        profit,
        cycle_days,
        stock_quantity,
        image_url,
        is_active,
        sort_order,
        plan_type,
        expires_at,
        require_commission_level1_count,
        require_commission_level2_count,
        require_commission_level3_count
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        parsedName,
        parsedDescription || null,
        Number(parsedPrice.toFixed(2)),
        Number(parsedRedeemRewardValue.toFixed(2)),
        parsedCycleDays,
        Number.isFinite(parsedStockQuantity) ? parsedStockQuantity : 0,
        parsedImageUrl || null,
        parsedIsActive,
        Number.isFinite(parsedSortOrder) ? parsedSortOrder : 0,
        parsedPlanType,
        parsedExpiresAt,
        parsedLevel1,
        parsedLevel2,
        parsedLevel3,
      ]
    ) as any

    res.status(201).json({
      ok: true,
      message: 'Produto criado com sucesso.',
      product: {
        id: Number(result?.insertId ?? 0),
        name: parsedName,
      },
    })
  } catch (err) {
    console.error('[admin-cycle-products-create]', err)
    res.status(500).json({ ok: false, error: 'Erro ao criar produto.' })
  }
})

app.put('/api/admin/cycle-products/:id', requireMaxAdmin, async (req, res) => {
  const productId = Number(req.params.id)
  const {
    name, description, imageUrl, price, redeemRewardValue, isActive,
    cycleDays, sortOrder, planType, stockQuantity, expiresAt,
    requireCommissionLevel1Count, requireCommissionLevel2Count, requireCommissionLevel3Count,
  } = req.body as {
    name?: string
    description?: string
    imageUrl?: string
    price?: number | string
    redeemRewardValue?: number | string
    isActive?: boolean | number | string
    cycleDays?: number | string
    sortOrder?: number | string
    planType?: string
    stockQuantity?: number | string
    expiresAt?: string | null
    requireCommissionLevel1Count?: number | string
    requireCommissionLevel2Count?: number | string
    requireCommissionLevel3Count?: number | string
  }

  if (!productId || Number.isNaN(productId)) {
    res.status(400).json({ ok: false, error: 'ID do produto inválido.' })
    return
  }

  const parsedName = String(name ?? '').trim()
  const parsedDescription = String(description ?? '').trim()
  const parsedImageUrl = String(imageUrl ?? '').trim()
  const parsedPrice = Number(String(price ?? '').replace(',', '.'))
  const parsedRedeemRewardValue = Number(String(redeemRewardValue ?? '').replace(',', '.'))
  const parsedCycleDays = Number(String(cycleDays ?? 0))
  const parsedSortOrder = Number(String(sortOrder ?? 0))
  const parsedIsActive =
    isActive === true || isActive === 1 || String(isActive ?? '').toLowerCase() === 'true' ? 1 : 0
  const parsedStockQuantity = Number(String(stockQuantity ?? 0))
  const parsedPlanTypeRaw = String(planType ?? 'normal').trim().toLowerCase()
  const parsedPlanType =
    parsedPlanTypeRaw === 'vip' || parsedPlanTypeRaw === 'vip_day'
      ? parsedPlanTypeRaw
      : 'normal'
  const parsedLevel1 = Math.max(0, Number(String(requireCommissionLevel1Count ?? 0)))
  const parsedLevel2 = Math.max(0, Number(String(requireCommissionLevel2Count ?? 0)))
  const parsedLevel3 = Math.max(0, Number(String(requireCommissionLevel3Count ?? 0)))
  const parsedExpiresAt = parsedPlanType === 'vip_day' && expiresAt ? String(expiresAt) : null

  if (!parsedName) {
    res.status(400).json({ ok: false, error: 'Nome do produto é obrigatório.' })
    return
  }

  if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) {
    res.status(400).json({ ok: false, error: 'Preço inválido.' })
    return
  }

  if (!Number.isFinite(parsedRedeemRewardValue) || parsedRedeemRewardValue < 0) {
    res.status(400).json({ ok: false, error: 'Valor de resgate inválido.' })
    return
  }

  if (!Number.isInteger(parsedCycleDays) || parsedCycleDays < 0) {
    res.status(400).json({ ok: false, error: 'Ciclo (dias) inválido.' })
    return
  }

  try {
    await ensureCycleProductsTable()

    const [result] = await pool.query(
      `
      UPDATE cycle_products
      SET
        name = ?,
        description = ?,
        amount = ?,
        profit = ?,
        cycle_days = ?,
        stock_quantity = ?,
        image_url = ?,
        is_active = ?,
        sort_order = ?,
        plan_type = ?,
        expires_at = ?,
        require_commission_level1_count = ?,
        require_commission_level2_count = ?,
        require_commission_level3_count = ?,
        updated_at = NOW()
      WHERE id = ?
      `,
      [
        parsedName,
        parsedDescription || null,
        Number(parsedPrice.toFixed(2)),
        Number(parsedRedeemRewardValue.toFixed(2)),
        parsedCycleDays,
        Number.isFinite(parsedStockQuantity) ? parsedStockQuantity : 0,
        parsedImageUrl || null,
        parsedIsActive,
        Number.isFinite(parsedSortOrder) ? parsedSortOrder : 0,
        parsedPlanType,
        parsedExpiresAt,
        parsedLevel1,
        parsedLevel2,
        parsedLevel3,
        productId,
      ]
    ) as any

    if (Number(result?.affectedRows ?? 0) <= 0) {
      res.status(404).json({ ok: false, error: 'Produto não encontrado.' })
      return
    }

    res.json({ ok: true, message: 'Produto atualizado com sucesso.' })
  } catch (err) {
    console.error('[admin-cycle-products-update]', err)
    res.status(500).json({ ok: false, error: 'Erro ao atualizar produto.' })
  }
})

app.delete('/api/admin/cycle-products/:id', requireMaxAdmin, async (req, res) => {
  const productId = Number(req.params.id)

  if (!productId || Number.isNaN(productId)) {
    res.status(400).json({ ok: false, error: 'ID do produto inválido.' })
    return
  }

  try {
    await ensureCycleProductsTable()

    const [result] = await pool.query(
      'DELETE FROM cycle_products WHERE id = ?',
      [productId]
    ) as any

    if (Number(result?.affectedRows ?? 0) <= 0) {
      res.status(404).json({ ok: false, error: 'Produto não encontrado.' })
      return
    }

    res.json({ ok: true, message: 'Produto apagado com sucesso.' })
  } catch (err) {
    console.error('[admin-cycle-products-delete]', err)
    res.status(500).json({ ok: false, error: 'Erro ao apagar produto.' })
  }
})

// ────────────────────────────────────────────────────────────────
//  USER — Mini Tasks (public routes)
// ────────────────────────────────────────────────────────────────

const ensureMiniTaskRedemptionsTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mini_task_redemptions (
      id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id    BIGINT UNSIGNED NOT NULL,
      task_id    BIGINT UNSIGNED NOT NULL,
      redeemed_at DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_user_task (user_id, task_id)
    )
  `)
}

// GET /api/mini-tasks/:userId — lista tasks com progresso do usuário
app.get('/api/mini-tasks/:userId', requireAuth, async (req, res) => {
  const userId = Number(req.params.userId)
  if (!userId || userId <= 0) {
    res.status(400).json({ ok: false, error: 'ID inválido.' })
    return
  }

  try {
    await ensureMiniTasksTable()
    await ensureMiniTaskRedemptionsTable()

    // Conta quantos indicados diretos o usuário tem
    const [inviteRows] = await pool.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS total FROM users WHERE referred_by_user_id = ?',
      [userId]
    )
    const inviteCount = Number(inviteRows[0]?.total ?? 0)

    // Busca tasks ativas
    const [tasks] = await pool.query<RowDataPacket[]>(`
      SELECT
        t.id,
        t.title,
        t.invite_goal   AS inviteGoal,
        t.reward_amount AS rewardAmount,
        t.badge_label   AS badgeLabel,
        t.sort_order    AS sortOrder,
        (SELECT COUNT(*) FROM mini_task_redemptions r WHERE r.user_id = ? AND r.task_id = t.id) AS redeemed
      FROM mini_tasks t
      WHERE t.is_active = 1
      ORDER BY t.sort_order ASC, t.id ASC
    `, [userId])

    const result = tasks.map((t) => ({
      id:           Number(t.id),
      title:        String(t.title ?? ''),
      inviteGoal:   Number(t.inviteGoal ?? 0),
      rewardAmount: Number(t.rewardAmount ?? 0),
      badgeLabel:   String(t.badgeLabel ?? ''),
      sortOrder:    Number(t.sortOrder ?? 0),
      progress:     inviteCount,
      redeemed:     Boolean(t.redeemed),
      canRedeem:    !Boolean(t.redeemed) && inviteCount >= Number(t.inviteGoal ?? 0),
    }))

    res.json({ ok: true, tasks: result, inviteCount })
  } catch (err) {
    console.error('[mini-tasks-get-user]', err)
    res.status(500).json({ ok: false, error: 'Erro ao carregar mini tasks.' })
  }
})

// POST /api/mini-tasks/:taskId/redeem — resgata recompensa da task
app.post('/api/mini-tasks/:taskId/redeem', requireAuth, async (req, res) => {
  const taskId = Number(req.params.taskId)
  const userId = Number((req as any).authUser?.id ?? 0)

  if (!taskId || taskId <= 0 || !userId) {
    res.status(400).json({ ok: false, error: 'ID inválido.' })
    return
  }

  try {
    await ensureMiniTasksTable()
    await ensureMiniTaskRedemptionsTable()

    // Busca a task
    const [taskRows] = await pool.query<RowDataPacket[]>(
      'SELECT id, title, invite_goal, reward_amount FROM mini_tasks WHERE id = ? AND is_active = 1',
      [taskId]
    )
    if (taskRows.length === 0) {
      res.status(404).json({ ok: false, error: 'Mini task não encontrada.' })
      return
    }
    const task = taskRows[0]
    const inviteGoal   = Number(task.invite_goal ?? 0)
    const rewardAmount = Number(task.reward_amount ?? 0)

    // Verifica se já resgatou
    const [redeemedRows] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM mini_task_redemptions WHERE user_id = ? AND task_id = ?',
      [userId, taskId]
    )
    if (redeemedRows.length > 0) {
      res.status(400).json({ ok: false, error: 'Você já resgatou esta recompensa.' })
      return
    }

    // Conta convites do usuário
    const [inviteRows] = await pool.query<RowDataPacket[]>(
      'SELECT COUNT(*) AS total FROM users WHERE referred_by_user_id = ?',
      [userId]
    )
    const inviteCount = Number(inviteRows[0]?.total ?? 0)

    if (inviteCount < inviteGoal) {
      res.status(400).json({
        ok: false,
        error: `Você precisa de ${inviteGoal} indicações para resgatar esta recompensa. Você tem ${inviteCount}.`
      })
      return
    }

    // Registra o resgate e credita o saldo em uma transação
    const conn = await pool.getConnection()
    try {
      await conn.beginTransaction()

      await conn.query(
        'INSERT INTO mini_task_redemptions (user_id, task_id) VALUES (?, ?)',
        [userId, taskId]
      )

      await conn.query(
        'UPDATE users SET balance = balance + ? WHERE id = ?',
        [rewardAmount, userId]
      )

      await conn.commit()
    } catch (txErr) {
      await conn.rollback()
      throw txErr
    } finally {
      conn.release()
    }

    res.json({
      ok: true,
      message: `Parabéns! Você resgatou R$ ${rewardAmount.toFixed(2)} por completar a tarefa "${task.title}".`,
      rewardAmount
    })
  } catch (err) {
    console.error('[mini-tasks-redeem]', err)
    res.status(500).json({ ok: false, error: 'Erro ao resgatar recompensa.' })
  }
})

// ────────────────────────────────────────────────────────────────
//  ADMIN — Mini Tasks
// ────────────────────────────────────────────────────────────────

const ensureMiniTasksTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mini_tasks (
      id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      title       VARCHAR(255)    NOT NULL,
      invite_goal INT UNSIGNED    NOT NULL DEFAULT 0,
      reward_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      badge_label VARCHAR(100)    NOT NULL DEFAULT '',
      is_active   TINYINT(1)      NOT NULL DEFAULT 1,
      sort_order  INT             NOT NULL DEFAULT 0,
      created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_mini_tasks_sort (sort_order),
      KEY idx_mini_tasks_active (is_active)
    )
  `)
}

app.get('/api/admin/mini-tasks', requireMaxAdmin, async (_req, res) => {
  try {
    await ensureMiniTasksTable()

    const [rows] = await pool.query<RowDataPacket[]>(`
      SELECT
        id,
        title,
        invite_goal   AS inviteGoal,
        reward_amount AS rewardAmount,
        badge_label   AS badgeLabel,
        is_active     AS isActive,
        sort_order    AS sortOrder
      FROM mini_tasks
      ORDER BY sort_order ASC, id ASC
    `)

    const tasks = rows.map((row) => ({
      id:           Number(row.id),
      title:        String(row.title ?? ''),
      inviteGoal:   Number(row.inviteGoal ?? 0),
      rewardAmount: Number(row.rewardAmount ?? 0),
      badgeLabel:   String(row.badgeLabel ?? ''),
      isActive:     Boolean(row.isActive),
      sortOrder:    Number(row.sortOrder ?? 0),
    }))

    res.json({ ok: true, tasks })
  } catch (err) {
    console.error('[admin-mini-tasks-get]', err)
    res.status(500).json({ ok: false, error: 'Erro ao carregar mini tasks.' })
  }
})

app.post('/api/admin/mini-tasks', requireMaxAdmin, async (req, res) => {
  const { title, inviteGoal, rewardAmount, badgeLabel, isActive, sortOrder } = req.body as {
    title?: string
    inviteGoal?: number | string
    rewardAmount?: number | string
    badgeLabel?: string
    isActive?: boolean | number
    sortOrder?: number | string
  }

  const parsedTitle = String(title ?? '').trim()
  if (!parsedTitle) {
    res.status(400).json({ ok: false, error: 'Título é obrigatório.' })
    return
  }

  const parsedInviteGoal  = Math.max(0, Math.round(Number(inviteGoal ?? 0)))
  const parsedReward      = Math.max(0, Number(String(rewardAmount ?? '0').replace(',', '.')))
  const parsedBadge       = String(badgeLabel ?? '').trim()
  const parsedActive      = isActive === true || Number(isActive) === 1 ? 1 : 0
  const parsedSortOrder   = Number(sortOrder ?? 0)

  if (!Number.isFinite(parsedReward)) {
    res.status(400).json({ ok: false, error: 'Recompensa inválida.' })
    return
  }

  try {
    await ensureMiniTasksTable()

    const [result] = await pool.query(
      `
      INSERT INTO mini_tasks (title, invite_goal, reward_amount, badge_label, is_active, sort_order)
      VALUES (?, ?, ?, ?, ?, ?)
      `,
      [parsedTitle, parsedInviteGoal, parsedReward, parsedBadge, parsedActive, parsedSortOrder]
    ) as any

    res.json({ ok: true, message: 'Mini task criada com sucesso.', id: Number(result?.insertId ?? 0) })
  } catch (err) {
    console.error('[admin-mini-tasks-post]', err)
    res.status(500).json({ ok: false, error: 'Erro ao criar mini task.' })
  }
})

app.put('/api/admin/mini-tasks/:id', requireMaxAdmin, async (req, res) => {
  const taskId = Number(req.params.id)
  if (!taskId || !Number.isInteger(taskId) || taskId <= 0) {
    res.status(400).json({ ok: false, error: 'ID inválido.' })
    return
  }

  const { title, inviteGoal, rewardAmount, badgeLabel, isActive, sortOrder } = req.body as {
    title?: string
    inviteGoal?: number | string
    rewardAmount?: number | string
    badgeLabel?: string
    isActive?: boolean | number
    sortOrder?: number | string
  }

  const parsedTitle = String(title ?? '').trim()
  if (!parsedTitle) {
    res.status(400).json({ ok: false, error: 'Título é obrigatório.' })
    return
  }

  const parsedInviteGoal  = Math.max(0, Math.round(Number(inviteGoal ?? 0)))
  const parsedReward      = Math.max(0, Number(String(rewardAmount ?? '0').replace(',', '.')))
  const parsedBadge       = String(badgeLabel ?? '').trim()
  const parsedActive      = isActive === true || Number(isActive) === 1 ? 1 : 0
  const parsedSortOrder   = Number(sortOrder ?? 0)

  if (!Number.isFinite(parsedReward)) {
    res.status(400).json({ ok: false, error: 'Recompensa inválida.' })
    return
  }

  try {
    await ensureMiniTasksTable()

    const [result] = await pool.query(
      `
      UPDATE mini_tasks
      SET title = ?, invite_goal = ?, reward_amount = ?, badge_label = ?, is_active = ?, sort_order = ?
      WHERE id = ?
      `,
      [parsedTitle, parsedInviteGoal, parsedReward, parsedBadge, parsedActive, parsedSortOrder, taskId]
    ) as any

    if (Number(result?.affectedRows ?? 0) === 0) {
      res.status(404).json({ ok: false, error: 'Mini task não encontrada.' })
      return
    }

    res.json({ ok: true, message: 'Mini task atualizada com sucesso.' })
  } catch (err) {
    console.error('[admin-mini-tasks-put]', err)
    res.status(500).json({ ok: false, error: 'Erro ao atualizar mini task.' })
  }
})

app.delete('/api/admin/mini-tasks/:id', requireMaxAdmin, async (req, res) => {
  const taskId = Number(req.params.id)
  if (!taskId || !Number.isInteger(taskId) || taskId <= 0) {
    res.status(400).json({ ok: false, error: 'ID inválido.' })
    return
  }

  try {
    await ensureMiniTasksTable()

    const [result] = await pool.query(
      `DELETE FROM mini_tasks WHERE id = ?`,
      [taskId]
    ) as any

    if (Number(result?.affectedRows ?? 0) === 0) {
      res.status(404).json({ ok: false, error: 'Mini task não encontrada.' })
      return
    }

    res.json({ ok: true, message: 'Mini task removida com sucesso.' })
  } catch (err) {
    console.error('[admin-mini-tasks-delete]', err)
    res.status(500).json({ ok: false, error: 'Erro ao remover mini task.' })
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

    // Receita de hoje: soma de todos os créditos registrados nos logs do usuário no dia atual
    // Considera apenas ações de crédito (amount > 0) excluindo compras (que debitam)
    const [todayIncomeRows] = await pool.query<RowDataPacket[]>(
      `
      SELECT COALESCE(SUM(amount), 0) AS todayIncome
      FROM logs
      WHERE user_id = ?
        AND amount > 0
        AND action NOT IN ('cycle_investment_purchase', 'withdraw_request_created', 'withdraw_request_auto_processed')
        AND DATE(created_at) = CURDATE()
      `,
      [userId]
    ).catch(() => [[{ todayIncome: 0 }], []] as unknown as [RowDataPacket[], unknown])

    const todayIncome = Number(todayIncomeRows[0]?.todayIncome ?? 0)

    res.json({
      ok: true,
      metrics: {
        teamTotal,
        withdrawableBalance,
        hasActiveCyclePlan,
        activeCyclePlan,
        todayIncome,
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
      SELECT id, name, amount, profit, cycle_days AS cycleDays, is_active AS isActive,
             stock_quantity AS stockQuantity
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

    const stockQuantity = Number(products[0].stockQuantity ?? 0)
    if (stockQuantity <= 0) {
      await conn.rollback()
      res.status(400).json({ ok: false, error: 'Produto esgotado. Estoque indisponível.' })
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

    // Decrementa o estoque do produto (protegido pelo FOR UPDATE acima)
    await conn.query(
      `
      UPDATE cycle_products
      SET stock_quantity = GREATEST(stock_quantity - 1, 0)
      WHERE id = ?
      `,
      [parsedCycleProductId]
    )

    const [purchaseInsertResult] = await conn.query(
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
    ) as any

    const newBalance = Number((userBalance - amount).toFixed(2))

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
        'cycle',
        Number(purchaseInsertResult?.insertId ?? 0),
        'cycle_investment_purchase',
        Number(userBalance.toFixed(2)),
        Number(newBalance.toFixed(2)),
        Number(amount.toFixed(2)),
        JSON.stringify({
          cycleProductId: Number(product.id),
          cycleDays: Number(product.cycleDays ?? 0),
          expectedProfit: Number(product.profit ?? 0),
          purchaseId: Number(purchaseInsertResult?.insertId ?? 0),
        }),
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

app.get('/api/roleta/spins-available/:userId', async (req, res) => {
  const userId = Number(req.params.userId)

  if (!userId || Number.isNaN(userId)) {
    res.status(400).json({ ok: false, error: 'ID de usuário inválido.' })
    return
  }

  try {
    await ensureUserRouletteSpinsTable()

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
        available_spins AS availableSpins,
        total_earned AS totalEarned,
        total_used AS totalUsed
      FROM user_roulette_spins
      WHERE user_id = ?
      LIMIT 1
      `,
      [userId]
    )

    res.json({
      ok: true,
      userId,
      availableSpins: Number(rows[0]?.availableSpins ?? 0),
      totalEarned: Number(rows[0]?.totalEarned ?? 0),
      totalUsed: Number(rows[0]?.totalUsed ?? 0),
    })
  } catch (err) {
    console.error('[roleta-spins-available]', err)
    res.status(500).json({ ok: false, error: 'Erro ao carregar giros disponíveis.' })
  }
})

// Fallback caso o banco esteja vazio
const DEFAULT_ROULETTE_SEGMENTS = ['1 BRL', '16 BRL', '35 BRL', '50 BRL', '73 BRL', '90 BRL', '183 BRL', '16600 BRL']

// Extrai o valor numérico de um label como '35 BRL' => 35
function parsePrizeAmount(label: string): number {
  const m = String(label).match(/[\d.,]+/)
  if (!m) return 0
  return Number(String(m[0]).replace(',', '.')) || 0
}

// Sorteia um item da lista com base nos pesos (percent)
function weightedRandom(items: Array<{ label: string; percent: number }>): { label: string; percent: number } {
  const total = items.reduce((acc, item) => acc + item.percent, 0)
  let rand = Math.random() * total
  for (const item of items) {
    rand -= item.percent
    if (rand <= 0) return item
  }
  return items[items.length - 1]
}

// Endpoint público: retorna os segmentos da roleta na ordem do banco (para o frontend sincronizar)
app.get('/api/roleta/segments', async (_req, res) => {
  try {
    await ensureRouletteProbabilitiesTable()
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT label FROM roulette_probabilities ORDER BY sort_order ASC, id ASC'
    )
    const segments = rows.length > 0
      ? rows.map((r) => String(r.label))
      : DEFAULT_ROULETTE_SEGMENTS
    res.json({ ok: true, segments })
  } catch (err) {
    console.error('[roleta-segments]', err)
    res.json({ ok: true, segments: DEFAULT_ROULETTE_SEGMENTS })
  }
})

app.post('/api/roleta/spin', spinLimiter, async (req, res) => {
  const { userId } = req.body as { userId?: number }
  const parsedUserId = Number(userId)

  if (!parsedUserId || Number.isNaN(parsedUserId)) {
    res.status(400).json({ ok: false, error: 'ID de usuário inválido.' })
    return
  }

  // Carrega probabilidades do banco (com fallback para padrão)
  // A ordem do banco (sort_order) define a posição visual de cada segmento na roda
  await ensureRouletteProbabilitiesTable()
  const [probRows] = await pool.query<RowDataPacket[]>(
    'SELECT label, percent FROM roulette_probabilities ORDER BY sort_order ASC, id ASC'
  )
  const probabilities: Array<{ label: string; percent: number }> = probRows.length > 0
    ? probRows.map((r) => ({ label: String(r.label), percent: Number(r.percent) }))
    : DEFAULT_ROULETTE_SEGMENTS.map((label) => ({ label, percent: 100 / DEFAULT_ROULETTE_SEGMENTS.length }))

  // Sorteia o prêmio com base nos pesos
  const picked = weightedRandom(probabilities)
  const selectedPrize = picked.label
  const fixedPrizeAmount = parsePrizeAmount(selectedPrize)

  // O índice visual do segmento é a posição no array de probabilidades (que segue sort_order do banco)
  // Isso garante que prizeIndex corresponde ao segmento visual exato na roda do frontend
  const selectedIndex = probabilities.findIndex(
    (p) => p.label.toLowerCase() === selectedPrize.toLowerCase()
  )
  const finalSegmentIndex = selectedIndex >= 0 ? selectedIndex : 0

  const segmentCount = probabilities.length
  const segmentAngle = 360 / segmentCount
  // Centro do segmento vencedor (em graus, sentido horário, 0° = topo)
  const centerAngle = finalSegmentIndex * segmentAngle + segmentAngle / 2
  // rotationFinal não é mais calculado no backend — o frontend calcula com base em prizeIndex

  const conn = await pool.getConnection()
  try {
    await ensureUserRouletteSpinsTable()
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

    const [spinRows] = await conn.query<RowDataPacket[]>(
      `
      SELECT available_spins AS availableSpins
      FROM user_roulette_spins
      WHERE user_id = ?
      LIMIT 1
      FOR UPDATE
      `,
      [parsedUserId]
    )

    const availableSpins = Number(spinRows[0]?.availableSpins ?? 0)
    if (availableSpins <= 0) {
      await conn.rollback()
      res.status(400).json({ ok: false, error: 'Você não possui giros disponíveis.' })
      return
    }

    await conn.query(
      `
      UPDATE user_roulette_spins
      SET
        available_spins = COALESCE(available_spins, 0) - 1,
        total_used = COALESCE(total_used, 0) + 1,
        updated_at = NOW()
      WHERE user_id = ?
      `,
      [parsedUserId]
    )

    await conn.query(
      `
      UPDATE users
      SET balance = COALESCE(balance, 0) + ?
      WHERE id = ?
      `,
      [fixedPrizeAmount, parsedUserId]
    )

    await conn.query(
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

    const [result] = await conn.query(
      `
      INSERT INTO roulette_spins
      (user_id, prize_label, prize_index, rotation_final, source)
      VALUES (?, ?, ?, ?, ?)
      `,
      [parsedUserId, selectedPrize, finalSegmentIndex, centerAngle, 'invite_level_1_reward']
    ) as any

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

    const oldBalance = Number(users[0].balance ?? 0)
    const newBalance = Number((oldBalance + fixedPrizeAmount).toFixed(2))

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
        'roulette',
        Number(result?.insertId ?? 0),
        'roulette_spin_invite_reward',
        Number(oldBalance.toFixed(2)),
        newBalance,
        Number(fixedPrizeAmount.toFixed(2)),
        JSON.stringify({
          prizeLabel: selectedPrize,
          source: 'invite_level_1_reward',
        }),
      ]
    )

    await conn.commit()

    res.json({
      ok: true,
      spin: {
        id: Number(result?.insertId ?? 0),
        userId: parsedUserId,
        prizeLabel: selectedPrize,
        // prizeIndex = posição do segmento no array do banco (sort_order), mesmo usado pelo frontend
        prizeIndex: finalSegmentIndex,
        // centerAngle = ângulo do centro do segmento vencedor (0° = topo, sentido horário)
        centerAngle,
        segmentCount,
        createdAt: new Date().toISOString(),
      },
      rewardAmount: Number(fixedPrizeAmount.toFixed(2)),
      availableSpinsAfter: Math.max(availableSpins - 1, 0),
      balanceAfter: newBalance,
    })

    // Log do giro da roleta (fire-and-forget)
    sendTelegramLog(
      `🎰 <b>Giro da Roleta</b>\n` +
      `👤 Usuário ID: <code>${parsedUserId}</code>\n` +
      `🏆 Prêmio: <b>${selectedPrize}</b>\n` +
      `💰 Valor: R$ ${Number(fixedPrizeAmount.toFixed(2)).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}\n` +
      `💳 Saldo após: R$ ${Number(newBalance.toFixed(2)).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}\n` +
      `🎟️ Giros restantes: ${Math.max(availableSpins - 1, 0)}\n` +
      `📅 ${new Date().toLocaleString('pt-BR')}`
    ).catch(() => {})

  } catch (err) {
    await conn.rollback()
    console.error('[roleta-spin]', err)
    res.status(500).json({ ok: false, error: 'Erro ao registrar giro da roleta.' })
  } finally {
    conn.release()
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

// PUT /api/user/profile — usuário atualiza o próprio nome e senha
app.put('/api/user/profile', requireAuth, async (req: AuthenticatedRequest, res) => {
  const authId = Number(req.authUser?.id ?? 0)
  const { name, password } = req.body as { name?: string; password?: string }

  const parsedName = String(name ?? '').trim()
  if (!parsedName) {
    res.status(400).json({ ok: false, error: 'Nome é obrigatório.' })
    return
  }

  if (password !== undefined && password !== '' && String(password).length < 6) {
    res.status(400).json({ ok: false, error: 'A nova senha deve ter no mínimo 6 caracteres.' })
    return
  }

  try {
    if (password && String(password).trim().length >= 6) {
      const hash = await bcrypt.hash(String(password).trim(), 10)
      await pool.query('UPDATE users SET name = ?, password = ? WHERE id = ?', [parsedName, hash, authId])
    } else {
      await pool.query('UPDATE users SET name = ? WHERE id = ?', [parsedName, authId])
    }

    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT id, name, phone, email FROM users WHERE id = ? LIMIT 1',
      [authId]
    )
    const u = rows[0] ?? {}
    res.json({ ok: true, message: 'Perfil atualizado com sucesso.', user: { id: u.id, name: u.name, phone: u.phone, email: u.email } })
  } catch (err) {
    console.error('[user-profile-update]', err)
    res.status(500).json({ ok: false, error: 'Erro ao atualizar perfil.' })
  }
})

app.post('/api/withdraw/activation-token', requireAuth, async (req: AuthenticatedRequest, res) => {
  const { userId } = req.body as { userId?: number }
  const parsedUserId = Number(userId)

  if (!parsedUserId || Number.isNaN(parsedUserId)) {
    res.status(400).json({ ok: false, error: 'ID de usuário inválido.' })
    return
  }

  if (Number(req.authUser?.id ?? 0) !== parsedUserId) {
    res.status(403).json({ ok: false, error: 'Ação não permitida para este usuário.' })
    return
  }

  try {
    const token = await createWithdrawActivationToken(parsedUserId)
    res.json({
      ok: true,
      token,
      message: `Ative o saque para mim: ${token}`,
      expiresInMinutes: 30,
    })
  } catch (err) {
    console.error('[withdraw-activation-token]', err)
    res.status(500).json({ ok: false, error: 'Erro ao gerar token de ativação de saque.' })
  }
})

app.get('/api/withdraw/activation-status/:userId', requireAuth, async (req: AuthenticatedRequest, res) => {
  const parsedUserId = Number(req.params.userId)

  if (!parsedUserId || Number.isNaN(parsedUserId)) {
    res.status(400).json({ ok: false, error: 'ID de usuário inválido.' })
    return
  }

  if (Number(req.authUser?.id ?? 0) !== parsedUserId) {
    res.status(403).json({ ok: false, error: 'Ação não permitida para este usuário.' })
    return
  }

  try {
    await ensureWithdrawActivationTokensTable()

    const [rows] = await pool.query<RowDataPacket[]>(
      `
      SELECT
        id,
        activated_at AS activatedAt,
        DATE_ADD(activated_at, INTERVAL 24 HOUR) AS expiresAt
      FROM withdraw_activation_tokens
      WHERE user_id = ?
        AND status = 'activated'
        AND activated_at IS NOT NULL
        AND activated_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
      ORDER BY activated_at DESC, id DESC
      LIMIT 1
      `,
      [parsedUserId]
    )

    if (rows.length === 0) {
      res.json({
        ok: true,
        isActivated: false,
        activatedAt: null,
        expiresAt: null,
      })
      return
    }

    res.json({
      ok: true,
      isActivated: true,
      activatedAt: rows[0].activatedAt ?? null,
      expiresAt: rows[0].expiresAt ?? null,
    })
  } catch (err) {
    console.error('[withdraw-activation-status]', err)
    res.status(500).json({ ok: false, error: 'Erro ao consultar status de ativação de saque.' })
  }
})

app.post('/api/withdraw/request', async (req, res) => {
  // ── Segurança: rejeita body não-objeto ou ausente ──
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    res.status(400).json({ ok: false, error: 'Requisição inválida.' })
    return
  }

  const { userId, amount, withdrawPassword } = req.body as {
    userId?: unknown
    amount?: unknown
    withdrawPassword?: unknown
  }

  // ── Segurança: userId deve ser inteiro positivo ──
  const parsedUserId = Number(userId)
  if (!Number.isInteger(parsedUserId) || parsedUserId <= 0 || parsedUserId > 2_147_483_647) {
    res.status(400).json({ ok: false, error: 'ID de usuário inválido.' })
    return
  }

  // ── Segurança: amount deve ser string/número, sem scripts, max 12 chars ──
  const rawAmountStr = String(amount ?? '')
    .replace(/[^0-9.,]/g, '') // somente dígitos, vírgula e ponto
    .replace(',', '.')
    .slice(0, 12)

  const parsedAmount = Number(rawAmountStr)

  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    res.status(400).json({ ok: false, error: 'Informe um valor de saque válido.' })
    return
  }

  // ── Segurança: não mais que 2 casas decimais ──
  const decimalPart = rawAmountStr.split('.')[1] ?? ''
  if (decimalPart.length > 2) {
    res.status(400).json({ ok: false, error: 'Valor com no máximo 2 casas decimais.' })
    return
  }

  // ── Segurança: limite absoluto — nenhum saque acima de R$ 100.000 via API ──
  if (parsedAmount > 100_000) {
    res.status(400).json({ ok: false, error: 'Valor de saque excede o limite permitido.' })
    return
  }

  // ── Segurança: senha só aceita caracteres imprimíveis, sem controles ──
  const parsedPassword = String(withdrawPassword ?? '')
    .replace(/[\x00-\x1F\x7F]/g, '')
    .trim()

  if (!parsedPassword || parsedPassword.length < 6 || parsedPassword.length > 72) {
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

    await ensureWithdrawActivationTokensTable()

    const [activationRows] = await conn.query<RowDataPacket[]>(
      `
      SELECT id
      FROM withdraw_activation_tokens
      WHERE user_id = ?
        AND status = 'activated'
        AND activated_at IS NOT NULL
        AND activated_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
      ORDER BY activated_at DESC, id DESC
      LIMIT 1
      FOR UPDATE
      `,
      [parsedUserId]
    )

    if (activationRows.length === 0) {
      await conn.rollback()
      res.status(400).json({
        ok: false,
        error: 'Saque não ativado. Envie no grupo permitido: "Ative o saque para mim: TOKEN".',
      })
      return
    }

    const activationTokenId = Number(activationRows[0].id ?? 0)

    const [openWithdrawRows] = await conn.query<RowDataPacket[]>(
      `
      SELECT id
      FROM withdrawals
      WHERE user_id = ?
        AND LOWER(status) IN ('pending', 'processing')
      LIMIT 1
      FOR UPDATE
      `,
      [parsedUserId]
    )

    if (openWithdrawRows.length > 0) {
      await conn.rollback()
      res.status(400).json({ ok: false, error: 'Você já possui um saque em análise/processamento.' })
      return
    }

    const [todayPaidRows] = await conn.query<RowDataPacket[]>(
      `
      SELECT id
      FROM withdrawals
      WHERE user_id = ?
        AND DATE(created_at) = CURDATE()
        AND LOWER(status) IN ('paid', 'payment.paid')
      LIMIT 1
      FOR UPDATE
      `,
      [parsedUserId]
    )

    if (todayPaidRows.length > 0) {
      await conn.rollback()
      res.status(400).json({ ok: false, error: 'Você já realizou um saque pago hoje. Tente novamente amanhã.' })
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
      res.status(400).json({ ok: false, error: 'Saldo insuficiente para saque.' })
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
        withdraw_start_time CHAR(5) NOT NULL DEFAULT '00:00',
        withdraw_end_time CHAR(5) NOT NULL DEFAULT '23:59',
        withdraw_allowed_days VARCHAR(32) NOT NULL DEFAULT '0,1,2,3,4,5,6',
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

    try {
      await conn.query(
        `
        ALTER TABLE system_withdraw_config
        ADD COLUMN withdraw_start_time CHAR(5) NOT NULL DEFAULT '00:00'
        `
      )
    } catch {
      // coluna já existe
    }

    try {
      await conn.query(
        `
        ALTER TABLE system_withdraw_config
        ADD COLUMN withdraw_end_time CHAR(5) NOT NULL DEFAULT '23:59'
        `
      )
    } catch {
      // coluna já existe
    }

    try {
      await conn.query(
        `
        ALTER TABLE system_withdraw_config
        ADD COLUMN withdraw_allowed_days VARCHAR(32) NOT NULL DEFAULT '0,1,2,3,4,5,6'
        `
      )
    } catch {
      // coluna já existe
    }

    const [configRows] = await conn.query<RowDataPacket[]>(
      `
      SELECT
        withdraw_auto_approve AS withdrawAutoApprove,
        withdraw_fee_percent AS withdrawFeePercent,
        min_withdraw_amount AS minWithdrawAmount,
        max_withdraw_amount AS maxWithdrawAmount,
        withdraw_start_time AS withdrawStartTime,
        withdraw_end_time AS withdrawEndTime,
        withdraw_allowed_days AS withdrawAllowedDays
      FROM system_withdraw_config
      ORDER BY id ASC
      LIMIT 1
      `
    )

    const shouldAutoApprove = Number(configRows[0]?.withdrawAutoApprove ?? 0) === 1
    const withdrawFeePercentRaw = Number(configRows[0]?.withdrawFeePercent ?? 0)
    const minWithdrawAmount = Number(configRows[0]?.minWithdrawAmount ?? 0)
    const maxWithdrawAmount = Number(configRows[0]?.maxWithdrawAmount ?? 0)
    const withdrawStartTime = String(configRows[0]?.withdrawStartTime ?? '00:00').trim()
    const withdrawEndTime = String(configRows[0]?.withdrawEndTime ?? '23:59').trim()
    const allowedDaysSet = new Set(
      String(configRows[0]?.withdrawAllowedDays ?? '0,1,2,3,4,5,6')
        .split(',')
        .map((item) => Number(item.trim()))
        .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    )
    const withdrawFeePercent = Number.isFinite(withdrawFeePercentRaw)
      ? Math.max(0, withdrawFeePercentRaw)
      : 0

    // ── Segurança: valida min/max configurados no backend ──
    if (Number.isFinite(minWithdrawAmount) && minWithdrawAmount > 0 && parsedAmount < minWithdrawAmount) {
      await conn.rollback()
      res.status(400).json({
        ok: false,
        error: `O valor mínimo de saque é R$ ${minWithdrawAmount.toFixed(2).replace('.', ',')}.`,
      })
      return
    }

    if (Number.isFinite(maxWithdrawAmount) && maxWithdrawAmount > 0 && parsedAmount > maxWithdrawAmount) {
      await conn.rollback()
      res.status(400).json({
        ok: false,
        error: `O valor máximo de saque é R$ ${maxWithdrawAmount.toFixed(2).replace('.', ',')}.`,
      })
      return
    }

    const nowInSaoPaulo = new Date(
      new Date().toLocaleString('en-US', { timeZone: SAO_PAULO_TZ })
    )
    const currentWeekDay = nowInSaoPaulo.getDay()
    const currentMinutes = nowInSaoPaulo.getHours() * 60 + nowInSaoPaulo.getMinutes()

    const parseTimeToMinutes = (timeValue: string) => {
      const [hh, mm] = String(timeValue ?? '').split(':').map((v) => Number(v))
      if (!Number.isInteger(hh) || !Number.isInteger(mm)) return null
      if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null
      return hh * 60 + mm
    }

    const startMinutes = parseTimeToMinutes(withdrawStartTime)
    const endMinutes = parseTimeToMinutes(withdrawEndTime)

    if (
      startMinutes == null ||
      endMinutes == null ||
      !allowedDaysSet.has(currentWeekDay)
    ) {
      await conn.rollback()
      res.status(400).json({
        ok: false,
        error: 'Saque indisponível no momento conforme a configuração de dia/horário.',
      })
      return
    }

    const isWithinWindow =
      startMinutes <= endMinutes
        ? currentMinutes >= startMinutes && currentMinutes <= endMinutes
        : currentMinutes >= startMinutes || currentMinutes <= endMinutes

    if (!isWithinWindow) {
      await conn.rollback()
      res.status(400).json({
        ok: false,
        error: `Saque permitido apenas entre ${withdrawStartTime} e ${withdrawEndTime} (horário de São Paulo).`,
      })
      return
    }

    // ── Segurança: arredonda para 2 casas antes de qualquer cálculo monetário ──
    const safeAmount = Math.round(parsedAmount * 100) / 100

    const feeAmount = Math.round(safeAmount * (withdrawFeePercent / 100) * 100) / 100
    const netAmount = Math.round((safeAmount - feeAmount) * 100) / 100

    if (!Number.isFinite(netAmount) || netAmount <= 0) {
      await conn.rollback()
      res.status(400).json({
        ok: false,
        error: 'Valor líquido do saque inválido após taxa configurada.',
        requestedAmount: safeAmount,
        feePercent: withdrawFeePercent,
      })
      return
    }

    const oldBalance = Math.round(Number(currentBalance) * 100) / 100
    const newBalance = Math.round((oldBalance - safeAmount) * 100) / 100

    // ── Segurança: double-check saldo negativo após cálculo ──
    if (newBalance < 0) {
      await conn.rollback()
      res.status(400).json({ ok: false, error: 'Saldo insuficiente para saque.' })
      return
    }

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
        amount: netAmount,
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
        safeAmount,
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
        safeAmount,
        JSON.stringify({
          status: withdrawStatus,
          externalId,
          autoApprove: shouldAutoApprove,
          providerTransactionId,
          activationTokenId,
          requestedAmount: safeAmount,
          feePercent: withdrawFeePercent,
          feeAmount,
          netAmount,
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
        amount: safeAmount,
        feePercent: withdrawFeePercent,
        feeAmount,
        netAmount,
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

const ensureCycleProductsTable = async () => {
  await pool.query(
    `
    CREATE TABLE IF NOT EXISTS cycle_products (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      name VARCHAR(150) NOT NULL,
      description TEXT NULL,
      amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      profit DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      cycle_days INT NOT NULL DEFAULT 0,
      image_url VARCHAR(500) NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      sort_order INT NOT NULL DEFAULT 0,
      stock_quantity INT NOT NULL DEFAULT 0,
      expires_at DATETIME NULL,
      require_commission_level3_count INT NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_cycle_products_active (is_active),
      KEY idx_cycle_products_sort (sort_order)
    )
    `
  )

  const tryAlter = async (sql: string) => {
    try {
      await pool.query(sql)
    } catch {
      // coluna já existe / alteração não necessária
    }
  }

  await tryAlter(`
    ALTER TABLE cycle_products
    ADD COLUMN description TEXT NULL
  `)

  await tryAlter(`
    ALTER TABLE cycle_products
    ADD COLUMN image_url VARCHAR(500) NULL
  `)

  await tryAlter(`
    ALTER TABLE cycle_products
    ADD COLUMN sort_order INT NOT NULL DEFAULT 0
  `)

  await tryAlter(`
    ALTER TABLE cycle_products
    ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1
  `)

  await tryAlter(`
    ALTER TABLE cycle_products
    ADD COLUMN cycle_days INT NOT NULL DEFAULT 0
  `)

  await tryAlter(`
    ALTER TABLE cycle_products
    ADD COLUMN stock_quantity INT NOT NULL DEFAULT 0
  `)

  await tryAlter(`
    ALTER TABLE cycle_products
    ADD COLUMN expires_at DATETIME NULL
  `)

  await tryAlter(`
    ALTER TABLE cycle_products
    ADD COLUMN require_commission_level3_count INT NOT NULL DEFAULT 0
  `)

  await tryAlter(`
    ALTER TABLE cycle_products
    ADD COLUMN require_commission_level1_count INT NOT NULL DEFAULT 0
  `)

  await tryAlter(`
    ALTER TABLE cycle_products
    ADD COLUMN require_commission_level2_count INT NOT NULL DEFAULT 0
  `)

  // migra dados das colunas antigas (com underscore entre level e o número) para as novas
  await tryAlter(`
    UPDATE cycle_products
    SET require_commission_level1_count = COALESCE(require_commission_level_1_count, 0)
    WHERE require_commission_level1_count = 0 AND COALESCE(require_commission_level_1_count, 0) > 0
  `)

  await tryAlter(`
    UPDATE cycle_products
    SET require_commission_level2_count = COALESCE(require_commission_level_2_count, 0)
    WHERE require_commission_level2_count = 0 AND COALESCE(require_commission_level_2_count, 0) > 0
  `)

  await tryAlter(`
    UPDATE cycle_products
    SET require_commission_level3_count = COALESCE(require_commission_level_3_count, 0)
    WHERE require_commission_level3_count = 0 AND COALESCE(require_commission_level_3_count, 0) > 0
  `)

  await tryAlter(`
    ALTER TABLE cycle_products
    ADD COLUMN plan_type VARCHAR(20) NOT NULL DEFAULT 'normal'
  `)
}

type CommissionLevelRequirementInput = {
  commissionLevelId?: number | string
  requiredCount?: number | string
}

const normalizeCommissionLevelRequirementsInput = (value: unknown): Array<{ commissionLevelId: number; requiredCount: number }> => {
  if (!Array.isArray(value)) return []

  const normalized = value
    .map((item) => {
      const typed = (item ?? {}) as CommissionLevelRequirementInput
      const commissionLevelId = Number(typed.commissionLevelId)
      const requiredCount = Number(typed.requiredCount)

      if (!Number.isInteger(commissionLevelId) || commissionLevelId <= 0) return null
      if (!Number.isInteger(requiredCount) || requiredCount < 0) return null

      return { commissionLevelId, requiredCount }
    })
    .filter((item): item is { commissionLevelId: number; requiredCount: number } => Boolean(item))

  const dedupMap = new Map<number, number>()
  for (const item of normalized) {
    dedupMap.set(item.commissionLevelId, item.requiredCount)
  }

  return Array.from(dedupMap.entries()).map(([commissionLevelId, requiredCount]) => ({
    commissionLevelId,
    requiredCount,
  }))
}

const loadCycleProductRequirementsMap = async () => {
  const [rows] = await pool.query<RowDataPacket[]>(
    `
    SELECT
      cpr.cycle_product_id AS cycleProductId,
      cpr.commission_level_id AS commissionLevelId,
      cpr.required_count AS requiredCount,
      cl.level AS level,
      cl.name AS levelName
    FROM cycle_product_commission_requirements cpr
    INNER JOIN commission_levels cl ON cl.id = cpr.commission_level_id
    WHERE cl.is_active = 1
    ORDER BY cpr.cycle_product_id ASC, cl.level ASC, cpr.id ASC
    `
  )

  const requirementsMap = new Map<number, Array<{
    commissionLevelId: number
    level: number
    levelName: string
    requiredCount: number
  }>>()

  for (const row of rows) {
    const productId = Number(row.cycleProductId ?? 0)
    if (!productId) continue

    const list = requirementsMap.get(productId) ?? []
    list.push({
      commissionLevelId: Number(row.commissionLevelId ?? 0),
      level: Number(row.level ?? 0),
      levelName: String(row.levelName ?? ''),
      requiredCount: Number(row.requiredCount ?? 0),
    })
    requirementsMap.set(productId, list)
  }

  return requirementsMap
}

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

const ensureVipAndMiningTables = async () => {
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
}

const ensureCommissionLevelsTable = async () => {
  await pool.query(
    `
    CREATE TABLE IF NOT EXISTS commission_levels (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      level TINYINT UNSIGNED NOT NULL,
      name VARCHAR(60) NOT NULL,
      commission_percent DECIMAL(8,2) NOT NULL DEFAULT 0.00,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_commission_levels_level (level),
      KEY idx_commission_levels_active (is_active)
    )
    `
  )

  const [countRows] = await pool.query<RowDataPacket[]>(
    `
    SELECT COUNT(*) AS total
    FROM commission_levels
    `
  )

  const total = Number(countRows[0]?.total ?? 0)
  if (total === 0) {
    await pool.query(
      `
      INSERT INTO commission_levels (level, name, commission_percent, is_active)
      VALUES
        (1, 'Nível 1', 10.00, 1),
        (2, 'Nível 2', 3.00, 1),
        (3, 'Nível 3', 1.00, 1)
      `
    )
  }
}

const ensureCommissionPayoutsTable = async () => {
  await pool.query(
    `
    CREATE TABLE IF NOT EXISTS commission_payouts (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      cashin_payment_id BIGINT UNSIGNED NOT NULL,
      depositor_user_id BIGINT UNSIGNED NOT NULL,
      beneficiary_user_id BIGINT UNSIGNED NOT NULL,
      referral_level TINYINT UNSIGNED NOT NULL,
      commission_percent DECIMAL(8,2) NOT NULL DEFAULT 0.00,
      base_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      commission_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_commission_payout_unique (cashin_payment_id, beneficiary_user_id, referral_level),
      KEY idx_commission_payouts_depositor (depositor_user_id),
      KEY idx_commission_payouts_beneficiary (beneficiary_user_id)
    )
    `
  )
}

const ensureMonthlySalaryPlansTable = async () => {
  await pool.query(
    `
    CREATE TABLE IF NOT EXISTS monthly_salary_plans (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      title VARCHAR(150) NOT NULL,
      image_url VARCHAR(500) NULL,
      monthly_salary DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      required_level1_deposited INT NOT NULL DEFAULT 0,
      required_level2_deposited INT NOT NULL DEFAULT 0,
      required_level3_deposited INT NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      sort_order INT NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_monthly_salary_plans_active (is_active),
      KEY idx_monthly_salary_plans_sort (sort_order)
    )
    `
  )

  const tryAlter = async (sql: string) => {
    try {
      await pool.query(sql)
    } catch {
      // coluna/índice já existe ou não precisa alterar
    }
  }

  await tryAlter(`
    ALTER TABLE monthly_salary_plans
    ADD COLUMN image_url VARCHAR(500) NULL
  `)

  await tryAlter(`
    ALTER TABLE monthly_salary_plans
    ADD COLUMN monthly_salary DECIMAL(12,2) NOT NULL DEFAULT 0.00
  `)

  await tryAlter(`
    ALTER TABLE monthly_salary_plans
    ADD COLUMN required_level1_deposited INT NOT NULL DEFAULT 0
  `)

  await tryAlter(`
    ALTER TABLE monthly_salary_plans
    ADD COLUMN required_level2_deposited INT NOT NULL DEFAULT 0
  `)

  await tryAlter(`
    ALTER TABLE monthly_salary_plans
    ADD COLUMN required_level3_deposited INT NOT NULL DEFAULT 0
  `)

  await tryAlter(`
    ALTER TABLE monthly_salary_plans
    ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1
  `)

  await tryAlter(`
    ALTER TABLE monthly_salary_plans
    ADD COLUMN sort_order INT NOT NULL DEFAULT 0
  `)

  await tryAlter(`
    ALTER TABLE monthly_salary_plans
    ADD COLUMN created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  `)

  await tryAlter(`
    ALTER TABLE monthly_salary_plans
    ADD COLUMN updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  `)

  await tryAlter(`
    ALTER TABLE monthly_salary_plans
    ADD KEY idx_monthly_salary_plans_active (is_active)
  `)

  await tryAlter(`
    ALTER TABLE monthly_salary_plans
    ADD KEY idx_monthly_salary_plans_sort (sort_order)
  `)

  const [countRows] = await pool.query<RowDataPacket[]>(
    `
    SELECT COUNT(*) AS total
    FROM monthly_salary_plans
    `
  )

  const total = Number(countRows[0]?.total ?? 0)
  if (total === 0) {
    await pool.query(
      `
      INSERT INTO monthly_salary_plans
      (
        title,
        monthly_salary,
        required_level1_deposited,
        required_level2_deposited,
        required_level3_deposited,
        is_active,
        sort_order
      )
      VALUES
      ('Start V1', 100.00, 100, 0, 0, 1, 1)
      `
    )
  }
}

const applyReferralCommissionsForDeposit = async (cashinPaymentId: number, depositorUserId: number, depositAmount: number) => {
  const parsedPaymentId = Number(cashinPaymentId)
  const parsedDepositorUserId = Number(depositorUserId)
  const parsedDepositAmount = Number(depositAmount)

  if (!parsedPaymentId || Number.isNaN(parsedPaymentId)) return
  if (!parsedDepositorUserId || Number.isNaN(parsedDepositorUserId)) return
  if (!Number.isFinite(parsedDepositAmount) || parsedDepositAmount <= 0) return

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    await ensureCommissionLevelsTable()
    await ensureCommissionPayoutsTable()

    const [levelRows] = await conn.query<RowDataPacket[]>(
      `
      SELECT
        level,
        commission_percent AS commissionPercent,
        is_active AS isActive
      FROM commission_levels
      WHERE level BETWEEN 1 AND 3
      ORDER BY level ASC
      `
    )

    const activeLevels = levelRows
      .map((row) => ({
        level: Number(row.level ?? 0),
        commissionPercent: Number(row.commissionPercent ?? 0),
        isActive: Number(row.isActive ?? 0) === 1,
      }))
      .filter((item) => item.isActive && item.level >= 1 && item.level <= 3 && item.commissionPercent > 0)

    if (activeLevels.length === 0) {
      await conn.commit()
      return
    }

    let currentUserId = parsedDepositorUserId

    for (let level = 1; level <= 3; level += 1) {
      const [uplineRows] = await conn.query<RowDataPacket[]>(
        `
        SELECT referred_by_user_id AS referredByUserId
        FROM users
        WHERE id = ?
        LIMIT 1
        FOR UPDATE
        `,
        [currentUserId]
      )

      if (uplineRows.length === 0) break

      const parentUserId = Number(uplineRows[0].referredByUserId ?? 0)
      if (!parentUserId || Number.isNaN(parentUserId)) break

      const levelConfig = activeLevels.find((item) => item.level === level)
      if (levelConfig) {
        const commissionAmount = Number((parsedDepositAmount * (levelConfig.commissionPercent / 100)).toFixed(2))
        if (commissionAmount > 0) {
          const [existingPayoutRows] = await conn.query<RowDataPacket[]>(
            `
            SELECT id
            FROM commission_payouts
            WHERE cashin_payment_id = ?
              AND beneficiary_user_id = ?
              AND referral_level = ?
            LIMIT 1
            FOR UPDATE
            `,
            [parsedPaymentId, parentUserId, level]
          )

          if (existingPayoutRows.length === 0) {
            await conn.query(
              `
              INSERT INTO commission_payouts
              (
                cashin_payment_id,
                depositor_user_id,
                beneficiary_user_id,
                referral_level,
                commission_percent,
                base_amount,
                commission_amount
              )
              VALUES (?, ?, ?, ?, ?, ?, ?)
              `,
              [
                parsedPaymentId,
                parsedDepositorUserId,
                parentUserId,
                level,
                Number(levelConfig.commissionPercent.toFixed(2)),
                Number(parsedDepositAmount.toFixed(2)),
                commissionAmount,
              ]
            )

            await conn.query(
              `
              UPDATE users
              SET balance = COALESCE(balance, 0) + ?
              WHERE id = ?
              `,
              [commissionAmount, parentUserId]
            )

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
                parentUserId,
                'commission',
                parsedPaymentId,
                'commission_credit',
                commissionAmount,
                JSON.stringify({
                  cashinPaymentId: parsedPaymentId,
                  depositorUserId: parsedDepositorUserId,
                  beneficiaryUserId: parentUserId,
                  level,
                  commissionPercent: Number(levelConfig.commissionPercent.toFixed(2)),
                  baseAmount: Number(parsedDepositAmount.toFixed(2)),
                }),
              ]
            )
          }
        }
      }

      currentUserId = parentUserId
    }

    await conn.commit()
  } catch (err) {
    await conn.rollback()
    throw err
  } finally {
    conn.release()
  }
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

app.get('/api/referral/commission-levels/debug', async (req, res) => {
  const debugRequestInfo = {
    method: req.method,
    originalUrl: req.originalUrl,
    path: req.path,
    query: req.query,
    params: req.params,
    ip: req.ip,
    forwardedFor: req.headers['x-forwarded-for'],
    userAgent: req.headers['user-agent'],
  }

  try {
    await ensureCommissionLevelsTable()

    const [rows] = await pool.query<RowDataPacket[]>(
      `
      SELECT
        id,
        level,
        name,
        commission_percent AS commissionPercent,
        is_active AS isActive,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM commission_levels
      ORDER BY level ASC, id ASC
      `
    )

    res.json({
      ok: true,
      debug: true,
      database: {
        dbName: DB_NAME,
        dbHost: DB_HOST,
        dbPort: DB_PORT,
      },
      request: debugRequestInfo,
      totalLevels: rows.length,
      rawLevels: rows,
    })
  } catch (err) {
    console.error('[referral-commission-levels-debug-get]', {
      error: err,
      request: debugRequestInfo,
      dbName: DB_NAME,
      dbHost: DB_HOST,
      dbPort: DB_PORT,
    })
    res.status(500).json({
      ok: false,
      error: 'Erro ao carregar debug dos níveis de comissão.',
      database: {
        dbName: DB_NAME,
        dbHost: DB_HOST,
        dbPort: DB_PORT,
      },
    })
  }
})

app.get('/api/referral/commission-levels', async (req, res) => {
  const debugRequestInfo = {
    method: req.method,
    originalUrl: req.originalUrl,
    path: req.path,
    query: req.query,
    params: req.params,
    ip: req.ip,
    forwardedFor: req.headers['x-forwarded-for'],
    userAgent: req.headers['user-agent'],
  }

  console.info('[referral-commission-levels-request]', debugRequestInfo)

  try {
    await ensureCommissionLevelsTable()

    const [rows] = await pool.query<RowDataPacket[]>(
      `
      SELECT
        id,
        level,
        name,
        commission_percent AS commissionPercent,
        is_active AS isActive
      FROM commission_levels
      WHERE is_active = 1
      ORDER BY level ASC, id ASC
      `
    )

    const levels = rows.map((row) => ({
      id: Number(row.id),
      level: Number(row.level ?? 0),
      name: String(row.name ?? ''),
      commissionPercent: Number(row.commissionPercent ?? 0),
      isActive: Number(row.isActive ?? 1) === 1,
    }))

    console.info('[referral-commission-levels-response]', {
      ok: true,
      totalLevels: levels.length,
      levelsPreview: levels.slice(0, 3),
      requestPath: req.path,
      requestOriginalUrl: req.originalUrl,
    })

    res.json({ ok: true, levels })
  } catch (err) {
    console.error('[referral-commission-levels-get]', {
      error: err,
      request: debugRequestInfo,
    })
    res.status(500).json({ ok: false, error: 'Erro ao carregar níveis de comissão.' })
  }
})

app.get('/api/admin/commission-levels', requireMaxAdmin, async (_req, res) => {
  try {
    await ensureCommissionLevelsTable()

    const [rows] = await pool.query<RowDataPacket[]>(
      `
      SELECT
        id,
        level,
        name,
        commission_percent AS commissionPercent,
        is_active AS isActive,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM commission_levels
      ORDER BY level ASC, id ASC
      `
    )

    const levels = rows.map((row) => ({
      id: Number(row.id),
      level: Number(row.level ?? 0),
      name: String(row.name ?? ''),
      commissionPercent: Number(row.commissionPercent ?? 0),
      isActive: Number(row.isActive ?? 1) === 1,
      createdAt: row.createdAt ?? null,
      updatedAt: row.updatedAt ?? null,
    }))

    res.json({ ok: true, levels })
  } catch (err) {
    console.error('[admin-commission-levels-get]', err)
    res.status(500).json({ ok: false, error: 'Erro ao carregar níveis de comissão.' })
  }
})

app.post('/api/admin/commission-levels', requireMaxAdmin, async (req, res) => {
  const { levels } = req.body as {
    levels?: Array<{
      id?: number
      level?: number | string
      name?: string
      commissionPercent?: number | string
      isActive?: boolean | number | string
    }>
  }

  if (!Array.isArray(levels) || levels.length === 0) {
    res.status(400).json({ ok: false, error: 'Informe ao menos um nível de comissão.' })
    return
  }

  const normalized = levels.map((item) => {
    const parsedLevel = Number(item?.level)
    const parsedName = String(item?.name ?? '').trim()
    const parsedCommissionPercent = Number(String(item?.commissionPercent ?? 0).replace(',', '.'))
    const parsedIsActive =
      item?.isActive === true ||
      item?.isActive === 1 ||
      String(item?.isActive ?? '').toLowerCase() === 'true'
        ? 1
        : 0

    return {
      id: item?.id == null ? null : Number(item.id),
      level: parsedLevel,
      name: parsedName,
      commissionPercent: Number(parsedCommissionPercent.toFixed(2)),
      isActive: parsedIsActive,
    }
  })

  const hasInvalid = normalized.some((item) =>
    !Number.isInteger(item.level) ||
    item.level <= 0 ||
    !item.name ||
    !Number.isFinite(item.commissionPercent) ||
    item.commissionPercent < 0 ||
    item.commissionPercent > 100
  )

  if (hasInvalid) {
    res.status(400).json({
      ok: false,
      error: 'Dados inválidos. Nível deve ser inteiro positivo e comissão entre 0 e 100.',
    })
    return
  }

  const uniqueLevels = new Set(normalized.map((item) => item.level))
  if (uniqueLevels.size !== normalized.length) {
    res.status(400).json({ ok: false, error: 'Existem níveis duplicados no envio.' })
    return
  }

  const conn = await pool.getConnection()
  try {
    await ensureCommissionLevelsTable()
    await conn.beginTransaction()

    await conn.query('DELETE FROM commission_levels')

    for (const item of normalized.sort((a, b) => a.level - b.level)) {
      await conn.query(
        `
        INSERT INTO commission_levels (level, name, commission_percent, is_active)
        VALUES (?, ?, ?, ?)
        `,
        [item.level, item.name, item.commissionPercent, item.isActive]
      )
    }

    await conn.commit()

    const [rows] = await pool.query<RowDataPacket[]>(
      `
      SELECT
        id,
        level,
        name,
        commission_percent AS commissionPercent,
        is_active AS isActive,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM commission_levels
      ORDER BY level ASC, id ASC
      `
    )

    const persistedLevels = rows.map((row) => ({
      id: Number(row.id),
      level: Number(row.level ?? 0),
      name: String(row.name ?? ''),
      commissionPercent: Number(row.commissionPercent ?? 0),
      isActive: Number(row.isActive ?? 1) === 1,
      createdAt: row.createdAt ?? null,
      updatedAt: row.updatedAt ?? null,
    }))

    res.json({
      ok: true,
      message: 'Níveis de comissão salvos com sucesso.',
      levels: persistedLevels,
    })
  } catch (err) {
    await conn.rollback()
    console.error('[admin-commission-levels-save]', err)
    res.status(500).json({ ok: false, error: 'Erro ao salvar níveis de comissão.' })
  } finally {
    conn.release()
  }
})

app.get('/api/admin/deposit-config', requireMaxAdmin, async (_req, res) => {
  try {
    await pool.query(
      `
      CREATE TABLE IF NOT EXISTS system_deposit_config (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        min_deposit_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        max_deposit_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        deposit_enabled TINYINT(1) NOT NULL DEFAULT 1,
        quick_preset_values VARCHAR(255) NOT NULL DEFAULT '20,50,100,200,500',
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id)
      )
      `
    )

    await pool.query(
      `
      CREATE TABLE IF NOT EXISTS system_deposit_quick_presets (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        preset_order INT NOT NULL DEFAULT 0,
        value DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_system_deposit_quick_presets_order (preset_order),
        KEY idx_system_deposit_quick_presets_active (is_active)
      )
      `
    )

    try {
      await pool.query(
        `
        ALTER TABLE system_deposit_config
        ADD COLUMN quick_preset_values VARCHAR(255) NOT NULL DEFAULT '20,50,100,200,500'
        `
      )
    } catch {
      // coluna já existe
    }

    await pool.query(
      `
      UPDATE system_deposit_config
      SET quick_preset_values = '20,50,100,200,500'
      WHERE quick_preset_values IS NULL OR TRIM(quick_preset_values) = ''
      `
    )

    const [legacyConfigRows] = await pool.query<RowDataPacket[]>(
      `
      SELECT quick_preset_values AS quickPresetValues
      FROM system_deposit_config
      ORDER BY id ASC
      LIMIT 1
      `
    )

    const [presetCountRows] = await pool.query<RowDataPacket[]>(
      `
      SELECT COUNT(*) AS total
      FROM system_deposit_quick_presets
      WHERE is_active = 1
      `
    )

    const activePresetCount = Number(presetCountRows[0]?.total ?? 0)
    if (activePresetCount === 0) {
      const legacyValuesRaw = String(legacyConfigRows[0]?.quickPresetValues ?? '20,50,100,200,500')
      const values = legacyValuesRaw
        .split(',')
        .map((item) => Number(String(item).trim().replace(',', '.')))
        .filter((value) => Number.isFinite(value) && value > 0)
        .map((value) => Number(value.toFixed(2)))

      const presetsToInsert = values.length > 0 ? values : [20, 50, 100, 200, 500]

      await pool.query('DELETE FROM system_deposit_quick_presets')
      for (let i = 0; i < presetsToInsert.length; i += 1) {
        await pool.query(
          `
          INSERT INTO system_deposit_quick_presets
            (preset_order, value, is_active)
          VALUES (?, ?, 1)
          `,
          [i + 1, Number(presetsToInsert[i].toFixed(2))]
        )
      }
    }

    const [rows] = await pool.query<RowDataPacket[]>(
      `
      SELECT
        min_deposit_amount AS minDepositAmount,
        max_deposit_amount AS maxDepositAmount,
        deposit_enabled AS depositEnabled
      FROM system_deposit_config
      ORDER BY id ASC
      LIMIT 1
      `
    )

    if (rows.length === 0) {
      await pool.query(
        `
        INSERT INTO system_deposit_config
          (min_deposit_amount, max_deposit_amount, deposit_enabled, quick_preset_values)
        VALUES (0.00, 0.00, 1, '20,50,100,200,500')
        `
      )

      const [presetRowsOnEmpty] = await pool.query<RowDataPacket[]>(
        `
        SELECT value
        FROM system_deposit_quick_presets
        WHERE is_active = 1
        ORDER BY preset_order ASC, id ASC
        `
      )

      const presetValuesOnEmpty = presetRowsOnEmpty
        .map((row) => Number(row.value ?? 0))
        .filter((value) => Number.isFinite(value) && value > 0)
        .map((value) => Number(value.toFixed(2)))

      res.json({
        ok: true,
        config: {
          minDepositAmount: 0,
          maxDepositAmount: 0,
          depositEnabled: true,
          quickPresetValues: presetValuesOnEmpty.length > 0 ? presetValuesOnEmpty : [20, 50, 100, 200, 500],
        },
      })
      return
    }

    const [presetRows] = await pool.query<RowDataPacket[]>(
      `
      SELECT value
      FROM system_deposit_quick_presets
      WHERE is_active = 1
      ORDER BY preset_order ASC, id ASC
      `
    )

    const quickPresetValues = presetRows
      .map((row) => Number(row.value ?? 0))
      .filter((value) => Number.isFinite(value) && value > 0)
      .map((value) => Number(value.toFixed(2)))

    const row = rows[0]

    res.json({
      ok: true,
      config: {
        minDepositAmount: Number(row.minDepositAmount ?? 0),
        maxDepositAmount: Number(row.maxDepositAmount ?? 0),
        depositEnabled: Number(row.depositEnabled ?? 1) === 1,
        quickPresetValues: quickPresetValues.length > 0 ? quickPresetValues : [20, 50, 100, 200, 500],
      },
    })
  } catch (err) {
    console.error('[admin-deposit-config-get]', err)
    res.status(500).json({ ok: false, error: 'Erro ao carregar configurações de depósito.' })
  }
})

app.post('/api/admin/deposit-config', requireMaxAdmin, async (req, res) => {
  const { minDepositAmount, maxDepositAmount, depositEnabled, quickPresetValues } = req.body as {
    minDepositAmount?: number | string
    maxDepositAmount?: number | string
    depositEnabled?: boolean | number | string
    quickPresetValues?: Array<number | string> | string
  }

  const min = Number(String(minDepositAmount ?? 0).replace(',', '.'))
  const max = Number(String(maxDepositAmount ?? 0).replace(',', '.'))
  const enabled =
    depositEnabled === true ||
    depositEnabled === 1 ||
    String(depositEnabled ?? '').toLowerCase() === 'true'
      ? 1
      : 0

  if (!Number.isFinite(min) || min < 0) {
    res.status(400).json({ ok: false, error: 'Valor mínimo de depósito inválido.' })
    return
  }

  if (!Number.isFinite(max) || max < 0) {
    res.status(400).json({ ok: false, error: 'Valor máximo de depósito inválido.' })
    return
  }

  if (max > 0 && min > max) {
    res.status(400).json({ ok: false, error: 'Valor mínimo não pode ser maior que o máximo.' })
    return
  }

  const parsedQuickPresetValues = Array.isArray(quickPresetValues)
    ? quickPresetValues
    : String(quickPresetValues ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)

  const normalizedQuickPresetValues = parsedQuickPresetValues
    .map((item) => Number(String(item).replace(',', '.')))
    .filter((value) => Number.isFinite(value) && value > 0)
    .map((value) => Number(value.toFixed(2)))

  if (normalizedQuickPresetValues.length === 0) {
    res.status(400).json({ ok: false, error: 'Informe ao menos um valor pré-selecionado válido.' })
    return
  }

  try {
    await pool.query(
      `
      CREATE TABLE IF NOT EXISTS system_deposit_config (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        min_deposit_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        max_deposit_amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        deposit_enabled TINYINT(1) NOT NULL DEFAULT 1,
        quick_preset_values VARCHAR(255) NOT NULL DEFAULT '20,50,100,200,500',
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id)
      )
      `
    )

    await pool.query(
      `
      CREATE TABLE IF NOT EXISTS system_deposit_quick_presets (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        preset_order INT NOT NULL DEFAULT 0,
        value DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_system_deposit_quick_presets_order (preset_order),
        KEY idx_system_deposit_quick_presets_active (is_active)
      )
      `
    )

    try {
      await pool.query(
        `
        ALTER TABLE system_deposit_config
        ADD COLUMN quick_preset_values VARCHAR(255) NOT NULL DEFAULT '20,50,100,200,500'
        `
      )
    } catch {
      // coluna já existe
    }

    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM system_deposit_config ORDER BY id ASC LIMIT 1'
    )

    const normalizedMin = Number(min.toFixed(2))
    const normalizedMax = Number(max.toFixed(2))

    const quickPresetValuesString = normalizedQuickPresetValues.join(',')

    if (rows.length === 0) {
      await pool.query(
        `
        INSERT INTO system_deposit_config
          (min_deposit_amount, max_deposit_amount, deposit_enabled, quick_preset_values)
        VALUES (?, ?, ?, ?)
        `,
        [normalizedMin, normalizedMax, enabled, quickPresetValuesString]
      )
    } else {
      await pool.query(
        `
        UPDATE system_deposit_config
        SET
          min_deposit_amount = ?,
          max_deposit_amount = ?,
          deposit_enabled = ?,
          quick_preset_values = ?,
          updated_at = NOW()
        WHERE id = ?
        `,
        [normalizedMin, normalizedMax, enabled, quickPresetValuesString, Number(rows[0].id)]
      )
    }

    await pool.query('DELETE FROM system_deposit_quick_presets')
    for (let i = 0; i < normalizedQuickPresetValues.length; i += 1) {
      await pool.query(
        `
        INSERT INTO system_deposit_quick_presets
          (preset_order, value, is_active)
        VALUES (?, ?, 1)
        `,
        [i + 1, Number(normalizedQuickPresetValues[i].toFixed(2))]
      )
    }

    res.json({
      ok: true,
      message: 'Configurações de depósito salvas com sucesso.',
      config: {
        minDepositAmount: normalizedMin,
        maxDepositAmount: normalizedMax,
        depositEnabled: enabled === 1,
        quickPresetValues: normalizedQuickPresetValues,
      },
    })
  } catch (err) {
    console.error('[admin-deposit-config-save]', err)
    res.status(500).json({ ok: false, error: 'Erro ao salvar configurações de depósito.' })
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

    try {
      await pool.query(
        `
        ALTER TABLE system_withdraw_config
        ADD COLUMN withdraw_start_time CHAR(5) NOT NULL DEFAULT '00:00'
        `
      )
    } catch {
      // coluna já existe
    }

    try {
      await pool.query(
        `
        ALTER TABLE system_withdraw_config
        ADD COLUMN withdraw_end_time CHAR(5) NOT NULL DEFAULT '23:59'
        `
      )
    } catch {
      // coluna já existe
    }

    try {
      await pool.query(
        `
        ALTER TABLE system_withdraw_config
        ADD COLUMN withdraw_allowed_days VARCHAR(32) NOT NULL DEFAULT '0,1,2,3,4,5,6'
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
        withdraw_auto_approve AS withdrawAutoApprove,
        withdraw_start_time AS withdrawStartTime,
        withdraw_end_time AS withdrawEndTime,
        withdraw_allowed_days AS withdrawAllowedDays
      FROM system_withdraw_config
      ORDER BY id ASC
      LIMIT 1
      `
    )

    if (rows.length === 0) {
      await pool.query(
        `
        INSERT INTO system_withdraw_config
          (
            withdraw_fee_percent,
            min_withdraw_amount,
            max_withdraw_amount,
            withdraw_auto_approve,
            withdraw_start_time,
            withdraw_end_time,
            withdraw_allowed_days
          )
        VALUES (0.00, 0.00, 0.00, 0, '00:00', '23:59', '0,1,2,3,4,5,6')
        `
      )

      res.json({
        ok: true,
        config: {
          withdrawFeePercent: 0,
          minWithdrawAmount: 0,
          maxWithdrawAmount: 0,
          withdrawAutoApprove: false,
          withdrawStartTime: '00:00',
          withdrawEndTime: '23:59',
          withdrawAllowedDays: '0,1,2,3,4,5,6',
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
        withdrawStartTime: String(row.withdrawStartTime ?? '00:00'),
        withdrawEndTime: String(row.withdrawEndTime ?? '23:59'),
        withdrawAllowedDays: String(row.withdrawAllowedDays ?? '0,1,2,3,4,5,6'),
      },
    })
  } catch (err) {
    console.error('[admin-withdraw-config-get]', err)
    res.status(500).json({ ok: false, error: 'Erro ao carregar configurações de saque.' })
  }
})

app.post('/api/admin/withdraw-config', requireMaxAdmin, async (req, res) => {
  const { withdrawFeePercent, minWithdrawAmount, maxWithdrawAmount, withdrawAutoApprove, withdrawStartTime, withdrawEndTime, withdrawAllowedDays } = req.body as {
    withdrawFeePercent?: number | string
    minWithdrawAmount?: number | string
    maxWithdrawAmount?: number | string
    withdrawAutoApprove?: boolean | number | string
    withdrawStartTime?: string
    withdrawEndTime?: string
    withdrawAllowedDays?: string
  }

  const fee = Number(String(withdrawFeePercent ?? 0).replace(',', '.'))
  const min = Number(String(minWithdrawAmount ?? 0).replace(',', '.'))
  const max = Number(String(maxWithdrawAmount ?? 0).replace(',', '.'))
  const start = String(withdrawStartTime ?? '00:00').trim()
  const end = String(withdrawEndTime ?? '23:59').trim()
  const allowedDays = String(withdrawAllowedDays ?? '0,1,2,3,4,5,6')
    .split(',')
    .map((day) => Number(day.trim()))
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
  const normalizedAllowedDays = [...new Set(allowedDays)].sort((a, b) => a - b).join(',')
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

  const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)$/
  if (!timeRegex.test(start) || !timeRegex.test(end)) {
    res.status(400).json({ ok: false, error: 'Horário inválido. Use o formato HH:MM.' })
    return
  }

  if (!normalizedAllowedDays) {
    res.status(400).json({ ok: false, error: 'Selecione ao menos um dia permitido para saque.' })
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

    try {
      await pool.query(
        `
        ALTER TABLE system_withdraw_config
        ADD COLUMN withdraw_start_time CHAR(5) NOT NULL DEFAULT '00:00'
        `
      )
    } catch {
      // coluna já existe
    }

    try {
      await pool.query(
        `
        ALTER TABLE system_withdraw_config
        ADD COLUMN withdraw_end_time CHAR(5) NOT NULL DEFAULT '23:59'
        `
      )
    } catch {
      // coluna já existe
    }

    try {
      await pool.query(
        `
        ALTER TABLE system_withdraw_config
        ADD COLUMN withdraw_allowed_days VARCHAR(32) NOT NULL DEFAULT '0,1,2,3,4,5,6'
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
          (
            withdraw_fee_percent,
            min_withdraw_amount,
            max_withdraw_amount,
            withdraw_auto_approve,
            withdraw_start_time,
            withdraw_end_time,
            withdraw_allowed_days
          )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        [normalizedFee, normalizedMin, normalizedMax, autoApprove, start, end, normalizedAllowedDays]
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
          withdraw_start_time = ?,
          withdraw_end_time = ?,
          withdraw_allowed_days = ?,
          updated_at = NOW()
        WHERE id = ?
        `,
        [normalizedFee, normalizedMin, normalizedMax, autoApprove, start, end, normalizedAllowedDays, Number(rows[0].id)]
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
        withdrawStartTime: start,
        withdrawEndTime: end,
        withdrawAllowedDays: normalizedAllowedDays,
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
      await pool.query(`ALTER TABLE site_settings ADD COLUMN site_logo_url VARCHAR(500) NULL`)
    } catch { /* coluna já existe */ }
    try {
      await pool.query(`ALTER TABLE site_settings ADD COLUMN telegram_group_link VARCHAR(500) NULL`)
    } catch { /* coluna já existe */ }

    const [rows] = await pool.query<RowDataPacket[]>(
      `
      SELECT
        site_title AS siteTitle,
        site_description AS siteDescription,
        COALESCE(site_logo_url, '') AS siteLogoUrl,
        COALESCE(telegram_group_link, '') AS telegramGroupLink,
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
          telegramGroupLink: '',
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
        telegramGroupLink: String(rows[0].telegramGroupLink ?? ''),
        updatedAt: rows[0].updatedAt ?? null,
      },
    })
  } catch (err) {
    console.error('[site-settings-get-public]', err)
    res.status(500).json({ ok: false, error: 'Erro ao carregar configurações públicas do site.' })
  }
})

app.get('/api/telegram/connection-status/:userId', requireAuth, async (req: AuthenticatedRequest, res) => {
  const userId = Number(req.params.userId)

  if (!userId || Number.isNaN(userId)) {
    res.status(400).json({ ok: false, error: 'ID de usuário inválido.' })
    return
  }

  if (Number(req.authUser?.id ?? 0) !== userId && !Boolean(req.authUser?.isAdmin)) {
    res.status(403).json({ ok: false, error: 'Acesso negado.' })
    return
  }

  try {
    await ensureUserTelegramConnectionsTable()

    const [rows] = await pool.query<RowDataPacket[]>(
      `
      SELECT
        user_id AS userId,
        phone,
        telegram_chat_id AS telegramChatId,
        telegram_user_id AS telegramUserId,
        telegram_username AS telegramUsername,
        telegram_first_name AS telegramFirstName,
        is_connected AS isConnected,
        connected_at AS connectedAt,
        updated_at AS updatedAt
      FROM user_telegram_connections
      WHERE user_id = ?
      LIMIT 1
      `,
      [userId]
    )

    if (rows.length === 0) {
      res.json({
        ok: true,
        connected: false,
        connection: null,
      })
      return
    }

    res.json({
      ok: true,
      connected: Number(rows[0].isConnected ?? 0) === 1,
      connection: {
        userId: Number(rows[0].userId),
        phone: String(rows[0].phone ?? ''),
        telegramChatId: String(rows[0].telegramChatId ?? ''),
        telegramUserId: String(rows[0].telegramUserId ?? ''),
        telegramUsername: rows[0].telegramUsername ? String(rows[0].telegramUsername) : null,
        telegramFirstName: rows[0].telegramFirstName ? String(rows[0].telegramFirstName) : null,
        connectedAt: rows[0].connectedAt ?? null,
        updatedAt: rows[0].updatedAt ?? null,
      },
    })
  } catch (err) {
    console.error('[telegram-connection-status]', err)
    res.status(500).json({ ok: false, error: 'Erro ao carregar status de conexão do Telegram.' })
  }
})

app.get('/api/admin/telegram-config/diagnostic', requireMaxAdmin, async (_req, res) => {
  try {
    await ensureDatabaseExists()
    await ensureTelegramConfigTable()

    const [tableRows] = await pool.query<RowDataPacket[]>(
      `
      SELECT COUNT(*) AS total
      FROM information_schema.tables
      WHERE table_schema = DATABASE()
        AND table_name = 'system_telegram_config'
      `
    )

    const [countRows] = await pool.query<RowDataPacket[]>(
      `
      SELECT COUNT(*) AS total
      FROM system_telegram_config
      `
    )

    res.json({
      ok: true,
      diagnostic: {
        dbHost: DB_HOST,
        dbPort: DB_PORT,
        dbName: DB_NAME,
        tableExists: Number(tableRows[0]?.total ?? 0) > 0,
        rowsInSystemTelegramConfig: Number(countRows[0]?.total ?? 0),
      },
    })
  } catch (err) {
    console.error('[admin-telegram-config-diagnostic]', err)
    res.status(500).json({
      ok: false,
      error: 'Erro ao executar diagnóstico de configuração Telegram.',
      diagnostic: {
        dbHost: DB_HOST,
        dbPort: DB_PORT,
        dbName: DB_NAME,
      },
    })
  }
})

app.get('/api/admin/telegram-config', requireMaxAdmin, async (_req, res) => {
  try {
    await ensureTelegramConfigTable()

    const [rows] = await pool.query<RowDataPacket[]>(
      `
      SELECT
        bot_token AS botToken,
        group_id AS groupId,
        logs_group_id AS logsGroupId,
        welcome_message AS welcomeMessage,
        private_chat_only_message AS privateChatOnlyMessage,
        private_link_success_message AS privateLinkSuccessMessage,
        duplicate_connection_message AS alreadyLinkedMessage,
        checkin_success_message AS checkinSuccessMessage,
        checkin_already_claimed_message AS checkinAlreadyClaimedMessage,
        updated_at AS updatedAt
      FROM system_telegram_config
      ORDER BY id ASC
      LIMIT 1
      `
    )

    if (rows.length === 0) {
      res.json({
        ok: true,
        config: {
          botToken: '',
          groupId: '',
          logsGroupId: '',
          welcomeMessage: '',
          privateChatOnlyMessage: 'Conexão permitida somente no chat privado do bot.',
          privateLinkSuccessMessage: 'Conta conectada com sucesso.',
          alreadyLinkedMessage: 'Esta conta já foi conectada anteriormente e não pode ser vinculada novamente.',
          checkinSuccessMessage: 'Check-in do dia {day} resgatado com sucesso!',
          checkinAlreadyClaimedMessage: 'Check-in de hoje já foi resgatado.',
          updatedAt: null,
        },
      })
      return
    }

    res.json({
      ok: true,
      config: {
        botToken: String(rows[0].botToken ?? ''),
        groupId: String(rows[0].groupId ?? ''),
        logsGroupId: String(rows[0].logsGroupId ?? ''),
        welcomeMessage: String(rows[0].welcomeMessage ?? ''),
        privateChatOnlyMessage:
          String(rows[0].privateChatOnlyMessage ?? '').trim() ||
          'Conexão permitida somente no chat privado do bot.',
        privateLinkSuccessMessage:
          String(rows[0].privateLinkSuccessMessage ?? '').trim() || 'Conta conectada com sucesso.',
        alreadyLinkedMessage:
          String(rows[0].alreadyLinkedMessage ?? '').trim() ||
          'Esta conta já foi conectada anteriormente e não pode ser vinculada novamente.',
        checkinSuccessMessage:
          String(rows[0].checkinSuccessMessage ?? '').trim() || 'Check-in do dia {day} resgatado com sucesso!',
        checkinAlreadyClaimedMessage:
          String(rows[0].checkinAlreadyClaimedMessage ?? '').trim() || 'Check-in de hoje já foi resgatado.',
        updatedAt: rows[0].updatedAt ?? null,
      },
    })
  } catch (err) {
    console.error('[admin-telegram-config-get]', err)
    res.status(500).json({ ok: false, error: 'Erro ao carregar configuração do Telegram.' })
  }
})

app.post('/api/admin/telegram-config', requireMaxAdmin, async (req, res) => {
  const {
    botToken,
    groupId,
    logsGroupId,
    welcomeMessage,
    privateChatOnlyMessage,
    privateLinkSuccessMessage,
    alreadyLinkedMessage,
    checkinSuccessMessage,
    checkinAlreadyClaimedMessage,
  } = req.body as {
    botToken?: string
    groupId?: string
    logsGroupId?: string
    welcomeMessage?: string
    privateChatOnlyMessage?: string
    privateLinkSuccessMessage?: string
    alreadyLinkedMessage?: string
    checkinSuccessMessage?: string
    checkinAlreadyClaimedMessage?: string
  }

  const parsedBotToken = String(botToken ?? '').trim()
  const parsedGroupId = String(groupId ?? '').trim()
  const parsedLogsGroupId = String(logsGroupId ?? '').trim()
  const parsedWelcomeMessage = String(welcomeMessage ?? '').trim()
  const parsedPrivateChatOnlyMessage =
    String(privateChatOnlyMessage ?? '').trim() ||
    'Conexão permitida somente no chat privado do bot.'
  const parsedPrivateLinkSuccessMessage =
    String(privateLinkSuccessMessage ?? '').trim() || 'Conta conectada com sucesso.'
  const parsedAlreadyLinkedMessage =
    String(alreadyLinkedMessage ?? '').trim() ||
    'Esta conta já foi conectada anteriormente e não pode ser vinculada novamente.'
  const parsedCheckinSuccessMessage =
    String(checkinSuccessMessage ?? '').trim() ||
    'Check-in do dia {day} resgatado com sucesso!'
  const parsedCheckinAlreadyClaimedMessage =
    String(checkinAlreadyClaimedMessage ?? '').trim() ||
    'Check-in de hoje já foi resgatado.'

  if (!parsedBotToken) {
    res.status(400).json({ ok: false, error: 'Bot token é obrigatório.' })
    return
  }

  if (!parsedGroupId) {
    res.status(400).json({ ok: false, error: 'Group ID é obrigatório.' })
    return
  }

  try {
    await ensureTelegramConfigTable()

    await pool.query(
      `
      INSERT INTO system_telegram_config (
        singleton_key,
        bot_token,
        group_id,
        logs_group_id,
        welcome_message,
        private_chat_only_message,
        private_link_success_message,
        duplicate_connection_message,
        checkin_success_message,
        checkin_already_claimed_message
      )
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        bot_token = VALUES(bot_token),
        group_id = VALUES(group_id),
        logs_group_id = VALUES(logs_group_id),
        welcome_message = VALUES(welcome_message),
        private_chat_only_message = VALUES(private_chat_only_message),
        private_link_success_message = VALUES(private_link_success_message),
        duplicate_connection_message = VALUES(duplicate_connection_message),
        checkin_success_message = VALUES(checkin_success_message),
        checkin_already_claimed_message = VALUES(checkin_already_claimed_message),
        updated_at = NOW()
      `,
      [
        parsedBotToken,
        parsedGroupId,
        parsedLogsGroupId,
        parsedWelcomeMessage,
        parsedPrivateChatOnlyMessage,
        parsedPrivateLinkSuccessMessage,
        parsedAlreadyLinkedMessage,
        parsedCheckinSuccessMessage,
        parsedCheckinAlreadyClaimedMessage,
      ]
    )

    res.json({
      ok: true,
      message: 'Configuração do Telegram salva com sucesso.',
      config: {
        botToken: parsedBotToken,
        groupId: parsedGroupId,
        logsGroupId: parsedLogsGroupId,
        welcomeMessage: parsedWelcomeMessage,
        privateChatOnlyMessage: parsedPrivateChatOnlyMessage,
        privateLinkSuccessMessage: parsedPrivateLinkSuccessMessage,
        alreadyLinkedMessage: parsedAlreadyLinkedMessage,
        checkinSuccessMessage: parsedCheckinSuccessMessage,
        checkinAlreadyClaimedMessage: parsedCheckinAlreadyClaimedMessage,
      },
    })
  } catch (err) {
    console.error('[admin-telegram-config-save]', err)
    res.status(500).json({ ok: false, error: 'Erro ao salvar configuração do Telegram.' })
  }
})

app.post('/api/admin/telegram-reconcile-now', requireMaxAdmin, async (_req, res) => {
  try {
    await ensureUserTelegramConnectionsTable()
    await ensureTelegramConnectedColumn()
    await ensureTelegramConnectedSync()
    res.json({ ok: true, message: 'Reconciliação Telegram executada com sucesso.' })
  } catch (err) {
    console.error('[admin-telegram-reconcile-now]', err)
    res.status(500).json({ ok: false, error: 'Falha ao executar reconciliação Telegram.' })
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

    try { await pool.query(`ALTER TABLE site_settings ADD COLUMN site_logo_url VARCHAR(500) NULL`) } catch { /* já existe */ }
    try { await pool.query(`ALTER TABLE site_settings ADD COLUMN telegram_group_link VARCHAR(500) NULL`) } catch { /* já existe */ }

    const [rows] = await pool.query<RowDataPacket[]>(
      `
      SELECT
        id,
        site_title AS siteTitle,
        site_description AS siteDescription,
        COALESCE(site_logo_url, '') AS siteLogoUrl,
        COALESCE(telegram_group_link, '') AS telegramGroupLink,
        updated_at AS updatedAt
      FROM site_settings
      ORDER BY id ASC
      LIMIT 1
      `
    )

    if (rows.length === 0) {
      await pool.query(`INSERT INTO site_settings (site_title, site_description, site_logo_url) VALUES ('', '', '')`)
      res.json({ ok: true, settings: { siteTitle: '', siteDescription: '', siteLogoUrl: '', telegramGroupLink: '', updatedAt: null } })
      return
    }

    res.json({
      ok: true,
      settings: {
        siteTitle: String(rows[0].siteTitle ?? ''),
        siteDescription: String(rows[0].siteDescription ?? ''),
        siteLogoUrl: String(rows[0].siteLogoUrl ?? ''),
        telegramGroupLink: String(rows[0].telegramGroupLink ?? ''),
        updatedAt: rows[0].updatedAt ?? null,
      },
    })
  } catch (err) {
    console.error('[admin-site-settings-get]', err)
    res.status(500).json({ ok: false, error: 'Erro ao carregar configurações do site.' })
  }
})

app.post('/api/admin/site-settings', requireMaxAdmin, async (req, res) => {
  const { siteTitle, siteDescription, siteLogoUrl, telegramGroupLink } = req.body as {
    siteTitle?: string
    siteDescription?: string
    siteLogoUrl?: string
    telegramGroupLink?: string
  }

  const parsedSiteTitle = String(siteTitle ?? '').trim()
  const parsedSiteDescription = String(siteDescription ?? '').trim()
  const parsedSiteLogoUrl = String(siteLogoUrl ?? '').trim()
  const parsedTelegramGroupLink = String(telegramGroupLink ?? '').trim()

  if (!parsedSiteTitle) {
    res.status(400).json({ ok: false, error: 'Título do site é obrigatório.' })
    return
  }

  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS site_settings (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT, site_title VARCHAR(150) NOT NULL DEFAULT '', site_description TEXT NULL, site_logo_url VARCHAR(500) NULL, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (id))`)
    try { await pool.query(`ALTER TABLE site_settings ADD COLUMN site_logo_url VARCHAR(500) NULL`) } catch { /* já existe */ }
    try { await pool.query(`ALTER TABLE site_settings ADD COLUMN telegram_group_link VARCHAR(500) NULL`) } catch { /* já existe */ }

    const [rows] = await pool.query<RowDataPacket[]>('SELECT id FROM site_settings ORDER BY id ASC LIMIT 1')

    if (rows.length === 0) {
      await pool.query(
        `INSERT INTO site_settings (site_title, site_description, site_logo_url, telegram_group_link) VALUES (?, ?, ?, ?)`,
        [parsedSiteTitle, parsedSiteDescription, parsedSiteLogoUrl, parsedTelegramGroupLink]
      )
    } else {
      await pool.query(
        `UPDATE site_settings SET site_title=?, site_description=?, site_logo_url=?, telegram_group_link=?, updated_at=NOW() WHERE id=?`,
        [parsedSiteTitle, parsedSiteDescription, parsedSiteLogoUrl, parsedTelegramGroupLink, Number(rows[0].id)]
      )
    }

    res.json({
      ok: true,
      message: 'Configurações do site salvas com sucesso.',
      settings: { siteTitle: parsedSiteTitle, siteDescription: parsedSiteDescription, siteLogoUrl: parsedSiteLogoUrl, telegramGroupLink: parsedTelegramGroupLink },
    })
  } catch (err) {
    console.error('[admin-site-settings-save]', err)
    res.status(500).json({ ok: false, error: 'Erro ao salvar configurações do site.' })
  }
})

app.get('/api/admin/overview', requireMaxAdmin, async (_req, res) => {
  try {
    // Total de usuários cadastrados
    const [activeUsersRows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM users`
    )

    // Cadastros hoje
    const [registrationsTodayRows] = await pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) AS total FROM users WHERE DATE(created_at) = CURDATE()`
    )

    // Depósitos hoje — valor e contagem
    const [depositsTodayRows] = await pool.query<RowDataPacket[]>(
      `
      SELECT
        COALESCE(SUM(amount), 0) AS totalAmount,
        COUNT(*) AS totalCount
      FROM cashin_payments
      WHERE LOWER(status) IN ('paid', 'payment.paid')
        AND DATE(COALESCE(paid_at, created_at)) = CURDATE()
      `
    )

    // Depósitos no mês — valor e contagem
    const [depositsMonthRows] = await pool.query<RowDataPacket[]>(
      `
      SELECT
        COALESCE(SUM(amount), 0) AS totalAmount,
        COUNT(*) AS totalCount
      FROM cashin_payments
      WHERE LOWER(status) IN ('paid', 'payment.paid')
        AND YEAR(COALESCE(paid_at, created_at)) = YEAR(CURDATE())
        AND MONTH(COALESCE(paid_at, created_at)) = MONTH(CURDATE())
      `
    )

    let pendingWithdrawals = 0
    let withdrawalsTodayCount = 0
    let withdrawalsTodayAmount = 0
    let withdrawalsMonthCount = 0
    let withdrawalsMonthAmount = 0
    let withdrawalsPaidTotal = 0

    try {
      // Saques pendentes (contagem)
      const [pendingRows] = await pool.query<RowDataPacket[]>(
        `SELECT COUNT(*) AS total FROM withdrawals WHERE LOWER(status) IN ('pending', 'processing')`
      )
      pendingWithdrawals = Number(pendingRows[0]?.total ?? 0)

      // Saques hoje — valor e contagem (todos os status)
      const [wdTodayRows] = await pool.query<RowDataPacket[]>(
        `
        SELECT
          COALESCE(SUM(amount), 0) AS totalAmount,
          COUNT(*) AS totalCount
        FROM withdrawals
        WHERE DATE(created_at) = CURDATE()
        `
      )
      withdrawalsTodayCount = Number(wdTodayRows[0]?.totalCount ?? 0)
      withdrawalsTodayAmount = Number(wdTodayRows[0]?.totalAmount ?? 0)

      // Saques no mês — valor e contagem (todos os status)
      const [wdMonthRows] = await pool.query<RowDataPacket[]>(
        `
        SELECT
          COALESCE(SUM(amount), 0) AS totalAmount,
          COUNT(*) AS totalCount
        FROM withdrawals
        WHERE YEAR(created_at) = YEAR(CURDATE())
          AND MONTH(created_at) = MONTH(CURDATE())
        `
      )
      withdrawalsMonthCount = Number(wdMonthRows[0]?.totalCount ?? 0)
      withdrawalsMonthAmount = Number(wdMonthRows[0]?.totalAmount ?? 0)

      // Total pago para cálculo da receita líquida
      const [paidRows] = await pool.query<RowDataPacket[]>(
        `SELECT COALESCE(SUM(amount), 0) AS total FROM withdrawals WHERE LOWER(status) IN ('paid', 'payment.paid')`
      )
      withdrawalsPaidTotal = Number(paidRows[0]?.total ?? 0)
    } catch {
      // tabela withdrawals pode não existir ainda
    }

    const depositsTodayAmount = Number(depositsTodayRows[0]?.totalAmount ?? 0)
    const depositsTodayCount = Number(depositsTodayRows[0]?.totalCount ?? 0)
    const depositsMonthAmount = Number(depositsMonthRows[0]?.totalAmount ?? 0)
    const depositsMonthCount = Number(depositsMonthRows[0]?.totalCount ?? 0)
    const netRevenue = Number((depositsTodayAmount - withdrawalsPaidTotal).toFixed(2))

    res.json({
      ok: true,
      summary: {
        activeUsers: Number(activeUsersRows[0]?.total ?? 0),
        registrationsToday: Number(registrationsTodayRows[0]?.total ?? 0),
        depositsToday: depositsTodayAmount,
        depositsTodayCount,
        depositsMonthAmount,
        depositsMonthCount,
        withdrawalsTodayCount,
        withdrawalsTodayAmount,
        withdrawalsMonthCount,
        withdrawalsMonthAmount,
        pendingWithdrawals,
        netRevenue,
      },
    })
  } catch (err) {
    console.error('[admin-overview]', err)
    res.status(500).json({ ok: false, error: 'Erro ao carregar visão geral do admin.' })
  }
})

app.get('/api/admin/deposits', requireMaxAdmin, async (req, res) => {
  const statusFilter = String(req.query.status ?? 'all').trim().toLowerCase()
  const search = String(req.query.search ?? '').trim()
  const rawLimit = Number(req.query.limit ?? 100)
  const limit = Math.min(Math.max(rawLimit, 1), 500)

  const statusSql =
    statusFilter === 'paid'
      ? `AND LOWER(cp.status) IN ('paid', 'payment.paid')`
      : statusFilter === 'pending'
        ? `AND LOWER(cp.status) = 'pending'`
        : statusFilter === 'processing'
          ? `AND LOWER(cp.status) = 'processing'`
          : statusFilter === 'failed'
            ? `AND LOWER(cp.status) IN ('failed', 'canceled', 'cancelled')`
            : ''

  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `
      SELECT
        cp.id,
        cp.user_id AS userId,
        cp.amount,
        cp.method,
        cp.status,
        cp.provider_transaction_id AS providerTransactionId,
        cp.created_at AS createdAt,
        cp.paid_at AS paidAt,
        u.name AS userName,
        u.phone AS userPhone,
        ref.id AS referrerId,
        ref.name AS referrerName,
        ref.phone AS referrerPhone,
        (
          SELECT COUNT(*)
          FROM users child
          WHERE child.referred_by_user_id = u.id
        ) AS referredCount,
        (
          SELECT GROUP_CONCAT(CONCAT(COALESCE(child.name, 'Usuário'), '::', COALESCE(child.phone, '')) SEPARATOR '||')
          FROM users child
          WHERE child.referred_by_user_id = u.id
        ) AS referredUsersRaw
      FROM cashin_payments cp
      INNER JOIN users u ON u.id = cp.user_id
      LEFT JOIN users ref ON ref.id = u.referred_by_user_id
      WHERE 1 = 1
        ${statusSql}
        ${
          search
            ? `AND (
                 CAST(cp.id AS CHAR) LIKE ?
                 OR CAST(cp.user_id AS CHAR) LIKE ?
                 OR COALESCE(cp.provider_transaction_id, '') LIKE ?
                 OR COALESCE(u.name, '') LIKE ?
                 OR COALESCE(u.phone, '') LIKE ?
               )`
            : ''
        }
      ORDER BY cp.id DESC
      LIMIT ?
      `,
      search
        ? [
            `%${search}%`,
            `%${search}%`,
            `%${search}%`,
            `%${search}%`,
            `%${search}%`,
            limit,
          ]
        : [limit]
    )

    const deposits = rows.map((row) => {
      const referredUsersRaw = String(row.referredUsersRaw ?? '').trim()
      const referredUsers = referredUsersRaw
        ? referredUsersRaw
            .split('||')
            .map((entry) => {
              const [nameRaw, phoneRaw] = String(entry).split('::')
              return {
                name: String(nameRaw ?? 'Usuário'),
                phone: String(phoneRaw ?? ''),
              }
            })
        : []

      return {
        id: Number(row.id),
        userId: Number(row.userId),
        amount: Number(row.amount ?? 0),
        method: String(row.method ?? 'pix'),
        status: String(row.status ?? 'pending').toLowerCase(),
        providerTransactionId: row.providerTransactionId ? String(row.providerTransactionId) : null,
        createdAt: row.createdAt ?? null,
        paidAt: row.paidAt ?? null,
        user: {
          id: Number(row.userId),
          name: String(row.userName ?? 'Usuário'),
          phone: String(row.userPhone ?? ''),
        },
        referrer: row.referrerId == null
          ? null
          : {
              id: Number(row.referrerId),
              name: String(row.referrerName ?? 'Usuário'),
              phone: String(row.referrerPhone ?? ''),
            },
        referred: {
          count: Number(row.referredCount ?? 0),
          users: referredUsers,
        },
      }
    })

    res.json({
      ok: true,
      filter: {
        status: statusFilter,
        search: search || null,
        limit,
      },
      total: deposits.length,
      deposits,
    })
  } catch (err) {
    console.error('[admin-deposits-list]', err)
    res.status(500).json({ ok: false, error: 'Erro ao carregar entradas de pagamentos.' })
  }
})

app.post('/api/admin/deposits/:id/action', requireMaxAdmin, async (req, res) => {
  const depositId = Number(req.params.id)
  const { action } = (req.body ?? {}) as { action?: 'approve' | 'cancel' }
  const parsedAction = String(action ?? '').trim().toLowerCase()

  if (!depositId || Number.isNaN(depositId)) {
    res.status(400).json({ ok: false, error: 'ID do depósito inválido.' })
    return
  }

  if (!['approve', 'cancel'].includes(parsedAction)) {
    res.status(400).json({ ok: false, error: 'Ação inválida. Use approve ou cancel.' })
    return
  }

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    const [depositRows] = await conn.query<RowDataPacket[]>(
      `
      SELECT
        id,
        user_id AS userId,
        amount,
        status
      FROM cashin_payments
      WHERE id = ?
      LIMIT 1
      FOR UPDATE
      `,
      [depositId]
    )

    if (depositRows.length === 0) {
      await conn.rollback()
      res.status(404).json({ ok: false, error: 'Depósito não encontrado.' })
      return
    }

    const deposit = depositRows[0]
    const userId = Number(deposit.userId ?? 0)
    const amount = Number(deposit.amount ?? 0)
    const currentStatus = String(deposit.status ?? '').toLowerCase()
    const isCurrentlyPaid = currentStatus === 'paid' || currentStatus === 'payment.paid'

    const [userRows] = await conn.query<RowDataPacket[]>(
      `
      SELECT id, balance, total_deposits AS totalDeposits
      FROM users
      WHERE id = ?
      LIMIT 1
      FOR UPDATE
      `,
      [userId]
    )

    if (userRows.length === 0) {
      await conn.rollback()
      res.status(404).json({ ok: false, error: 'Usuário do depósito não encontrado.' })
      return
    }

    const currentBalance = Number(userRows[0].balance ?? 0)
    const currentTotalDeposits = Number(userRows[0].totalDeposits ?? 0)

    if (parsedAction === 'approve') {
      if (!isCurrentlyPaid) {
        await conn.query(
          `
          UPDATE cashin_payments
          SET status = 'paid', paid_at = COALESCE(paid_at, NOW()), updated_at = NOW()
          WHERE id = ?
          `,
          [depositId]
        )

        await conn.query(
          `
          UPDATE users
          SET
            balance = COALESCE(balance, 0) + ?,
            total_deposits = COALESCE(total_deposits, 0) + ?
          WHERE id = ?
          `,
          [amount, amount, userId]
        )
      }

      await conn.commit()

      if (!isCurrentlyPaid) {
        await applyReferralCommissionsForDeposit(depositId, userId, amount)
      }
      res.json({
        ok: true,
        message: isCurrentlyPaid ? 'Depósito já estava aprovado.' : 'Depósito aprovado e saldo creditado.',
        deposit: {
          id: depositId,
          status: 'paid',
        },
      })
      return
    }

    // cancel
    if (!isCurrentlyPaid) {
      await conn.rollback()
      res.status(400).json({
        ok: false,
        error: 'Apenas depósitos aprovados/pagos podem ser cancelados com débito em conta.',
      })
      return
    }

    await conn.query(
      `
      UPDATE cashin_payments
      SET status = 'failed', updated_at = NOW()
      WHERE id = ?
      `,
      [depositId]
    )

    const nextBalance = Number((currentBalance - amount).toFixed(2))
    const nextTotalDeposits = Number((currentTotalDeposits - amount).toFixed(2))

    if (nextBalance < 0 || nextTotalDeposits < 0) {
      await conn.rollback()
      res.status(400).json({
        ok: false,
        error: 'Não foi possível cancelar: saldo/depósitos do usuário insuficientes para débito.',
      })
      return
    }

    await conn.query(
      `
      UPDATE users
      SET
        balance = ?,
        total_deposits = ?
      WHERE id = ?
      `,
      [nextBalance, nextTotalDeposits, userId]
    )

    await conn.commit()
    res.json({
      ok: true,
      message: 'Depósito cancelado e valor removido da conta do usuário.',
      deposit: {
        id: depositId,
        status: 'failed',
      },
      debitedFromUser: true,
    })
  } catch (err) {
    await conn.rollback()
    console.error('[admin-deposits-action]', err)
    res.status(500).json({ ok: false, error: 'Erro ao processar ação do depósito.' })
  } finally {
    conn.release()
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

    await pool.query(
      `
      CREATE TABLE IF NOT EXISTS system_telegram_config (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        singleton_key TINYINT UNSIGNED NOT NULL DEFAULT 1,
        bot_token VARCHAR(255) NOT NULL DEFAULT '',
        group_id VARCHAR(255) NOT NULL DEFAULT '',
        welcome_message TEXT NULL,
        private_chat_only_message TEXT NULL,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_system_telegram_config_singleton (singleton_key)
      )
      `
    )

    await pool.query(
      `
      INSERT IGNORE INTO system_telegram_config (
        singleton_key,
        bot_token,
        group_id,
        welcome_message,
        private_chat_only_message,
        private_link_success_message
      )
      VALUES (1, '', '', '', 'Conexão permitida somente no chat privado do bot.', 'Conta conectada com sucesso.')
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

    await ensureCommissionLevelsTable()

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

    await pool.query(
      `
      ALTER TABLE users
      ADD COLUMN balance DECIMAL(12,2) NOT NULL DEFAULT 0.00
      `
    ).catch(() => null)

    await pool.query(
      `
      ALTER TABLE users
      ADD COLUMN referred_by_user_id BIGINT UNSIGNED NULL
      `
    ).catch(() => null)

    const [rows] = await pool.query<RowDataPacket[]>(
      `
      SELECT
        u.id,
        u.name,
        u.phone,
        u.is_admin,
        COALESCE(u.is_banned, 0) AS is_banned,
        COALESCE(u.balance, 0) AS balance,
        u.referred_by_user_id,
        ref.id AS referrer_id,
        ref.name AS referrer_name,
        ref.phone AS referrer_phone,
        u.created_at
      FROM users u
      LEFT JOIN users ref ON ref.id = u.referred_by_user_id
      ORDER BY u.id DESC
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

app.get('/api/admin/users/:id/withdraw-activation-token-info', requireMaxAdmin, async (req, res) => {
  const userId = Number(req.params.id)

  if (!userId || Number.isNaN(userId)) {
    res.status(400).json({ ok: false, error: 'ID inválido.' })
    return
  }

  try {
    const [userRows] = await pool.query<RowDataPacket[]>(
      `
      SELECT id, name, phone
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

    await ensureWithdrawActivationTokensTable()

    const [tokenRows] = await pool.query<RowDataPacket[]>(
      `
      SELECT
        id,
        user_id AS userId,
        token,
        status,
        telegram_user_id AS telegramUserId,
        activated_chat_id AS activatedChatId,
        activated_at AS activatedAt,
        expires_at AS expiresAt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM withdraw_activation_tokens
      WHERE user_id = ?
      ORDER BY id DESC
      LIMIT 1
      `,
      [userId]
    )

    const user = userRows[0]
    const tokenInfo = tokenRows[0] ?? null

    res.json({
      ok: true,
      user: {
        id: Number(user.id),
        name: String(user.name ?? ''),
        phone: String(user.phone ?? ''),
      },
      tokenInfo: tokenInfo
        ? {
            id: Number(tokenInfo.id ?? 0),
            userId: Number(tokenInfo.userId ?? userId),
            token: String(tokenInfo.token ?? ''),
            status: String(tokenInfo.status ?? ''),
            telegramUserId: tokenInfo.telegramUserId == null ? null : String(tokenInfo.telegramUserId),
            activatedChatId: tokenInfo.activatedChatId == null ? null : String(tokenInfo.activatedChatId),
            activatedAt: tokenInfo.activatedAt ?? null,
            expiresAt: tokenInfo.expiresAt ?? null,
            createdAt: tokenInfo.createdAt ?? null,
            updatedAt: tokenInfo.updatedAt ?? null,
          }
        : null,
    })
  } catch (err) {
    console.error('[admin-user-withdraw-activation-token-info]', err)
    res.status(500).json({ ok: false, error: 'Falha ao carregar token de ativação de saque.' })
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
        COALESCE(balance, 0) AS balance,
        COALESCE(shop_balance, 0) AS shopBalance,
        COALESCE(telegram_conectado, 0) AS telegramConectado,
        monthly_salary_contract AS activeContract
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

    // ── Total de compras de gift card na loja ──────────────────────────────────
    let totalShopGiftCardPurchases = 0
    try {
      const [shopPurchaseRows] = await pool.query<RowDataPacket[]>(
        `
        SELECT COUNT(*) AS total
        FROM shop_balance_transactions
        WHERE user_id = ?
          AND type = 'debit'
        `,
        [userId]
      )
      totalShopGiftCardPurchases = Number(shopPurchaseRows[0]?.total ?? 0)
    } catch {
      totalShopGiftCardPurchases = 0
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

    // ── Níveis de comissão com contagem de convidados por nível ────────────────
    let commissionLevelStats: Array<{
      level: number
      name: string
      commissionPercent: number
      referralCount: number
      referralsWithDeposit: number
    }> = []

    try {
      await ensureCommissionLevelsTable()

      const [commLevelRows] = await pool.query<RowDataPacket[]>(
        `
        SELECT
          id,
          level,
          name,
          commission_percent AS commissionPercent
        FROM commission_levels
        WHERE is_active = 1
        ORDER BY level ASC
        `
      )

      commissionLevelStats = await Promise.all(
        commLevelRows.map(async (cl) => {
          const lvl = Number(cl.level ?? 1)
          try {
            // Conta convidados no nível N (referrals recursivos)
            const [countRows] = await pool.query<RowDataPacket[]>(
              `
              WITH RECURSIVE referral_tree AS (
                SELECT id, referred_by_user_id, 1 AS depth
                FROM users
                WHERE referred_by_user_id = ?

                UNION ALL

                SELECT u.id, u.referred_by_user_id, rt.depth + 1
                FROM users u
                INNER JOIN referral_tree rt ON u.referred_by_user_id = rt.id
                WHERE rt.depth < ?
              )
              SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN EXISTS (
                  SELECT 1 FROM cashin_payments cp
                  WHERE cp.user_id = rt.id
                    AND LOWER(cp.status) IN ('paid', 'payment.paid')
                ) THEN 1 ELSE 0 END) AS withDeposit
              FROM referral_tree rt
              WHERE rt.depth = ?
              `,
              [userId, lvl, lvl]
            )
            return {
              level: lvl,
              name: String(cl.name ?? `Nível ${lvl}`),
              commissionPercent: Number(cl.commissionPercent ?? 0),
              referralCount: Number(countRows[0]?.total ?? 0),
              referralsWithDeposit: Number(countRows[0]?.withDeposit ?? 0),
            }
          } catch {
            return {
              level: lvl,
              name: String(cl.name ?? `Nível ${lvl}`),
              commissionPercent: Number(cl.commissionPercent ?? 0),
              referralCount: 0,
              referralsWithDeposit: 0,
            }
          }
        })
      )
    } catch {
      commissionLevelStats = []
    }

    // ── Histórico de depósitos ─────────────────────────────────────────────────
    let depositHistory: Array<{
      id: number
      amount: number
      status: string
      method: string
      externalId: string | null
      paidAt: string | null
      createdAt: string | null
    }> = []

    try {
      const [depositHistRows] = await pool.query<RowDataPacket[]>(
        `
        SELECT
          id,
          amount,
          status,
          method,
          provider_transaction_id AS externalId,
          paid_at   AS paidAt,
          created_at AS createdAt
        FROM cashin_payments
        WHERE user_id = ?
        ORDER BY id DESC
        LIMIT 200
        `,
        [userId]
      )

      depositHistory = depositHistRows.map((row) => ({
        id:         Number(row.id),
        amount:     Number(row.amount ?? 0),
        status:     String(row.status ?? 'pending'),
        method:     String(row.method ?? 'pix'),
        externalId: row.externalId ? String(row.externalId) : null,
        paidAt:     row.paidAt    ? String(row.paidAt)    : null,
        createdAt:  row.createdAt ? String(row.createdAt) : null,
      }))
    } catch {
      depositHistory = []
    }

    // ── Histórico de saques ────────────────────────────────────────────────────
    let withdrawalHistory: Array<{
      id: number
      amount: number
      status: string
      holderName: string
      pixKeyType: string
      pixKey: string
      externalId: string | null
      paidAt: string | null
      createdAt: string | null
    }> = []

    try {
      const [withdrawHistRows] = await pool.query<RowDataPacket[]>(
        `
        SELECT
          id,
          amount,
          status,
          holder_name  AS holderName,
          pix_key_type AS pixKeyType,
          pix_key      AS pixKey,
          external_id  AS externalId,
          paid_at      AS paidAt,
          created_at   AS createdAt
        FROM withdrawals
        WHERE user_id = ?
        ORDER BY id DESC
        LIMIT 200
        `,
        [userId]
      ).catch(() => [[]])

      withdrawalHistory = (withdrawHistRows as RowDataPacket[]).map((row) => ({
        id:          Number(row.id),
        amount:      Number(row.amount ?? 0),
        status:      String(row.status ?? 'pending'),
        holderName:  String(row.holderName ?? ''),
        pixKeyType:  String(row.pixKeyType ?? ''),
        pixKey:      String(row.pixKey ?? ''),
        externalId:  row.externalId ? String(row.externalId) : null,
        paidAt:      row.paidAt     ? String(row.paidAt)     : null,
        createdAt:   row.createdAt  ? String(row.createdAt)  : null,
      }))
    } catch {
      withdrawalHistory = []
    }

    // ── Histórico de depósitos da loja (shop_deposits) ────────────────────────
    let shopDepositHistory: Array<{
      id: number
      amount: number
      status: string
      externalId: string | null
      paidAt: string | null
      createdAt: string | null
    }> = []

    try {
      const [shopDepRows] = await pool.query<RowDataPacket[]>(
        `SELECT id, amount, status,
                provider_transaction_id AS externalId,
                paid_at    AS paidAt,
                created_at AS createdAt
         FROM shop_deposits
         WHERE user_id = ?
         ORDER BY id DESC
         LIMIT 200`,
        [userId]
      )
      shopDepositHistory = shopDepRows.map((row) => ({
        id:         Number(row.id),
        amount:     Number(row.amount ?? 0),
        status:     String(row.status ?? 'pending'),
        externalId: row.externalId ? String(row.externalId) : null,
        paidAt:     row.paidAt     ? String(row.paidAt)     : null,
        createdAt:  row.createdAt  ? String(row.createdAt)  : null,
      }))
    } catch {
      shopDepositHistory = []
    }

    // ── Histórico de compras de gift card na loja (shop_balance_transactions debit) ──
    let shopPurchaseHistory: Array<{
      id: number
      amount: number
      reason: string
      referenceId: string | null
      createdAt: string | null
    }> = []

    try {
      const [shopPurchRows] = await pool.query<RowDataPacket[]>(
        `SELECT id, amount, reason,
                reference_id AS referenceId,
                created_at   AS createdAt
         FROM shop_balance_transactions
         WHERE user_id = ?
           AND type = 'debit'
         ORDER BY id DESC
         LIMIT 200`,
        [userId]
      )
      shopPurchaseHistory = shopPurchRows.map((row) => ({
        id:          Number(row.id),
        amount:      Number(row.amount ?? 0),
        reason:      String(row.reason ?? 'Compra gift card'),
        referenceId: row.referenceId ? String(row.referenceId) : null,
        createdAt:   row.createdAt   ? String(row.createdAt)   : null,
      }))
    } catch {
      shopPurchaseHistory = []
    }

    // ── Giros da roleta realizados ──────────────────────────────────────────────
    let rouletteSpins: Array<{
      id: number
      prizeLabel: string
      prizeIndex: number
      source: string
      createdAt: string | null
    }> = []

    try {
      await pool.query(`
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
      `).catch(() => null)

      const [spinRows] = await pool.query<RowDataPacket[]>(
        `
        SELECT
          id,
          prize_label  AS prizeLabel,
          prize_index  AS prizeIndex,
          source,
          created_at   AS createdAt
        FROM roulette_spins
        WHERE user_id = ?
        ORDER BY id DESC
        LIMIT 100
        `,
        [userId]
      )

      rouletteSpins = spinRows.map((row) => ({
        id: Number(row.id),
        prizeLabel: String(row.prizeLabel ?? ''),
        prizeIndex: Number(row.prizeIndex ?? 0),
        source: String(row.source ?? 'roleta_page'),
        createdAt: row.createdAt ? String(row.createdAt) : null,
      }))
    } catch {
      rouletteSpins = []
    }

    // ── Saldo de giros (earned / used / available) ──────────────────────────────
    let rouletteSpinBalance: {
      availableSpins: number
      totalEarned: number
      totalUsed: number
    } = { availableSpins: 0, totalEarned: 0, totalUsed: 0 }

    try {
      await ensureUserRouletteSpinsTable()

      const [balanceRows] = await pool.query<RowDataPacket[]>(
        `
        SELECT
          available_spins AS availableSpins,
          total_earned    AS totalEarned,
          total_used      AS totalUsed
        FROM user_roulette_spins
        WHERE user_id = ?
        LIMIT 1
        `,
        [userId]
      )

      if (balanceRows.length > 0) {
        rouletteSpinBalance = {
          availableSpins: Number(balanceRows[0].availableSpins ?? 0),
          totalEarned:    Number(balanceRows[0].totalEarned   ?? 0),
          totalUsed:      Number(balanceRows[0].totalUsed     ?? 0),
        }
      }
    } catch {
      rouletteSpinBalance = { availableSpins: 0, totalEarned: 0, totalUsed: 0 }
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
        shopBalance: Number(user.shopBalance ?? 0),
        telegramConectado: Number(user.telegramConectado ?? 0),
        activeContract: user.activeContract == null ? null : String(user.activeContract),
        totalDepositsPaid: Number(depositRows[0]?.total ?? 0),
        totalWithdrawals,
        totalCyclePlansBought,
        totalVipPlansBought,
        totalShopGiftCardPurchases,
        accountLogs,
        vipPurchases,
        cyclePurchases,
        giftCodeRedemptions,
        dailyCheckinRedemptions,
        depositHistory,
        withdrawalHistory,
        shopDepositHistory,
        shopPurchaseHistory,
        commissionLevelStats,
        rouletteSpins,
        rouletteSpinBalance,
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

// ─── Caixas Box ──────────────────────────────────────────────────────────────

const DEFAULT_CAIXAS_BOX_PRIZES = [
  { prizeKey: 'iphone',    label: 'iPhone',       type: 'physical', value: 0,  probability: 1,  sortOrder: 0, isActive: 1 },
  { prizeKey: 'caixa_som', label: 'Caixa de Som', type: 'physical', value: 0,  probability: 4,  sortOrder: 1, isActive: 1 },
  { prizeKey: 'r50',       label: 'R$ 50,00',     type: 'cash',     value: 50, probability: 5,  sortOrder: 2, isActive: 1 },
  { prizeKey: 'r20',       label: 'R$ 20,00',     type: 'cash',     value: 20, probability: 10, sortOrder: 3, isActive: 1 },
  { prizeKey: 'r10',       label: 'R$ 10,00',     type: 'cash',     value: 10, probability: 15, sortOrder: 4, isActive: 1 },
  { prizeKey: 'r5',        label: 'R$ 5,00',      type: 'cash',     value: 5,  probability: 25, sortOrder: 5, isActive: 1 },
  { prizeKey: 'r1',        label: 'R$ 1,00',      type: 'cash',     value: 1,  probability: 40, sortOrder: 6, isActive: 1 },
]

const ensureCaixasBoxTables = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_caixas_box_spins (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id BIGINT UNSIGNED NOT NULL,
      available_spins INT NOT NULL DEFAULT 0,
      total_earned INT NOT NULL DEFAULT 0,
      total_used INT NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_caixas_box_user (user_id)
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS caixas_box_results (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id BIGINT UNSIGNED NOT NULL,
      prize_id VARCHAR(30) NOT NULL,
      prize_label VARCHAR(80) NOT NULL,
      prize_type VARCHAR(20) NOT NULL DEFAULT 'cash',
      prize_value DECIMAL(12,2) NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_caixas_box_user (user_id),
      KEY idx_caixas_box_created (created_at)
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS caixas_box_prizes (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      prize_key VARCHAR(40) NOT NULL,
      label VARCHAR(120) NOT NULL,
      type VARCHAR(20) NOT NULL DEFAULT 'cash',
      value DECIMAL(12,2) NOT NULL DEFAULT 0,
      probability DECIMAL(8,4) NOT NULL DEFAULT 0,
      sort_order INT NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      image_url VARCHAR(500) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_caixas_box_prizes_key (prize_key)
    )
  `)
  // Adiciona image_url se a coluna ainda não existir (migração para tabelas existentes)
  try {
    await pool.query(`ALTER TABLE caixas_box_prizes ADD COLUMN image_url VARCHAR(500) NULL`)
  } catch (_) { /* coluna já existe */ }
  // Insere defaults se tabela vazia
  const [countRows] = await pool.query<RowDataPacket[]>('SELECT COUNT(*) AS total FROM caixas_box_prizes')
  const total = Number((countRows as RowDataPacket[])[0]?.total ?? 0)
  if (total === 0) {
    for (const p of DEFAULT_CAIXAS_BOX_PRIZES) {
      await pool.query(
        `INSERT IGNORE INTO caixas_box_prizes (prize_key, label, type, value, probability, sort_order, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [p.prizeKey, p.label, p.type, p.value, p.probability, p.sortOrder, p.isActive]
      )
    }
  }
}

async function loadActiveCaixasBoxPrizes() {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT id, prize_key AS prizeKey, label, type, value, probability, sort_order AS sortOrder, is_active AS isActive, image_url AS imageUrl
     FROM caixas_box_prizes WHERE is_active = 1 ORDER BY sort_order ASC, id ASC`
  )
  return rows.map((r) => ({
    id: Number(r.id),
    id_db: Number(r.id),
    prizeKey: String(r.prizeKey),
    label: String(r.label),
    type: String(r.type),
    value: Number(r.value),
    probability: Number(r.probability),
    sortOrder: Number(r.sortOrder),
    isActive: Number(r.isActive) === 1,
    imageUrl: r.imageUrl ? String(r.imageUrl) : null,
  }))
}

function weightedRandomBox(items: Array<{ prizeKey: string; label: string; type: string; value: number; probability: number; imageUrl?: string | null }>) {
  const total = items.reduce((acc, i) => acc + i.probability, 0)
  let rand = Math.random() * total
  for (const item of items) {
    rand -= item.probability
    if (rand <= 0) return item
  }
  return items[items.length - 1]
}

// ── Admin: CRUD de prêmios ────────────────────────────────────────────────────

// GET /api/admin/caixas-box/prizes — todos os prêmios (admin)
app.get('/api/admin/caixas-box/prizes', requireMaxAdmin, async (_req: AuthenticatedRequest, res) => {
  try {
    await ensureCaixasBoxTables()
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT id, prize_key AS prizeKey, label, type, value, probability, sort_order AS sortOrder, is_active AS isActive, image_url AS imageUrl, created_at AS createdAt
       FROM caixas_box_prizes ORDER BY sort_order ASC, id ASC`
    )
    res.json({
      ok: true,
      prizes: rows.map((r) => ({
        id: Number(r.id),
        prizeKey: String(r.prizeKey),
        label: String(r.label),
        type: String(r.type),
        value: Number(r.value),
        probability: Number(r.probability),
        sortOrder: Number(r.sortOrder),
        isActive: Number(r.isActive) === 1,
        imageUrl: r.imageUrl ? String(r.imageUrl) : '',
        createdAt: r.createdAt,
      })),
    })
  } catch (err) {
    console.error('[admin-caixas-box-prizes-list]', err)
    res.status(500).json({ ok: false, error: 'Erro ao listar prêmios.' })
  }
})

// POST /api/admin/caixas-box/prizes — cria novo prêmio
app.post('/api/admin/caixas-box/prizes', requireMaxAdmin, async (req: AuthenticatedRequest, res) => {
  const { prizeKey, label, type, value, probability, sortOrder, isActive, imageUrl } = req.body as {
    prizeKey?: string; label?: string; type?: string; value?: number; probability?: number; sortOrder?: number; isActive?: boolean; imageUrl?: string
  }
  if (!prizeKey || !label) {
    res.status(400).json({ ok: false, error: 'prizeKey e label são obrigatórios.' })
    return
  }
  try {
    await ensureCaixasBoxTables()
    const parsedImageUrl = String(imageUrl ?? '').trim() || null
    await pool.query(
      `INSERT INTO caixas_box_prizes (prize_key, label, type, value, probability, sort_order, is_active, image_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        String(prizeKey).trim(),
        String(label).trim(),
        String(type ?? 'cash').trim(),
        Number(value ?? 0),
        Number(probability ?? 0),
        Number(sortOrder ?? 0),
        (isActive ?? true) ? 1 : 0,
        parsedImageUrl,
      ]
    )
    res.json({ ok: true, message: 'Prêmio criado com sucesso.' })
  } catch (err: any) {
    if (String(err?.code ?? '') === 'ER_DUP_ENTRY') {
      res.status(409).json({ ok: false, error: 'Já existe um prêmio com esse prizeKey.' })
      return
    }
    console.error('[admin-caixas-box-prizes-create]', err)
    res.status(500).json({ ok: false, error: 'Erro ao criar prêmio.' })
  }
})

// PUT /api/admin/caixas-box/prizes/:id — edita um prêmio
app.put('/api/admin/caixas-box/prizes/:id', requireMaxAdmin, async (req: AuthenticatedRequest, res) => {
  const id = Number(req.params.id)
  if (!id || Number.isNaN(id)) {
    res.status(400).json({ ok: false, error: 'ID inválido.' })
    return
  }
  const { label, type, value, probability, sortOrder, isActive, imageUrl } = req.body as {
    label?: string; type?: string; value?: number; probability?: number; sortOrder?: number; isActive?: boolean; imageUrl?: string
  }
  try {
    await ensureCaixasBoxTables()
    const parsedImageUrl = String(imageUrl ?? '').trim() || null
    await pool.query(
      `UPDATE caixas_box_prizes SET label = ?, type = ?, value = ?, probability = ?, sort_order = ?, is_active = ?, image_url = ?, updated_at = NOW() WHERE id = ?`,
      [
        String(label ?? '').trim(),
        String(type ?? 'cash').trim(),
        Number(value ?? 0),
        Number(probability ?? 0),
        Number(sortOrder ?? 0),
        (isActive ?? true) ? 1 : 0,
        parsedImageUrl,
        id,
      ]
    )
    res.json({ ok: true, message: 'Prêmio atualizado com sucesso.' })
  } catch (err) {
    console.error('[admin-caixas-box-prizes-update]', err)
    res.status(500).json({ ok: false, error: 'Erro ao atualizar prêmio.' })
  }
})

// DELETE /api/admin/caixas-box/prizes/:id — remove um prêmio
app.delete('/api/admin/caixas-box/prizes/:id', requireMaxAdmin, async (req: AuthenticatedRequest, res) => {
  const id = Number(req.params.id)
  if (!id || Number.isNaN(id)) {
    res.status(400).json({ ok: false, error: 'ID inválido.' })
    return
  }
  try {
    await ensureCaixasBoxTables()
    await pool.query('DELETE FROM caixas_box_prizes WHERE id = ?', [id])
    res.json({ ok: true, message: 'Prêmio removido com sucesso.' })
  } catch (err) {
    console.error('[admin-caixas-box-prizes-delete]', err)
    res.status(500).json({ ok: false, error: 'Erro ao remover prêmio.' })
  }
})

// GET /api/admin/caixas-box/stats — estatísticas gerais
app.get('/api/admin/caixas-box/stats', requireMaxAdmin, async (_req: AuthenticatedRequest, res) => {
  try {
    await ensureCaixasBoxTables()
    const [totalSpinsRows] = await pool.query<RowDataPacket[]>(
      'SELECT COALESCE(SUM(total_used), 0) AS totalOpened, COALESCE(SUM(available_spins), 0) AS totalPending FROM user_caixas_box_spins'
    )
    const [prizesRows] = await pool.query<RowDataPacket[]>(
      `SELECT prize_label AS prizeLabel, COUNT(*) AS count FROM caixas_box_results GROUP BY prize_label ORDER BY count DESC`
    )
    res.json({
      ok: true,
      stats: {
        totalOpened: Number(totalSpinsRows[0]?.totalOpened ?? 0),
        totalPending: Number(totalSpinsRows[0]?.totalPending ?? 0),
        byPrize: prizesRows.map((r) => ({ prizeLabel: String(r.prizeLabel), count: Number(r.count) })),
      },
    })
  } catch (err) {
    console.error('[admin-caixas-box-stats]', err)
    res.status(500).json({ ok: false, error: 'Erro ao carregar estatísticas.' })
  }
})

// ── Endpoints públicos/usuário ────────────────────────────────────────────────

// GET /api/caixas-box/spins/:userId — giros disponíveis
app.get('/api/caixas-box/spins/:userId', requireAuth, async (req: AuthenticatedRequest, res) => {
  const userId = Number(req.params.userId)
  if (!userId || Number.isNaN(userId)) {
    res.status(400).json({ ok: false, error: 'ID inválido.' })
    return
  }
  try {
    await ensureCaixasBoxTables()
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT available_spins AS availableSpins, total_earned AS totalEarned, total_used AS totalUsed FROM user_caixas_box_spins WHERE user_id = ? LIMIT 1',
      [userId]
    )
    res.json({
      ok: true,
      availableSpins: Number(rows[0]?.availableSpins ?? 0),
      totalEarned: Number(rows[0]?.totalEarned ?? 0),
      totalUsed: Number(rows[0]?.totalUsed ?? 0),
    })
  } catch (err) {
    console.error('[caixas-box-spins]', err)
    res.status(500).json({ ok: false, error: 'Erro ao carregar giros.' })
  }
})

// GET /api/caixas-box/prizes — lista de prêmios ativos
app.get('/api/caixas-box/prizes', async (_req, res) => {
  try {
    await ensureCaixasBoxTables()
    const prizes = await loadActiveCaixasBoxPrizes()
    // Compatibilidade: retorna 'id' como prizeKey para o frontend legacy
    res.json({ ok: true, prizes: prizes.map((p) => ({ ...p, id: p.prizeKey })) })
  } catch (err) {
    console.error('[caixas-box-prizes]', err)
    res.status(500).json({ ok: false, error: 'Erro ao carregar prêmios.' })
  }
})

// POST /api/caixas-box/open — abre uma caixa (consome 1 giro)
app.post('/api/caixas-box/open', requireAuth, async (req: AuthenticatedRequest, res) => {
  const { userId } = req.body as { userId?: number }
  const parsedUserId = Number(userId)
  if (!parsedUserId || Number.isNaN(parsedUserId)) {
    res.status(400).json({ ok: false, error: 'ID inválido.' })
    return
  }

  await ensureCaixasBoxTables()
  const activePrizes = await loadActiveCaixasBoxPrizes()
  if (activePrizes.length === 0) {
    res.status(400).json({ ok: false, error: 'Nenhum prêmio ativo configurado.' })
    return
  }

  const picked = weightedRandomBox(activePrizes)

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    const [spinRows] = await conn.query<RowDataPacket[]>(
      'SELECT available_spins AS availableSpins FROM user_caixas_box_spins WHERE user_id = ? LIMIT 1 FOR UPDATE',
      [parsedUserId]
    )
    const availableSpins = Number(spinRows[0]?.availableSpins ?? 0)
    if (availableSpins <= 0) {
      await conn.rollback()
      res.status(400).json({ ok: false, error: 'Você não possui giros na Caixa Box.' })
      return
    }

    await conn.query(
      `UPDATE user_caixas_box_spins SET available_spins = available_spins - 1, total_used = total_used + 1, updated_at = NOW() WHERE user_id = ?`,
      [parsedUserId]
    )

    await conn.query(
      `INSERT INTO caixas_box_results (user_id, prize_id, prize_label, prize_type, prize_value) VALUES (?, ?, ?, ?, ?)`,
      [parsedUserId, picked.prizeKey, picked.label, picked.type, picked.value]
    )

    const [resultRows] = await conn.query<RowDataPacket[]>('SELECT LAST_INSERT_ID() AS insertId')
    const insertId = Number((resultRows as RowDataPacket[])[0]?.insertId ?? 0)

    if (picked.type === 'cash' && picked.value > 0) {
      await conn.query(
        `UPDATE users SET balance = COALESCE(balance, 0) + ? WHERE id = ?`,
        [picked.value, parsedUserId]
      )
    }

    await conn.commit()

    res.json({
      ok: true,
      prize: {
        id: insertId,
        prizeId: picked.prizeKey,
        prizeLabel: picked.label,
        prizeType: picked.type,
        prizeValue: picked.value,
        imageUrl: picked.imageUrl ?? null,
      },
      availableSpinsAfter: Math.max(availableSpins - 1, 0),
    })

    sendTelegramLog(
      `📦 <b>Caixa Box Aberta</b>\n` +
      `👤 Usuário ID: <code>${parsedUserId}</code>\n` +
      `🏆 Prêmio: <b>${picked.label}</b>\n` +
      `💰 Valor: R$ ${Number(picked.value.toFixed(2)).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}\n` +
      `📅 ${new Date().toLocaleString('pt-BR')}`
    ).catch(() => {})
  } catch (err) {
    await conn.rollback()
    console.error('[caixas-box-open]', err)
    res.status(500).json({ ok: false, error: 'Erro ao abrir caixa.' })
  } finally {
    conn.release()
  }
})

// GET /api/caixas-box/history/:userId — histórico de aberturas
app.get('/api/caixas-box/history/:userId', requireAuth, async (req: AuthenticatedRequest, res) => {
  const userId = Number(req.params.userId)
  if (!userId || Number.isNaN(userId)) {
    res.status(400).json({ ok: false, error: 'ID inválido.' })
    return
  }
  try {
    await ensureCaixasBoxTables()
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT id, prize_id AS prizeId, prize_label AS prizeLabel, prize_type AS prizeType, prize_value AS prizeValue, created_at AS createdAt
       FROM caixas_box_results WHERE user_id = ? ORDER BY id DESC LIMIT 50`,
      [userId]
    )
    res.json({
      ok: true,
      history: rows.map((r) => ({
        id: Number(r.id),
        prizeId: String(r.prizeId),
        prizeLabel: String(r.prizeLabel),
        prizeType: String(r.prizeType),
        prizeValue: Number(r.prizeValue),
        createdAt: r.createdAt,
      })),
    })
  } catch (err) {
    console.error('[caixas-box-history]', err)
    res.status(500).json({ ok: false, error: 'Erro ao carregar histórico.' })
  }
})

// ════════════════════════════════════════════════════════════════════════════
// SALDO DA LOJA (shop_balance) — separado do saldo da plataforma
// ════════════════════════════════════════════════════════════════════════════

// GET /api/shop/balance/:userId — consulta saldo da loja do usuário
app.get('/api/shop/balance/:userId', requireAuth, async (req: AuthenticatedRequest, res) => {
  const userId = Number(req.params.userId)
  if (!userId || Number.isNaN(userId)) {
    res.status(400).json({ ok: false, error: 'ID inválido.' })
    return
  }
  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      'SELECT shop_balance AS shopBalance FROM users WHERE id = ? LIMIT 1',
      [userId]
    )
    if (rows.length === 0) {
      res.status(404).json({ ok: false, error: 'Usuário não encontrado.' })
      return
    }
    res.json({ ok: true, shopBalance: Number(rows[0].shopBalance ?? 0) })
  } catch (err) {
    console.error('[shop-balance-get]', err)
    res.status(500).json({ ok: false, error: 'Erro ao consultar saldo da loja.' })
  }
})

// GET /api/shop/balance/:userId/history — histórico de transações do saldo da loja
app.get('/api/shop/balance/:userId/history', requireAuth, async (req: AuthenticatedRequest, res) => {
  const userId = Number(req.params.userId)
  if (!userId || Number.isNaN(userId)) {
    res.status(400).json({ ok: false, error: 'ID inválido.' })
    return
  }
  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT id, type, amount, reason, reference_id AS referenceId,
              old_balance AS oldBalance, new_balance AS newBalance, created_at AS createdAt
       FROM shop_balance_transactions
       WHERE user_id = ?
       ORDER BY id DESC
       LIMIT 50`,
      [userId]
    )
    res.json({
      ok: true,
      history: rows.map((r) => ({
        id: Number(r.id),
        type: String(r.type),
        amount: Number(r.amount),
        reason: String(r.reason ?? ''),
        referenceId: r.referenceId ? String(r.referenceId) : null,
        oldBalance: Number(r.oldBalance ?? 0),
        newBalance: Number(r.newBalance ?? 0),
        createdAt: r.createdAt,
      })),
    })
  } catch (err) {
    console.error('[shop-balance-history]', err)
    res.status(500).json({ ok: false, error: 'Erro ao carregar histórico.' })
  }
})

// POST /api/admin/shop/balance/credit — admin credita saldo da loja para um usuário
app.post('/api/admin/shop/balance/credit', requireMaxAdmin, async (req: AuthenticatedRequest, res) => {
  const { userId, amount, reason, referenceId } = req.body as {
    userId?: number
    amount?: number
    reason?: string
    referenceId?: string
  }

  const parsedUserId = Number(userId)
  const parsedAmount = Number(String(amount ?? '0').replace(',', '.'))

  if (!parsedUserId || Number.isNaN(parsedUserId)) {
    res.status(400).json({ ok: false, error: 'userId inválido.' })
    return
  }
  if (!parsedAmount || parsedAmount <= 0 || Number.isNaN(parsedAmount)) {
    res.status(400).json({ ok: false, error: 'Valor inválido. Deve ser maior que zero.' })
    return
  }

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    const [userRows] = await conn.query<RowDataPacket[]>(
      'SELECT id, shop_balance AS shopBalance FROM users WHERE id = ? LIMIT 1 FOR UPDATE',
      [parsedUserId]
    )
    if (userRows.length === 0) {
      await conn.rollback()
      res.status(404).json({ ok: false, error: 'Usuário não encontrado.' })
      return
    }

    const oldBalance = Number(userRows[0].shopBalance ?? 0)
    const newBalance = oldBalance + parsedAmount

    await conn.query(
      'UPDATE users SET shop_balance = ? WHERE id = ?',
      [newBalance, parsedUserId]
    )

    await conn.query(
      `INSERT INTO shop_balance_transactions
       (user_id, type, amount, reason, reference_id, old_balance, new_balance, created_by)
       VALUES (?, 'credit', ?, ?, ?, ?, ?, ?)`,
      [
        parsedUserId,
        parsedAmount,
        String(reason ?? 'Crédito manual pelo admin').trim(),
        referenceId ? String(referenceId).trim() : null,
        oldBalance,
        newBalance,
        req.authUser?.id ?? null,
      ]
    )

    await conn.commit()
    res.json({
      ok: true,
      message: `Saldo da loja creditado com sucesso.`,
      shopBalance: newBalance,
      credited: parsedAmount,
    })
  } catch (err) {
    await conn.rollback()
    console.error('[admin-shop-balance-credit]', err)
    res.status(500).json({ ok: false, error: 'Erro ao creditar saldo da loja.' })
  } finally {
    conn.release()
  }
})

// POST /api/admin/shop/balance/debit — admin debita saldo da loja (ajuste/correção)
app.post('/api/admin/shop/balance/debit', requireMaxAdmin, async (req: AuthenticatedRequest, res) => {
  const { userId, amount, reason, referenceId } = req.body as {
    userId?: number
    amount?: number
    reason?: string
    referenceId?: string
  }

  const parsedUserId = Number(userId)
  const parsedAmount = Number(String(amount ?? '0').replace(',', '.'))

  if (!parsedUserId || Number.isNaN(parsedUserId)) {
    res.status(400).json({ ok: false, error: 'userId inválido.' })
    return
  }
  if (!parsedAmount || parsedAmount <= 0 || Number.isNaN(parsedAmount)) {
    res.status(400).json({ ok: false, error: 'Valor inválido. Deve ser maior que zero.' })
    return
  }

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    const [userRows] = await conn.query<RowDataPacket[]>(
      'SELECT id, shop_balance AS shopBalance FROM users WHERE id = ? LIMIT 1 FOR UPDATE',
      [parsedUserId]
    )
    if (userRows.length === 0) {
      await conn.rollback()
      res.status(404).json({ ok: false, error: 'Usuário não encontrado.' })
      return
    }

    const oldBalance = Number(userRows[0].shopBalance ?? 0)
    if (parsedAmount > oldBalance) {
      await conn.rollback()
      res.status(400).json({ ok: false, error: `Saldo insuficiente. Saldo atual: R$ ${oldBalance.toFixed(2)}` })
      return
    }

    const newBalance = oldBalance - parsedAmount

    await conn.query(
      'UPDATE users SET shop_balance = ? WHERE id = ?',
      [newBalance, parsedUserId]
    )

    await conn.query(
      `INSERT INTO shop_balance_transactions
       (user_id, type, amount, reason, reference_id, old_balance, new_balance, created_by)
       VALUES (?, 'debit', ?, ?, ?, ?, ?, ?)`,
      [
        parsedUserId,
        parsedAmount,
        String(reason ?? 'Débito manual pelo admin').trim(),
        referenceId ? String(referenceId).trim() : null,
        oldBalance,
        newBalance,
        req.authUser?.id ?? null,
      ]
    )

    await conn.commit()
    res.json({
      ok: true,
      message: `Saldo da loja debitado com sucesso.`,
      shopBalance: newBalance,
      debited: parsedAmount,
    })
  } catch (err) {
    await conn.rollback()
    console.error('[admin-shop-balance-debit]', err)
    res.status(500).json({ ok: false, error: 'Erro ao debitar saldo da loja.' })
  } finally {
    conn.release()
  }
})

// GET /api/admin/shop/balance/users — lista usuários com saldo da loja > 0 (admin)
app.get('/api/admin/shop/balance/users', requireMaxAdmin, async (_req: AuthenticatedRequest, res) => {
  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT id, name, phone, shop_balance AS shopBalance
       FROM users
       WHERE shop_balance > 0
       ORDER BY shop_balance DESC
       LIMIT 200`
    )
    res.json({
      ok: true,
      users: rows.map((r) => ({
        id: Number(r.id),
        name: String(r.name ?? ''),
        phone: String(r.phone ?? ''),
        shopBalance: Number(r.shopBalance ?? 0),
      })),
    })
  } catch (err) {
    console.error('[admin-shop-balance-users]', err)
    res.status(500).json({ ok: false, error: 'Erro ao listar usuários.' })
  }
})

// POST /api/shop/purchase — usuário consome saldo da loja para comprar gift card
app.post('/api/shop/purchase', requireAuth, async (req: AuthenticatedRequest, res) => {
  const { userId, amount, productName, referenceId } = req.body as {
    userId?: number
    amount?: number
    productName?: string
    referenceId?: string
  }

  const parsedUserId  = Number(userId)
  const parsedAmount  = Number(String(amount ?? '0').replace(',', '.'))
  const parsedProdId  = referenceId ? Number(referenceId) : 0

  if (!parsedUserId || Number.isNaN(parsedUserId)) {
    res.status(400).json({ ok: false, error: 'userId inválido.' })
    return
  }
  if (!parsedAmount || parsedAmount <= 0 || Number.isNaN(parsedAmount)) {
    res.status(400).json({ ok: false, error: 'Valor inválido.' })
    return
  }
  if (!productName || !String(productName).trim()) {
    res.status(400).json({ ok: false, error: 'Nome do produto obrigatório.' })
    return
  }

  const conn = await pool.getConnection()
  try {
    await conn.beginTransaction()

    // 1. Verifica saldo do usuário
    const [userRows] = await conn.query<RowDataPacket[]>(
      'SELECT id, shop_balance AS shopBalance FROM users WHERE id = ? LIMIT 1 FOR UPDATE',
      [parsedUserId]
    )
    if (userRows.length === 0) {
      await conn.rollback()
      res.status(404).json({ ok: false, error: 'Usuário não encontrado.' })
      return
    }

    const oldBalance = Number(userRows[0].shopBalance ?? 0)
    if (parsedAmount > oldBalance) {
      await conn.rollback()
      res.status(400).json({
        ok: false,
        error: `Saldo insuficiente na loja. Saldo atual: R$ ${oldBalance.toFixed(2)}`,
      })
      return
    }

    // 2. Busca produto e dados para o gift card
    let prodImageUrl: string | null = null
    let prodPlatform: string | null = null
    if (parsedProdId > 0) {
      const [prodRows] = await conn.query<RowDataPacket[]>(
        'SELECT image_url, platform FROM shop_products WHERE id = ? LIMIT 1',
        [parsedProdId]
      )
      if (prodRows.length > 0) {
        prodImageUrl = prodRows[0].image_url ?? null
        prodPlatform = prodRows[0].platform ?? null
      }
    }

    // 3. Tenta reservar um código do estoque (se houver)
    let deliveredCode: string | null = null
    let codeId: number | null = null
    if (parsedProdId > 0) {
      const [codeRows] = await conn.query<RowDataPacket[]>(
        `SELECT id, code FROM shop_product_codes
         WHERE product_id = ? AND status = 'available'
         ORDER BY id ASC LIMIT 1 FOR UPDATE`,
        [parsedProdId]
      )
      if (codeRows.length > 0) {
        deliveredCode = String(codeRows[0].code)
        codeId        = Number(codeRows[0].id)
        // Marca código como usado
        await conn.query(
          `UPDATE shop_product_codes
           SET status = 'used', used_by = ?, used_at = NOW()
           WHERE id = ?`,
          [parsedUserId, codeId]
        )
      }
    }

    // 4. Debita saldo
    const newBalance = oldBalance - parsedAmount
    await conn.query(
      'UPDATE users SET shop_balance = ? WHERE id = ?',
      [newBalance, parsedUserId]
    )

    // 5. Registra transação
    await conn.query(
      `INSERT INTO shop_balance_transactions
       (user_id, type, amount, reason, reference_id, old_balance, new_balance, created_by)
       VALUES (?, 'debit', ?, ?, ?, ?, ?, NULL)`,
      [
        parsedUserId,
        parsedAmount,
        `Compra: ${String(productName).trim()}`,
        referenceId ? String(referenceId).trim() : null,
        oldBalance,
        newBalance,
      ]
    )

    // 6. Registra gift card entregue (com ou sem código)
    let giftCardId: number | null = null
    try {
      await ensureGiftCardsTable()
      const [gcResult] = await conn.query<ResultSetHeader>(
        `INSERT INTO gift_cards (user_id, name, platform, value, code, image_url)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          parsedUserId,
          String(productName).trim(),
          prodPlatform ?? null,
          parsedAmount,
          deliveredCode ?? '(código pendente)',
          prodImageUrl ?? null,
        ]
      )
      giftCardId = gcResult.insertId
    } catch {
      // tabela gift_cards pode não existir — não bloqueia a compra
    }

    await conn.commit()

    res.json({
      ok:           true,
      message:      deliveredCode
        ? 'Compra realizada! Seu código foi entregue nos Gift Cards.'
        : 'Compra realizada! Um código será entregue em breve.',
      shopBalance:  newBalance,
      spent:        parsedAmount,
      code:         deliveredCode,
      giftCardId,
    })
  } catch (err) {
    await conn.rollback()
    console.error('[shop-purchase]', err)
    res.status(500).json({ ok: false, error: 'Erro ao processar compra.' })
  } finally {
    conn.release()
  }
})

// ─── GIFT CARDS DA LOJA ──────────────────────────────────────────────────────

// Garante a tabela gift_cards existe
async function ensureGiftCardsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gift_cards (
      id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id    INT UNSIGNED NOT NULL,
      name       VARCHAR(200) NOT NULL,
      platform   VARCHAR(100) NULL,
      value      DECIMAL(12,2) NOT NULL DEFAULT 0,
      code       VARCHAR(500) NOT NULL,
      status     ENUM('disponivel','usado') NOT NULL DEFAULT 'disponivel',
      image_url  VARCHAR(500) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_user (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
}
ensureGiftCardsTable().catch(err => console.error('[gift_cards table]', err))

// GET /api/shop/giftcards/:userId — gift cards do usuário
app.get('/api/shop/giftcards/:userId', requireAuth, async (req: AuthenticatedRequest, res) => {
  const userId = Number(req.params.userId)
  if (!userId || Number.isNaN(userId)) {
    res.status(400).json({ ok: false, error: 'ID inválido.' })
    return
  }
  try {
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT id, user_id AS userId, name, platform, value, code, status,
              image_url AS imageUrl, created_at AS createdAt
       FROM gift_cards WHERE user_id = ? ORDER BY created_at DESC`,
      [userId]
    )
    res.json(rows)
  } catch {
    res.json([])
  }
})

// POST /api/admin/shop/giftcards — admin entrega gift card para usuário
app.post('/api/admin/shop/giftcards', requireMaxAdmin, async (req: AuthenticatedRequest, res) => {
  const { userId, name, platform, value, code, imageUrl } = req.body as {
    userId?: number; name?: string; platform?: string
    value?: number; code?: string; imageUrl?: string
  }
  if (!userId || !name || !code || !value) {
    res.status(400).json({ ok: false, error: 'userId, name, code e value são obrigatórios.' })
    return
  }
  try {
    await ensureGiftCardsTable()
    const [result] = await pool.query<ResultSetHeader>(
      'INSERT INTO gift_cards (user_id, name, platform, value, code, image_url) VALUES (?, ?, ?, ?, ?, ?)',
      [userId, name, platform ?? null, value, code, imageUrl ?? null]
    )
    res.status(201).json({ ok: true, id: (result as any).insertId })
  } catch (err) {
    console.error('[giftcard-create]', err)
    res.status(500).json({ ok: false, error: 'Erro ao criar gift card.' })
  }
})

// PATCH /api/admin/shop/giftcards/:id/usado — marcar como usado
app.patch('/api/admin/shop/giftcards/:id/usado', requireMaxAdmin, async (req: AuthenticatedRequest, res) => {
  const id = Number(req.params.id)
  await pool.query('UPDATE gift_cards SET status = "usado" WHERE id = ?', [id])
  res.json({ ok: true })
})

// ─── PRODUTOS DA LOJA (catálogo) ─────────────────────────────────────────────

async function ensureShopProductsTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shop_products (
      id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      name        VARCHAR(200)   NOT NULL,
      platform    VARCHAR(100)   NOT NULL DEFAULT '',
      description TEXT           NULL,
      price       DECIMAL(12,2)  NOT NULL DEFAULT 0,
      image_url   VARCHAR(500)   NULL,
      category    VARCHAR(100)   NOT NULL DEFAULT 'outros',
      is_active   TINYINT(1)     NOT NULL DEFAULT 1,
      sort_order  INT            NOT NULL DEFAULT 0,
      created_at  DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at  DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_active (is_active),
      INDEX idx_sort   (sort_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
}
ensureShopProductsTable().catch(err => console.error('[shop_products table]', err))

// GET /api/shop/products — lista pública (ativos)
app.get('/api/shop/products', async (_req, res) => {
  try {
    await ensureShopProductsTable()
    await ensureShopProductCodesTable()
    const [rows] = await pool.query<RowDataPacket[]>(`
      SELECT p.id, p.name, p.platform, p.description, p.price,
             p.image_url AS imageUrl, p.category, p.sort_order AS sortOrder,
             COALESCE(s.available, 0) AS stockCount
      FROM shop_products p
      LEFT JOIN (
        SELECT product_id, COUNT(*) AS available
        FROM shop_product_codes
        WHERE status = 'available'
        GROUP BY product_id
      ) s ON s.product_id = p.id
      WHERE p.is_active = 1
      ORDER BY p.sort_order ASC, p.id ASC
    `)
    res.json({ ok: true, products: rows })
  } catch (err) {
    console.error('[shop-products-get]', err)
    res.status(500).json({ ok: false, error: 'Erro ao carregar produtos.' })
  }
})

// GET /api/admin/shop/products — lista admin (todos)
app.get('/api/admin/shop/products', requireMaxAdmin, async (_req, res) => {
  try {
    await ensureShopProductsTable()
    const [rows] = await pool.query<RowDataPacket[]>(`
      SELECT id, name, platform, description, price,
             image_url AS imageUrl, category, is_active AS isActive,
             sort_order AS sortOrder, created_at AS createdAt
      FROM shop_products
      ORDER BY sort_order ASC, id ASC
    `)
    res.json({ ok: true, products: rows })
  } catch (err) {
    console.error('[admin-shop-products-get]', err)
    res.status(500).json({ ok: false, error: 'Erro ao carregar produtos.' })
  }
})

// POST /api/admin/shop/products — criar produto
app.post('/api/admin/shop/products', requireMaxAdmin, async (req, res) => {
  const { name, platform, description, price, imageUrl, category, isActive, sortOrder } = req.body as {
    name?: string; platform?: string; description?: string
    price?: number | string; imageUrl?: string; category?: string
    isActive?: boolean | number; sortOrder?: number | string
  }

  const parsedName = String(name ?? '').trim()
  if (!parsedName) {
    res.status(400).json({ ok: false, error: 'Nome é obrigatório.' })
    return
  }
  const parsedPrice = Math.max(0, Number(String(price ?? '0').replace(',', '.')))
  if (!Number.isFinite(parsedPrice)) {
    res.status(400).json({ ok: false, error: 'Preço inválido.' })
    return
  }

  try {
    await ensureShopProductsTable()
    const [result] = await pool.query<ResultSetHeader>(
      `INSERT INTO shop_products (name, platform, description, price, image_url, category, is_active, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        parsedName,
        String(platform ?? '').trim(),
        String(description ?? '').trim() || null,
        parsedPrice,
        String(imageUrl ?? '').trim() || null,
        String(category ?? 'outros').trim(),
        isActive === false || Number(isActive) === 0 ? 0 : 1,
        Number(sortOrder ?? 0),
      ]
    )
    res.status(201).json({ ok: true, id: result.insertId })
  } catch (err) {
    console.error('[admin-shop-products-post]', err)
    res.status(500).json({ ok: false, error: 'Erro ao criar produto.' })
  }
})

// PUT /api/admin/shop/products/:id — editar produto
app.put('/api/admin/shop/products/:id', requireMaxAdmin, async (req, res) => {
  const id = Number(req.params.id)
  if (!id || id <= 0) {
    res.status(400).json({ ok: false, error: 'ID inválido.' })
    return
  }

  const { name, platform, description, price, imageUrl, category, isActive, sortOrder } = req.body as {
    name?: string; platform?: string; description?: string
    price?: number | string; imageUrl?: string; category?: string
    isActive?: boolean | number; sortOrder?: number | string
  }

  const parsedName = String(name ?? '').trim()
  if (!parsedName) {
    res.status(400).json({ ok: false, error: 'Nome é obrigatório.' })
    return
  }
  const parsedPrice = Math.max(0, Number(String(price ?? '0').replace(',', '.')))

  try {
    await ensureShopProductsTable()
    const [result] = await pool.query<ResultSetHeader>(
      `UPDATE shop_products
       SET name=?, platform=?, description=?, price=?, image_url=?, category=?, is_active=?, sort_order=?
       WHERE id=?`,
      [
        parsedName,
        String(platform ?? '').trim(),
        String(description ?? '').trim() || null,
        parsedPrice,
        String(imageUrl ?? '').trim() || null,
        String(category ?? 'outros').trim(),
        isActive === false || Number(isActive) === 0 ? 0 : 1,
        Number(sortOrder ?? 0),
        id,
      ]
    )
    if (result.affectedRows === 0) {
      res.status(404).json({ ok: false, error: 'Produto não encontrado.' })
      return
    }
    res.json({ ok: true })
  } catch (err) {
    console.error('[admin-shop-products-put]', err)
    res.status(500).json({ ok: false, error: 'Erro ao atualizar produto.' })
  }
})

// DELETE /api/admin/shop/products/:id — remover produto
app.delete('/api/admin/shop/products/:id', requireMaxAdmin, async (req, res) => {
  const id = Number(req.params.id)
  if (!id || id <= 0) {
    res.status(400).json({ ok: false, error: 'ID inválido.' })
    return
  }
  try {
    await ensureShopProductsTable()
    const [result] = await pool.query<ResultSetHeader>(
      'DELETE FROM shop_products WHERE id = ?', [id]
    )
    if (result.affectedRows === 0) {
      res.status(404).json({ ok: false, error: 'Produto não encontrado.' })
      return
    }
    res.json({ ok: true })
  } catch (err) {
    console.error('[admin-shop-products-delete]', err)
    res.status(500).json({ ok: false, error: 'Erro ao remover produto.' })
  }
})

// ─── ESTOQUE DE CÓDIGOS DOS PRODUTOS DA LOJA ─────────────────────────────────

async function ensureShopProductCodesTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shop_product_codes (
      id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      product_id BIGINT UNSIGNED NOT NULL,
      code       VARCHAR(500) NOT NULL,
      status     ENUM('available','used') NOT NULL DEFAULT 'available',
      used_by    BIGINT UNSIGNED NULL,
      used_at    DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_product_status (product_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)
}
ensureShopProductCodesTable().catch(err => console.error('[shop_product_codes table]', err))

// GET /api/admin/shop/products/:id/codes — lista códigos de um produto
app.get('/api/admin/shop/products/:id/codes', requireMaxAdmin, async (req, res) => {
  const productId = Number(req.params.id)
  if (!productId || productId <= 0) {
    res.status(400).json({ ok: false, error: 'ID inválido.' })
    return
  }
  try {
    await ensureShopProductCodesTable()
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT id, code, status, used_by AS usedBy, used_at AS usedAt, created_at AS createdAt
       FROM shop_product_codes
       WHERE product_id = ?
       ORDER BY id ASC`,
      [productId]
    )
    const available = rows.filter((r) => r.status === 'available').length
    const used      = rows.filter((r) => r.status === 'used').length
    res.json({ ok: true, codes: rows, available, used, total: rows.length })
  } catch (err) {
    console.error('[shop-product-codes-get]', err)
    res.status(500).json({ ok: false, error: 'Erro ao carregar códigos.' })
  }
})

// POST /api/admin/shop/products/:id/codes — adiciona códigos ao estoque
app.post('/api/admin/shop/products/:id/codes', requireMaxAdmin, async (req, res) => {
  const productId = Number(req.params.id)
  if (!productId || productId <= 0) {
    res.status(400).json({ ok: false, error: 'ID inválido.' })
    return
  }
  const { codes } = req.body as { codes?: string | string[] }
  // aceita array, string separada por vírgula ou por quebra de linha
  let rawList: string[]
  if (Array.isArray(codes)) {
    rawList = codes
  } else {
    const s = String(codes ?? '')
    // se tiver vírgula, separa por vírgula; senão por linha
    rawList = s.includes(',') ? s.split(',') : s.split('\n')
  }
  const codeList = rawList.map((c) => c.trim()).filter((c) => c.length > 0)
  if (codeList.length === 0) {
    res.status(400).json({ ok: false, error: 'Nenhum código válido fornecido.' })
    return
  }
  try {
    await ensureShopProductCodesTable()
    // Verifica se produto existe
    const [prod] = await pool.query<RowDataPacket[]>(
      'SELECT id FROM shop_products WHERE id = ? LIMIT 1', [productId]
    )
    if (prod.length === 0) {
      res.status(404).json({ ok: false, error: 'Produto não encontrado.' })
      return
    }
    // Insere todos os códigos
    const values = codeList.map((c) => [productId, c])
    await pool.query(
      'INSERT INTO shop_product_codes (product_id, code) VALUES ?',
      [values]
    )
    res.status(201).json({ ok: true, added: codeList.length })
  } catch (err) {
    console.error('[shop-product-codes-post]', err)
    res.status(500).json({ ok: false, error: 'Erro ao adicionar códigos.' })
  }
})

// DELETE /api/admin/shop/products/codes/:codeId — remove um código
app.delete('/api/admin/shop/products/codes/:codeId', requireMaxAdmin, async (req, res) => {
  const codeId = Number(req.params.codeId)
  if (!codeId || codeId <= 0) {
    res.status(400).json({ ok: false, error: 'ID inválido.' })
    return
  }
  try {
    await ensureShopProductCodesTable()
    await pool.query('DELETE FROM shop_product_codes WHERE id = ? AND status = "available"', [codeId])
    res.json({ ok: true })
  } catch (err) {
    console.error('[shop-product-codes-delete]', err)
    res.status(500).json({ ok: false, error: 'Erro ao remover código.' })
  }
})

// GET /api/admin/shop/products/:id/codes/count — conta disponíveis (para exibir no formulário)
app.get('/api/admin/shop/products/:id/codes/count', requireMaxAdmin, async (req, res) => {
  const productId = Number(req.params.id)
  if (!productId || productId <= 0) {
    res.status(400).json({ ok: false, error: 'ID inválido.' })
    return
  }
  try {
    await ensureShopProductCodesTable()
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT
        COUNT(*) AS total,
        SUM(status = 'available') AS available,
        SUM(status = 'used') AS used
       FROM shop_product_codes WHERE product_id = ?`,
      [productId]
    )
    const r = rows[0]
    res.json({ ok: true, total: Number(r.total), available: Number(r.available ?? 0), used: Number(r.used ?? 0) })
  } catch (err) {
    console.error('[shop-product-codes-count]', err)
    res.status(500).json({ ok: false, error: 'Erro ao contar códigos.' })
  }
})

// ─── 404 — rota não encontrada ───────────────────────────────────────────────
app.use((req, res) => {
  console.warn(`[404] ${req.method} ${req.originalUrl} — rota não encontrada`)
  res.status(404).json({ ok: false, error: `Rota não encontrada: ${req.method} ${req.originalUrl}` })
})

// ─── Erro global — captura qualquer exceção não tratada nas rotas ─────────────
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  console.error(`[500] ${req.method} ${req.originalUrl}`, err)
  res.status(500).json({ ok: false, error: 'Erro interno do servidor.' })
})

io.on('connection', (socket) => {
  console.log(`[ws] client connected: ${socket.id}`)

  // Envia o count atual + lista de IDs imediatamente para o cliente que acabou de conectar
  const cutoff = Date.now() - PRESENCE_TTL_MS
  let currentCount = 0
  const currentOnlineIds: number[] = []
  for (const [key, ts] of onlinePresence.entries()) {
    if (ts >= cutoff) {
      currentCount++
      const num = Number(key)
      if (!isNaN(num) && num > 0) currentOnlineIds.push(num)
    }
  }
  socket.emit('online-count', { onlineCount: currentCount, onlineUserIds: currentOnlineIds })

  socket.on('telegram:subscribe', (payload: { userId?: number }) => {
    const userId = Number(payload?.userId ?? 0)
    if (!userId || Number.isNaN(userId)) return
    socket.join(`user:${userId}`)
  })

  socket.on('disconnect', () => {
    console.log(`[ws] client disconnected: ${socket.id}`)
  })
})

httpServer.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`)
  console.log('📋 HTTP request logging: enabled')
  console.log('🧯 Global error logging: enabled')
  console.log('🔌 WebSocket enabled')
})
