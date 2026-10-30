import 'dotenv/config'
import express from 'express'
import apiRoutes from './routes/api.js'
import characterRoutes from './routes/characters.js'
import comparisonRoutes from './routes/comparisons.js'
import encounterRoutes from './routes/encounters.js'

const app = express()
const PORT = process.env.PORT || 3000

app.use(express.json())

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' })
})

app.use('/api', apiRoutes)
app.use('/api', characterRoutes)
app.use('/api', comparisonRoutes)
app.use('/api', encounterRoutes)

app.listen(PORT, () => {
  console.log(`WCL backend running on http://localhost:${PORT}`)
  console.log('Endpoints:')
  console.log('  GET /health')
  console.log('  GET /api/rate-limit')
  console.log('  GET /api/report/:code')
  console.log('  GET /api/character?name=...&server=...&region=US')
})