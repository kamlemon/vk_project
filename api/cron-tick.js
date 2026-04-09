import pendingRepliesHandler from './cron-pending-replies.js'
import offersHandler from './cron-offers.js'
import productCycleHandler from './cron-product-cycle.js'

function createMockRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      this.body = payload
      return this
    },
    send(payload) {
      this.body = payload
      return this
    },
    end(payload) {
      this.body = payload ?? this.body
      return this
    },
  }
}

async function runInternal(name, handler, req) {
  const mockRes = createMockRes()
  await handler(
    {
      method: 'GET',
      query: req.query ?? {},
      headers: req.headers ?? {},
    },
    mockRes
  )

  return {
    name,
    statusCode: mockRes.statusCode,
    body: mockRes.body,
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const expectedToken = process.env.CRON_TICK_TOKEN
  const providedToken =
    req.query?.token ??
    req.headers?.['x-cron-token'] ??
    req.headers?.['X-Cron-Token']

  if (expectedToken && providedToken !== expectedToken) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' })
  }

  try {
    const pendingReplies = await runInternal('cron-pending-replies', pendingRepliesHandler, req)
    const offers = await runInternal('cron-offers', offersHandler, req)
    const productCycle = await runInternal('cron-product-cycle', productCycleHandler, req)

    return res.status(200).json({
      ok: true,
      pendingReplies,
      offers,
      productCycle,
    })
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message,
    })
  }
}
