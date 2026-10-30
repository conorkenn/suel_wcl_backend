import 'dotenv/config'

const TOKEN_URL = 'https://www.warcraftlogs.com/oauth/token'
const API_URL = 'https://www.warcraftlogs.com/api/v2/client'

interface TokenResponse {
  access_token: string
  expires_in: number
  token_type: string
}

let cachedToken: string | null = null
let tokenExpiry = 0

async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiry) {
    return cachedToken
  }

  const clientId = process.env.WCL_CLIENT_ID
  const clientSecret = process.env.WCL_CLIENT_SECRET

  if (!clientId || !clientSecret) {
    throw new Error('Missing WCL_CLIENT_ID or WCL_CLIENT_SECRET in .env')
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Token request failed: ${res.status} ${text}`)
  }

  const data = (await res.json()) as TokenResponse
  cachedToken = data.access_token
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000
  return cachedToken
}

export async function wclQuery<T = unknown>(
  query: string,
  variables: Record<string, unknown> = {}
): Promise<T> {
  const token = await getAccessToken()

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  })

  const json = (await res.json()) as { data?: T; errors?: { message: string }[] }

  if (json.errors?.length) {
    const msg = json.errors.map((e) => e.message).join('; ')
    throw new Error(`GraphQL error: ${msg}`)
  }

  if (!json.data) {
    throw new Error('No data returned from GraphQL')
  }

  return json.data
}