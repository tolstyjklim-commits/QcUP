// Приём TON: пользователь переводит на ваш адрес с уникальным комментарием (memo),
// сервер раз в несколько секунд читает входящие транзакции через toncenter и зачисляет монеты.
// Работает на обычном VPS: нужен только исходящий доступ к toncenter.com, вебхуки и публичный адрес не нужны.
import crypto from 'node:crypto'
import type { Express } from 'express'
import type { PrismaClient } from '@prisma/client'
import { requireTelegramAuth } from './telegram.js'

const NANO = 1_000_000_000n
const cfg = () => ({
  address: process.env.TON_DEPOSIT_ADDRESS || '',
  apiUrl: (process.env.TONCENTER_URL || 'https://toncenter.com/api/v2').replace(/\/$/, ''),
  apiKey: process.env.TONCENTER_API_KEY || '',
  coinsPerTon: Number(process.env.COINS_PER_TON || 150),
  minTon: Number(process.env.MIN_DEPOSIT_TON || 0.1),
  maxTon: Number(process.env.MAX_DEPOSIT_TON || 1000),
  ttlMin: Number(process.env.DEPOSIT_TTL_MIN || 60),
  pollMs: Number(process.env.TON_POLL_MS || 10_000),
  coinsPerUsdt: Number(process.env.COINS_PER_USDT || 100),
  minUsdt: Number(process.env.MIN_DEPOSIT_USDT || 1),
  maxUsdt: Number(process.env.MAX_DEPOSIT_USDT || 5000),
  usdtMaster: process.env.USDT_JETTON_MASTER || 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs', // USDT в сети TON
  v3Url: (process.env.TONCENTER_V3_URL || 'https://toncenter.com/api/v3').replace(/\/$/, ''),
})

// 1 монета = 1 Star. Star в USDT: публичный API по сделкам Fragment; TON/USD: CoinGecko. Кэш 1 минута, запасные значения из .env
let rateCache: { ton: number; usdt: number; at: number } | null = null
async function liveRates() {
  const c = cfg()
  if (rateCache && Date.now() - rateCache.at < 60_000) return rateCache
  let starUsd = Number(process.env.STAR_USD || 0.015), tonUsd = Number(process.env.TON_USD || 0)
  try { const j: any = await (await fetch('https://bes-dev.github.io/telegram_stars_rates/api.json')).json(); if (j.usdt_per_star > 0) starUsd = Number(j.usdt_per_star) } catch { /* запасной */ }
  try { const j: any = await (await fetch('https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd')).json(); if (j['the-open-network']?.usd > 0) tonUsd = Number(j['the-open-network'].usd) } catch { /* запасной */ }
  rateCache = { ton: tonUsd > 0 ? Math.floor(tonUsd / starUsd) : c.coinsPerTon, usdt: Math.floor(1 / starUsd), at: Date.now() }
  return rateCache
}

const toNano = (ton: number) => BigInt(Math.round(ton * 1e9))
const coinsFor = (nano: bigint, perTon: number) => (nano * BigInt(Math.round(perTon * 100))) / (NANO * 100n)

type TonTx = { transaction_id?: { hash?: string }; in_msg?: { source?: string; value?: string; message?: string } }

async function fetchIncoming(): Promise<TonTx[]> {
  const c = cfg()
  const r = await fetch(`${c.apiUrl}/getTransactions?address=${encodeURIComponent(c.address)}&limit=50&archival=true`, {
    headers: c.apiKey ? { 'X-API-Key': c.apiKey } : {},
  })
  if (!r.ok) throw new Error(`toncenter ${r.status}`)
  const j = (await r.json()) as { ok: boolean; result?: TonTx[]; error?: string }
  if (!j.ok) throw new Error(j.error || 'toncenter error')
  return j.result || []
}

