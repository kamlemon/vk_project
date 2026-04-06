import { createHmac } from 'crypto'

const BASE_URL = (process.env.GETPLATINUM_BASE_URL ?? '').replace(/\/$/, '')
const API_KEY = process.env.GETPLATINUM_API_KEY ?? ''

function assertConfig() {
  if (!BASE_URL) throw new Error('GETPLATINUM_BASE_URL is required')
  if (!API_KEY) throw new Error('GETPLATINUM_API_KEY is required')
}

async function gpPost(path, payload) {
  assertConfig()

  console.log('[GETPLATINUM][REQUEST]', path, JSON.stringify(payload, null, 2))

  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  const raw = await res.text()
  console.log('[GETPLATINUM][RESPONSE]', path, raw)

  let json
  try {
    json = JSON.parse(raw)
  } catch (err) {
    throw new Error(`GetPlatinum returned non-JSON response: ${raw.slice(0, 500)}`)
  }

  if (!res.ok) {
    throw new Error(`GetPlatinum HTTP ${res.status}: ${raw.slice(0, 500)}`)
  }

  if (Number(json.errorCode ?? 0) !== 0) {
    throw new Error(`GetPlatinum error ${json.errorCode}: ${json.errorMessage}`)
  }

  return json
}

export async function initPaymentUrl({
  dealId,
  amount,
  currency = 'RUB',
  title,
  clientId,
  email = null,
  phone = null,
  name = 'Клиент',
  notificationUrl,
  successUrl,
  failUrl,
  customParams = {},
}) {
  if (!email && !phone) {
    throw new Error('GetPlatinum requires email or phone')
  }

  const payload = {
    dealId,
    currency,
    amount,
    positions: [
      {
        name: title,
        price: amount,
        quantity: 1,
        prefix: process.env.GETPLATINUM_POSITION_PREFIX ?? 'service',
        vat: process.env.GETPLATINUM_VAT ?? 'none',
      },
    ],
    clientParams: {
      clientId,
      email,
      phone,
      name,
    },
    notificationUrl,
    successUrl,
    failUrl,
    customParams,
  }

  return gpPost('/init-payment-url', payload)
}

export function makeGetPlatinumChecksum(params) {
  assertConfig()

  const data = { ...(params ?? {}) }
  delete data.checksum
  delete data.customParams

  const sortedKeys = Object.keys(data).sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase())
  )

  let str = ''
  for (const key of sortedKeys) {
    let value = data[key]

    if (typeof value === 'boolean') {
      value = value ? 1 : 0
    } else if (value !== null && typeof value === 'object') {
      value = JSON.stringify(value)
    }

    str += `${key};${String(value)};`
  }

  return createHmac('sha256', API_KEY)
    .update(str)
    .digest('hex')
    .toUpperCase()
}

export function verifyGetPlatinumChecksum(params) {
  const incoming = String(params?.checksum ?? '').toUpperCase()
  if (!incoming) return false
  return incoming === makeGetPlatinumChecksum(params)
}
