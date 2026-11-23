import { useEffect, useRef, useState } from 'react'
import { Copy, ExternalLink, X } from 'lucide-react'
import { DEMO, money } from './lib'
import { TonIcon, UsdtIcon } from './art'

// ---------------------------------------------------------------------------------------------
// Пополнение: TON, USDT в сети TON, USDT в сети TRON (TRC20).
// Адреса кошельков и лимиты берутся из config.json (его делает admin.html), запасной вариант: переменные VITE_*.
// Режим без сервера (GitHub Pages): сайт сам ищет платёж в блокчейне. С бэкендом (VITE_API_URL) проверку делает сервер.
// ---------------------------------------------------------------------------------------------
const env = (import.meta as any).env || {}
const raw = env.VITE_API_URL as string | undefined
const API = raw === 'same' ? '' : raw?.replace(/\/$/, '')
const LOCAL = API === undefined

export type Method = 'TON' | 'USDT_TON' | 'USDT_TRC20'
export const METHOD_LABEL: Record<Method, string> = { TON: 'TON', USDT_TON: 'USDT (сеть TON)', USDT_TRC20: 'USDT (сеть TRON, TRC20)' }
const USDT_TRC20_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const USDT_TON_MASTER = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs'

type SiteCfg = {
  tonAddress: string; trc20Address: string; toncenterKey: string; tronKey: string
  methods: Record<Method, boolean>
  min: { ton: number; usdt: number }; max: { ton: number; usdt: number }
  ttlMin: number; starUsd: number; tonUsd: number; demoHash: string
}
const defaults = (): SiteCfg => ({
  tonAddress: env.VITE_TON_ADDRESS || '', trc20Address: env.VITE_TRC20_ADDRESS || '',
  toncenterKey: env.VITE_TONCENTER_KEY || '', tronKey: env.VITE_TRONGRID_KEY || '',
  methods: { TON: true, USDT_TON: true, USDT_TRC20: true },
  min: { ton: 0.1, usdt: 1 }, max: { ton: 1000, usdt: 5000 }, ttlMin: 60,
  starUsd: Number(env.VITE_STAR_USD || 0.015), tonUsd: Number(env.VITE_TON_USD || 0), demoHash: '',
})
let cfgP: Promise<SiteCfg> | null = null
export function siteConfig(): Promise<SiteCfg> {
  if (cfgP) return cfgP
  cfgP = (async () => {
    const base = defaults()
    const merge = (j: any) => {
      if (!j || typeof j !== 'object') return
      for (const k of ['tonAddress', 'trc20Address', 'toncenterKey', 'tronKey'] as const) if (typeof j[k] === 'string') base[k] = j[k].trim()
      if (j.methods) for (const m of ['TON', 'USDT_TON', 'USDT_TRC20'] as Method[]) if (typeof j.methods[m] === 'boolean') base.methods[m] = j.methods[m]
      for (const g of ['min', 'max'] as const) for (const k of ['ton', 'usdt'] as const) if (Number(j[g]?.[k]) > 0) base[g][k] = Number(j[g][k])
      if (Number(j.ttlMin) > 0) base.ttlMin = Number(j.ttlMin)
      if (typeof j.demoHash === 'string') base.demoHash = j.demoHash
      if (Number(j.starUsd) > 0) base.starUsd = Number(j.starUsd)
      if (Number(j.tonUsd) > 0) base.tonUsd = Number(j.tonUsd)
    }
    try { const r = await fetch(`./config.json?t=${Date.now()}`, { cache: 'no-store' }); if (r.ok) merge(await r.json()) } catch { /* файла нет: берём VITE_* */ }
    try { merge(JSON.parse(localStorage.getItem('qcup-config-override') || 'null')) } catch { /* тестовая настройка из админки (только на этом устройстве) */ }
    return base
  })()
  return cfgP
}