async function credit(prisma: PrismaClient, dep: { id: string; userId: string; memo: string; status: string; asset: string; rate: number | null } | null, paid: bigint, hash: string) {
  const c = cfg()
  if (!dep || dep.status === 'credited' || paid <= 0n) return
  const r = dep.rate ?? (dep.asset === 'USDT' ? c.coinsPerUsdt : c.coinsPerTon)
  const coins = dep.asset === 'USDT' ? (paid * BigInt(Math.round(r * 100))) / (1_000_000n * 100n) : coinsFor(paid, r)
  await prisma.$transaction(async tx => {
    // updateMany с условием status != credited: второй параллельный проход ничего не обновит
    const done = await tx.deposit.updateMany({
      where: { id: dep.id, status: { not: 'credited' } },
      data: { status: 'credited', paidNano: paid, coins, txHash: hash, creditedAt: new Date() },
    })
    if (done.count !== 1) return
    await tx.wallet.update({ where: { userId: dep.userId }, data: { balance: { increment: coins } } })
    await tx.transaction.create({ data: { userId: dep.userId, amount: coins, type: dep.asset === 'USDT' ? 'deposit_usdt' : 'deposit_ton', status: 'done', description: dep.asset === 'USDT' ? `USDT ${Number(paid) / 1e6}` : `TON ${Number(paid) / 1e9}` } })
  })
  console.log(`[ton] зачислено ${coins} монет (${dep.asset}), memo ${dep.memo}, tx ${hash}`)
}

