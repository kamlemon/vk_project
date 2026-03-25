import express from 'express'
import bodyParser from 'body-parser'
import handler from './api/vk.js'

const app = express()

app.use(bodyParser.json({ limit: '50mb' }))

app.post('/', (req, res) => handler(req, res))
app.get('/health', (_req, res) => res.status(200).send('ok'))

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`Local webhook server started on port ${PORT}`)
})