// ---- демо-режим владельца ----
// Открывается адресом игры с #demo в конце. На вашем компьютере (localhost) пароль не нужен, на опубликованном сайте и в туннеле
// нужен пароль из админ-панели (в config.json хранится только его хэш). Игроки пароля не знают.
const sha256 = async (s: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(x => x.toString(16).padStart(2, '0')).join('')
export async function ownerDemoUnlocked(): Promise<boolean> {
  try {
    if (sessionStorage.getItem('qcup-demo-ok') === '1') return true
    if (!/demo/i.test(location.hash)) return false
    if (/^(localhost|127\.0\.0\.1|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(location.hostname)) { sessionStorage.setItem('qcup-demo-ok', '1'); return true }
    const c = await siteConfig()
    if (!c.demoHash) return false
    const pw = window.prompt('Пароль владельца для демо-режима')
    if (!pw || (await sha256('qcup-demo:' + pw)) !== c.demoHash) return false
    sessionStorage.setItem('qcup-demo-ok', '1')
    return true
  } catch { return false }
}

// ---- курс: 1 звезда игры = 1 Star по рынку. Star в USDT: публичный API по сделкам Fragment; TON/USD: CoinGecko ----
const RK = 'qcup-rates'
type Rates = { ton: number; usdt: number; at: number }
export async function liveRates(): Promise<Rates> {
  try { const c = JSON.parse(localStorage.getItem(RK) || '') as Rates; if (Date.now() - c.at < 55_000) return c } catch { /* нет кэша */ }
  const cf = await siteConfig()
  let starUsd = cf.starUsd, tonUsd = cf.tonUsd
  try { const j = await (await fetch('https://bes-dev.github.io/telegram_stars_rates/api.json')).json(); if (j.usdt_per_star > 0) starUsd = Number(j.usdt_per_star) } catch { /* запасной */ }
  try { const j = await (await fetch('https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd')).json(); if (j['the-open-network']?.usd > 0) tonUsd = Number(j['the-open-network'].usd) } catch { /* запасной */ }
  const out: Rates = { ton: tonUsd > 0 ? Math.floor(tonUsd / starUsd) : Number(env.VITE_COINS_PER_TON || 150), usdt: Math.floor(1 / starUsd), at: Date.now() }
  try { localStorage.setItem(RK, JSON.stringify(out)) } catch { /* хранилище недоступно */ }
  return out
}

// ---- адреса ----
const toRaw = (a: string): string => {
  if (/^-?\d+:[0-9a-fA-F]{64}$/.test(a)) return a.toLowerCase()
  try {
    const b = Uint8Array.from(atob(a.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0))
    return b.length === 36 ? `${b[1] === 0xff ? -1 : b[1]}:${[...b.slice(2, 34)].map(x => x.toString(16).padStart(2, '0')).join('')}` : a
  } catch { return a }
}
const isTonAddr = (a: string) => /^-?\d+:[0-9a-f]{64}$/.test(toRaw(a.trim()))
const isTronAddr = (a: string) => /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a.trim())

// ---- локальное хранилище ожидающих платежей ----
// Как определяем, что платёж именно от этого пользователя:
//  TON: уникальный комментарий (memo) в переводе, он случайный и нигде не повторяется;
//  USDT (TON и TRON): у переводов нет надёжного комментария, поэтому платёж опознаётся по ТРЁМ признакам сразу:
//    1) точная уникальная сумма, 2) адрес кошелька-отправителя, который игрок указал, 3) время перевода позже создания заявки.
const KEY = 'qcup-deposits'
type Pend = { memo: string; method: Method; amount: string; sender?: string; created: number; expires: number; rate?: number }
type Store = { pending: Pend[]; done: string[] }
const loadStore = (): Store => { try { return JSON.parse(localStorage.getItem(KEY) || '') as Store } catch { return { pending: [], done: [] } } }
const saveStore = (s: Store) => { try { localStorage.setItem(KEY, JSON.stringify(s)) } catch { /* хранилище недоступно */ } }
const SKEW = 120_000 // допуск на расхождение часов, мс

type Credit = { memo: string; coins: number; method: Method }
async function checkOnce(): Promise<Credit[]> {
  const c = await siteConfig()
  const st = loadStore()
  st.pending = st.pending.filter(p => p.expires > Date.now() - 10 * 60_000)
  const out: Credit[] = []
  const take = (p: Pend, hash: string, units: number, dec: number, fallback: number) => {
    const coins = Math.floor((units / 10 ** dec) * (p.rate ?? fallback))
    if (coins <= 0) return
    st.done.push(hash); st.pending = st.pending.filter(x => x !== p); out.push({ memo: p.memo, coins, method: p.method })
  }
  const has = (m: Method) => st.pending.some(p => p.method === m)

  if (has('TON') && c.tonAddress) try {
    const r = await fetch(`https://toncenter.com/api/v2/getTransactions?address=${encodeURIComponent(c.tonAddress)}&limit=50&archival=true`, { headers: c.toncenterKey ? { 'X-API-Key': c.toncenterKey } : {} })
    const j = (await r.json()) as { result?: { utime?: number; transaction_id?: { hash?: string }; in_msg?: { source?: string; value?: string; message?: string } }[] }
    for (const t of j.result || []) {
      const hash = t.transaction_id?.hash, m = t.in_msg
      if (!hash || !m?.source || !m.message || st.done.includes(hash)) continue
      const p = st.pending.find(x => x.method === 'TON' && x.memo === m.message!.trim())
      if (!p || (t.utime ?? 0) * 1000 < p.created - SKEW) continue
      take(p, hash, Number(m.value || '0'), 9, 150)
    }
  } catch { /* повторим */ }

  if (has('USDT_TON') && c.tonAddress) try {
    const r = await fetch(`https://toncenter.com/api/v3/jetton/transfers?owner_address=${encodeURIComponent(c.tonAddress)}&direction=in&limit=50&sort=desc`, { headers: c.toncenterKey ? { 'X-API-Key': c.toncenterKey } : {} })
    const j = (await r.json()) as { jetton_transfers?: { transaction_hash: string; amount: string; jetton_master: string; source?: string; transaction_now?: number; transaction_aborted?: boolean }[] }
    const master = toRaw(USDT_TON_MASTER)
    for (const t of j.jetton_transfers || []) {
      if (t.transaction_aborted || toRaw(t.jetton_master) !== master || st.done.includes(t.transaction_hash)) continue
      const p = st.pending.find(x => x.method === 'USDT_TON' && x.amount === t.amount && !!t.source && !!x.sender && toRaw(x.sender.trim()) === toRaw(t.source))
      if (!p || (t.transaction_now ?? 0) * 1000 < p.created - SKEW) continue
      take(p, t.transaction_hash, Number(t.amount), 6, 100)
    }
  } catch { /* повторим */ }

  if (has('USDT_TRC20') && c.trc20Address) try {
    const r = await fetch(`https://api.trongrid.io/v1/accounts/${encodeURIComponent(c.trc20Address)}/transactions/trc20?only_confirmed=true&only_to=true&limit=50&contract_address=${USDT_TRC20_CONTRACT}`, { headers: c.tronKey ? { 'TRON-PRO-API-KEY': c.tronKey } : {} })
    const j = (await r.json()) as { data?: { transaction_id: string; from: string; to: string; value: string; block_timestamp: number; token_info?: { address?: string } }[] }
    for (const t of j.data || []) {
      if (t.token_info?.address !== USDT_TRC20_CONTRACT || t.to !== c.trc20Address || st.done.includes(t.transaction_id)) continue
      const p = st.pending.find(x => x.method === 'USDT_TRC20' && x.amount === t.value && x.sender?.trim() === t.from)
      if (!p || t.block_timestamp < p.created - SKEW) continue
      take(p, t.transaction_id, Number(t.value), 6, 100)
    }
  } catch { /* повторим */ }

  st.done = st.done.slice(-300)
  saveStore(st)
  return out
}

// Фоновая проверка платежей (режим без бэкенда): работает, пока открыт сайт
export function useLocalDeposits(onCredit: (coins: number, asset: string) => void) {
  useEffect(() => {
    if (!LOCAL || DEMO) return // в демо-версии платежи не проверяются
    let busy = false
    const tick = async () => {
      if (busy) return
      busy = true
      try {
        for (const c of await checkOnce()) {
          onCredit(c.coins, METHOD_LABEL[c.method])
          window.dispatchEvent(new CustomEvent('qcup-dep', { detail: c }))
        }
      } catch { /* повторим на следующем тике */ } finally { busy = false }
    }
    tick()
    const t = window.setInterval(tick, 10_000)
    return () => clearInterval(t)
  }, [onCredit])
}

// ---- режим с бэкендом ----
const initData = () => (window as any).Telegram?.WebApp?.initData || ''
const hdr = () => ({ 'content-type': 'application/json', 'x-telegram-init-data': initData() })

type Cfg = { tonAddress: string; trc20Address: string; methods: Record<Method, boolean>; ttlMin: number; min: { ton: number; usdt: number }; max: { ton: number; usdt: number }; rate: { ton: number; usdt: number } }
type Intent = { memo: string; method: Method; address: string; amount: string; sender?: string; jettonMaster?: string | null }

export function DepositModal({ onClose, onNotice }: { onClose: () => void; onNotice: (s: string) => void }) {
  const [cfg, setCfg] = useState<Cfg | null>(null)
  const [err, setErr] = useState('')
  const [method, setMethod] = useState<Method>('TON')
  const [amount, setAmount] = useState('1')
  const [sender, setSender] = useState('')
  const [intent, setIntent] = useState<Intent | null>(null)
  const [status, setStatus] = useState<'pending' | 'credited' | 'expired'>('pending')
  const timer = useRef(0)

  useEffect(() => {
    if (LOCAL) {
      let t = 0
      siteConfig().then(c => {
        if (!c.tonAddress && !c.trc20Address) return setErr('Пополнение не настроено: задайте адреса кошельков в админ-панели (admin.html).')
        const methods = { TON: c.methods.TON && !!c.tonAddress, USDT_TON: c.methods.USDT_TON && !!c.tonAddress, USDT_TRC20: c.methods.USDT_TRC20 && !!c.trc20Address }
        const first = (['TON', 'USDT_TON', 'USDT_TRC20'] as Method[]).find(m => methods[m])
        if (first) { setMethod(first); setAmount(first === 'TON' ? '1' : '10') }
        const refresh = () => liveRates().then(r => setCfg({ tonAddress: c.tonAddress, trc20Address: c.trc20Address, methods, ttlMin: c.ttlMin, min: c.min, max: c.max, rate: { ton: r.ton, usdt: r.usdt } }))
        refresh()
        t = window.setInterval(refresh, 60_000) // курс обновляется, пока открыто окно
      })
      return () => clearInterval(t)
    }
    fetch(`${API}/api/deposit/config`).then(r => (r.ok ? r.json() : Promise.reject())).then(j => setCfg({
      tonAddress: j.address, trc20Address: '', methods: { TON: true, USDT_TON: true, USDT_TRC20: false }, ttlMin: j.ttlMin,
      min: { ton: j.minTon, usdt: j.usdt.min }, max: { ton: j.maxTon, usdt: j.usdt.max }, rate: { ton: j.coinsPerTon, usdt: j.usdt.coinsPerUsdt },
    })).catch(() => setErr('Пополнение сейчас недоступно.'))
  }, [])

  useEffect(() => {
    if (!LOCAL || !intent) return
    const h = (e: Event) => { if ((e as CustomEvent).detail.memo === intent.memo) setStatus('credited') }
    window.addEventListener('qcup-dep', h)
    return () => window.removeEventListener('qcup-dep', h)
  }, [intent])

  useEffect(() => {
    if (LOCAL || !intent || status !== 'pending') return
    const tick = async () => {
      try {
        const r = await fetch(`${API}/api/deposit/ton/${intent.memo}`, { headers: hdr() })
        if (r.ok) {
          const j = (await r.json()) as { status: 'pending' | 'credited' | 'expired'; coins: string | null }
          setStatus(j.status)
          if (j.status === 'credited') { onNotice(`Пополнено: +${money(Number(j.coins))} ⭐`); return }
          if (j.status === 'expired') return
        }
      } catch { /* повторим */ }
      timer.current = window.setTimeout(tick, 5000)
    }
    timer.current = window.setTimeout(tick, 5000)
    return () => clearTimeout(timer.current)
  }, [intent, status, onNotice])

  const isUsdt = method !== 'TON'
  const dec = isUsdt ? 1e6 : 1e9
  const num = Number(amount.replace(',', '.')) || 0
  const lim = cfg ? { min: isUsdt ? cfg.min.usdt : cfg.min.ton, max: isUsdt ? cfg.max.usdt : cfg.max.ton, rate: isUsdt ? cfg.rate.usdt : cfg.rate.ton } : null
  const unit = isUsdt ? 'USDT' : 'TON'
  const senderOk = !isUsdt || (method === 'USDT_TRC20' ? isTronAddr(sender) : isTonAddr(sender))

  const create = async () => {
    setErr('')
    if (!cfg || !lim) return
    if (!senderOk) return setErr(method === 'USDT_TRC20' ? 'Укажите адрес TRON-кошелька (начинается с T), с которого будете платить.' : 'Укажите адрес TON-кошелька, с которого будете платить.')
    if (LOCAL) {
      const rnd = crypto.getRandomValues(new Uint8Array(9))
      const memo = 'qc-' + [...rnd].map(b => (b % 36).toString(36)).join('').padEnd(12, '0').slice(0, 12)
      const st = loadStore()
      let units: bigint
      if (isUsdt) {
        // уникальная сумма: к выбранной добавляется от 0,000001 до 0,009999 USDT
        const base = BigInt(Math.round(num * 100)) * 10_000n
        let cand = base
        for (let i = 0; i < 20; i++) { cand = base + BigInt(1 + (crypto.getRandomValues(new Uint16Array(1))[0] % 9999)); if (!st.pending.some(p => p.method === method && p.amount === String(cand) && p.sender === sender.trim())) break }
        units = cand
      } else units = BigInt(Math.round(num * 1e9))
      st.pending.push({ memo, method, amount: String(units), sender: isUsdt ? sender.trim() : undefined, created: Date.now(), expires: Date.now() + cfg.ttlMin * 60_000, rate: lim.rate })
      saveStore(st)
      setIntent({ memo, method, address: method === 'USDT_TRC20' ? cfg.trc20Address : cfg.tonAddress, amount: String(units), sender: sender.trim(), jettonMaster: method === 'USDT_TON' ? USDT_TON_MASTER : null }); setStatus('pending')
      return
    }
    try {
      const r = await fetch(`${API}/api/deposit/ton`, { method: 'POST', headers: hdr(), body: JSON.stringify(isUsdt ? { asset: 'USDT', amountUsdt: num } : { asset: 'TON', amountTon: num }) })
      const j = await r.json()
      if (r.status === 401) return setErr('Войдите через Telegram, чтобы пополнить баланс.')
      if (!r.ok) return setErr(j.error || 'Не удалось создать платёж')
      setIntent({ memo: j.memo, method, address: j.address, amount: j.amountNano, jettonMaster: j.jettonMaster }); setStatus('pending')
    } catch { setErr('Нет связи с сервером') }
  }

  const copy = (t: string) => navigator.clipboard?.writeText(t).then(() => onNotice('Скопировано'))
  const shown = intent ? (Number(intent.amount) / (intent.method === 'TON' ? 1e9 : 1e6)).toFixed(intent.method === 'TON' ? 9 : 6).replace(/\.?0+$/, m => (intent.method === 'TON' ? '' : m)) : ''
  const link = intent && intent.method !== 'USDT_TRC20'
    ? (intent.method === 'USDT_TON' ? `ton://transfer/${intent.address}?jetton=${intent.jettonMaster}&amount=${intent.amount}` : `ton://transfer/${intent.address}?amount=${intent.amount}&text=${intent.memo}`)
    : ''
  const available = cfg ? (['TON', 'USDT_TON', 'USDT_TRC20'] as Method[]).filter(m => cfg.methods[m]) : []

  return <div className="dep-back" onClick={onClose}>
    <div className="dep-card" onClick={e => e.stopPropagation()}>
      <button className="dep-x" onClick={onClose} aria-label="Закрыть"><X size={18} /></button>
      <h2>Пополнение</h2>
      {err && <p className="dep-err">{err}</p>}
      {cfg && !intent && <>
        <label className="dep-lab">Валюта</label>
        <div className="dep-methods" role="radiogroup" aria-label="Валюта">
          {available.map(m => (
            <button key={m} type="button" role="radio" aria-checked={method === m} className={`dep-method ${method === m ? 'on' : ''}`}
              onClick={() => { setMethod(m); setAmount(m === 'TON' ? '1' : '10'); setErr('') }}>
              {m === 'TON' ? <TonIcon size={26} /> : <UsdtIcon size={26} />}
              <span><b>{m === 'TON' ? 'TON' : 'USDT'}</b><small>{m === 'TON' ? 'сеть TON' : m === 'USDT_TON' ? 'сеть TON' : 'сеть TRON · TRC20'}</small></span>
              {method === m && <em>✓</em>}
            </button>))}
        </div>
        <label className="dep-lab">Сумма, {unit}</label>
        <input className="dep-input" inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} />
        <div className="dep-quick">{(isUsdt ? [5, 10, 50, 100] : [0.5, 1, 5, 10]).map(v => <button key={v} onClick={() => setAmount(String(v))}>{v}</button>)}</div>
        {isUsdt && LOCAL && <>
          <label className="dep-lab">Адрес вашего кошелька, с которого платите ({method === 'USDT_TRC20' ? 'TRON' : 'TON'})</label>
          <input className="dep-input dep-mono" placeholder={method === 'USDT_TRC20' ? 'T…' : 'UQ… / EQ…'} value={sender} onChange={e => setSender(e.target.value)} />
          <p className="dep-hint">Платёж привязывается к вам по этому адресу и точной сумме. С чужого адреса он не засчитается.</p>
        </>}
        <p className="dep-hint">≈ {money(num * lim!.rate)} ⭐ · 1 {unit} ≈ {lim!.rate} ⭐ (курс по рынку, обновляется) · от {lim!.min} до {lim!.max} {unit}</p>
        <button className="primary-btn wide" onClick={create} disabled={!(num >= lim!.min && num <= lim!.max) || !available.length}>Продолжить</button>
      </>}
      {cfg && intent && <>
        {status === 'pending' && <>
          {intent.method === 'TON' && <p className="dep-hint">Отправьте ровно {shown} TON на адрес ниже. <b>Комментарий обязателен</b>, без него платёж не зачтётся. Действует {cfg.ttlMin} мин.</p>}
          {intent.method === 'USDT_TON' && <p className="dep-hint">Отправьте <b>ровно {shown} USDT</b> (сеть TON) со своего кошелька <b>{intent.sender ? `${intent.sender.slice(0, 6)}…${intent.sender.slice(-4)}` : ''}</b>. Сумму не округляйте. Действует {cfg.ttlMin} мин.</p>}
          {intent.method === 'USDT_TRC20' && <p className="dep-hint">Отправьте <b>ровно {shown} USDT</b> только в сети <b>TRON (TRC20)</b> со своего кошелька <b>{intent.sender ? `${intent.sender.slice(0, 5)}…${intent.sender.slice(-4)}` : ''}</b>. Сумму не округляйте. Перевод в другой сети будет потерян. Действует {cfg.ttlMin} мин.</p>}
          <label className="dep-lab">Адрес</label>
          <button className="dep-copy" onClick={() => copy(intent.address)}><span>{intent.address}</span><Copy size={14} /></button>
          {intent.method === 'TON'
            ? <><label className="dep-lab">Комментарий</label><button className="dep-copy" onClick={() => copy(intent.memo)}><span>{intent.memo}</span><Copy size={14} /></button></>
            : <><label className="dep-lab">Сумма</label><button className="dep-copy" onClick={() => copy(shown)}><span>{shown} USDT</span><Copy size={14} /></button></>}
          {link && <a className="primary-btn wide dep-open" href={link}><ExternalLink size={16} /> Открыть в кошельке</a>}
          <p className="dep-hint">Ждём поступление, окно обновится само.</p>
        </>}
        {status === 'credited' && <p className="dep-ok">Платёж получен, звёзды добавлены в баланс.</p>}
        {status === 'expired' && <p className="dep-err">Время платежа вышло. Если вы уже отправили платёж, напишите в поддержку.</p>}
      </>}
    </div>
  </div>
}