// Адрес вида EQ…/UQ… -> «сырой» 0:hex, как отдаёт toncenter v3
function toRaw(a: string): string {
  if (/^-?\d+:[0-9a-fA-F]{64}$/.test(a)) return a.toLowerCase()
  const b = Buffer.from(a.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  return b.length === 36 ? `${(b[1] === 0xff ? -1 : b[1])}:${b.subarray(2, 34).toString('hex')}` : a
}

// USDT (jetton): у переводов нет надёжного комментария, поэтому платёж опознаётся по уникальной сумме
async function pollUsdt(prisma: PrismaClient) {
  const c = cfg()
  const r = await fetch(`${c.v3Url}/jetton/transfers?owner_address=${encodeURIComponent(c.address)}&direction=in&limit=50&sort=desc`, {
    headers: c.apiKey ? { 'X-API-Key': c.apiKey } : {},
  })
  if (!r.ok) throw new Error(`toncenter v3 ${r.status}`)
  const j = (await r.json()) as { jetton_transfers?: { transaction_hash: string; amount: string; jetton_master: string; transaction_aborted?: boolean }[] }
  const master = toRaw(c.usdtMaster)
  for (const t of j.jetton_transfers || []) {
    if (t.transaction_aborted || toRaw(t.jetton_master) !== master) continue
    const paid = BigInt(t.amount)
    const dep = await prisma.deposit.findFirst({ where: { asset: 'USDT', status: 'pending', amountNano: paid, expiresAt: { gt: new Date(Date.now() - 10 * 60_000) } } })
    await credit(prisma, dep, paid, t.transaction_hash)
  }
}

async function pollOnce(prisma: PrismaClient) {
  for (const t of await fetchIncoming()) {
    const m = t.in_msg
    const hash = t.transaction_id?.hash
    if (!m?.source || !m.message || !hash) continue // исходящие и переводы без комментария пропускаем
    const memo = m.message.trim()
    if (!/^qc-[a-z0-9]{12}$/.test(memo)) continue
    await credit(prisma, await prisma.deposit.findUnique({ where: { memo } }), BigInt(m.value || '0'), hash)
  }
  await pollUsdt(prisma)
  await prisma.deposit.updateMany({ where: { status: 'pending', expiresAt: { lt: new Date() } }, data: { status: 'expired' } })
}

export function mountTon(app: Express, prisma: PrismaClient) {
  const c = cfg()
  if (!c.address) { console.log('[ton] TON_DEPOSIT_ADDRESS не задан: приём TON выключен'); return }
  let busy = false
  setInterval(async () => {
    if (busy) return
    busy = true
    try { await pollOnce(prisma) } catch (e) { console.warn('[ton] опрос не удался:', (e as Error).message) } finally { busy = false }
  }, c.pollMs)
  console.log(`[ton] приём TON включён, адрес ${c.address.slice(0, 6)}…${c.address.slice(-4)}`)

  app.get('/api/deposit/config', async (_req, res) => {
    const k = cfg()
    res.json({ enabled: true, address: k.address, coinsPerTon: (await liveRates()).ton, minTon: k.minTon, maxTon: k.maxTon, ttlMin: k.ttlMin, usdt: { master: k.usdtMaster, coinsPerUsdt: (await liveRates()).usdt, min: k.minUsdt, max: k.maxUsdt } })
  })

  app.post('/api/deposit/ton', requireTelegramAuth, async (req, res) => {
    const k = cfg()
    const tg = req.telegramUser!
    const asset = req.body?.asset === 'USDT' ? 'USDT' : 'TON'
    const ton = req.body?.amountTon === undefined ? undefined : Number(req.body.amountTon)
    const usdt = Number(req.body?.amountUsdt)
    if (asset === 'TON' && ton !== undefined && (!Number.isFinite(ton) || ton < k.minTon || ton > k.maxTon)) {
      return res.status(400).json({ error: `Сумма от ${k.minTon} до ${k.maxTon} TON` })
    }
    if (asset === 'USDT' && (!Number.isFinite(usdt) || usdt < k.minUsdt || usdt > k.maxUsdt)) {
      return res.status(400).json({ error: `Сумма от ${k.minUsdt} до ${k.maxUsdt} USDT` })
    }
    const user = await prisma.user.upsert({
      where: { telegramId: String(tg.id) },
      update: {},
      create: { telegramId: String(tg.id), username: tg.username, firstName: tg.first_name, photoUrl: tg.photo_url, wallet: { create: { balance: 0n } } },
    })
    const pending = await prisma.deposit.count({ where: { userId: user.id, status: 'pending', expiresAt: { gt: new Date() } } })
    if (pending >= 5) return res.status(429).json({ error: 'Слишком много незавершённых пополнений, подожди или оплати существующие' })
    const memo = 'qc-' + crypto.randomBytes(9).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '').padEnd(12, '0').slice(0, 12)
    // USDT: добавляем к сумме 1..9999 микро-USDT (до $0.01), чтобы у каждого ожидающего платежа была своя точная сумма
    let amountNano: bigint | null = ton ? toNano(ton) : null
    if (asset === 'USDT') {
      const base = BigInt(Math.round(usdt * 100)) * 10_000n
      for (let i = 0; i < 20; i++) {
        const cand = base + BigInt(1 + crypto.randomInt(9999))
        if (!(await prisma.deposit.findFirst({ where: { asset: 'USDT', status: 'pending', amountNano: cand } }))) { amountNano = cand; break }
      }
      if (!amountNano) return res.status(503).json({ error: 'Попробуйте ещё раз' })
    }
    const rates = await liveRates()
    const dep = await prisma.deposit.create({
      data: { userId: user.id, asset, memo, amountNano, rate: asset === 'USDT' ? rates.usdt : rates.ton, expiresAt: new Date(Date.now() + k.ttlMin * 60_000) },
    })
    res.json({ memo: dep.memo, asset, address: k.address, amountNano: dep.amountNano?.toString() ?? null, expiresAt: dep.expiresAt, coinsPerTon: k.coinsPerTon, jettonMaster: asset === 'USDT' ? k.usdtMaster : null })
  })

  // Монеты за зачисленные платежи забирает клиент и добавляет в баланс игр; claimedAt гарантирует, что это произойдёт один раз
  app.get('/api/deposit/unclaimed', requireTelegramAuth, async (req, res) => {
    const rows = await prisma.deposit.findMany({
      where: { status: 'credited', claimedAt: null, user: { telegramId: String(req.telegramUser!.id) } },
      select: { id: true, coins: true, asset: true },
    })
    res.json(rows.map(r => ({ id: r.id, coins: r.coins?.toString() ?? '0', asset: r.asset })))
  })

  app.post('/api/deposit/claim', requireTelegramAuth, async (req, res) => {
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids.filter((x: unknown) => typeof x === 'string').slice(0, 50) : []
    let total = 0n
    for (const id of ids) {
      const dep = await prisma.deposit.findFirst({ where: { id, status: 'credited', claimedAt: null, user: { telegramId: String(req.telegramUser!.id) } } })
      if (!dep) continue
      const done = await prisma.deposit.updateMany({ where: { id, claimedAt: null }, data: { claimedAt: new Date() } })
      if (done.count === 1) total += dep.coins ?? 0n
    }
    res.json({ coins: total.toString() })
  })

  app.get('/api/deposit/ton/:memo', requireTelegramAuth, async (req, res) => {
    const dep = await prisma.deposit.findUnique({ where: { memo: req.params.memo }, include: { user: true } })
    if (!dep || dep.user.telegramId !== String(req.telegramUser!.id)) return res.status(404).json({ error: 'not found' })
    const w = await prisma.wallet.findUnique({ where: { userId: dep.userId } })
    res.json({ status: dep.status, coins: dep.coins?.toString() ?? null, balance: w?.balance.toString() ?? '0' })
  })
}
