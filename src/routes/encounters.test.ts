import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import express from 'express'
import { test } from 'node:test'
import { createEncountersRouter } from './encounters.js'

interface QueryCall {
  query: string
  variables: Record<string, unknown>
}

function createMockQuery(responses: unknown[]) {
  const calls: QueryCall[] = []

  const query = async <T = unknown>(
    queryText: string,
    variables: Record<string, unknown> = {}
  ): Promise<T> => {
    calls.push({ query: queryText, variables })
    const response = responses.shift()
    if (response === undefined) {
      throw new Error('Unexpected Warcraft Logs query')
    }

    return response as T
  }

  return { query, calls }
}

async function withRouter(
  router: ReturnType<typeof createEncountersRouter>,
  run: (baseUrl: string) => Promise<void>
) {
  const app = express()
  app.use('/api', router)

  const server = createServer(app).listen(0)
  await once(server, 'listening')

  const address = server.address()
  assert(address && typeof address !== 'string')

  try {
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    server.close()
    await once(server, 'close')
  }
}

test('latest raid returns the highest-ID non-development raid with bosses', async () => {
  const mock = createMockQuery([
    {
      worldData: {
        expansions: [
          { id: 6, name: 'Previous expansion' },
          { id: 7, name: 'Midnight' },
        ],
      },
    },
    {
      worldData: {
        expansion: {
          id: 7,
          name: 'Midnight',
          zones: [
            {
              id: 50,
              name: 'Older Raid',
              difficulties: [{ id: 5, name: 'Mythic', sizes: [20] }],
              encounters: [{ id: 100, name: 'Older Boss' }],
            },
            {
              id: 54,
              name: 'Raid PTR',
              difficulties: [{ id: 5, name: 'Mythic', sizes: [20] }],
              encounters: [{ id: 200, name: 'PTR Boss' }],
            },
            {
              id: 509,
              name: 'Complete Raid',
              difficulties: [{ id: 5, name: 'Mythic', sizes: [20] }],
              encounters: [{ id: 300, name: 'Combined Boss' }],
            },
            {
              id: 55,
              name: 'Mythic+ Season 2',
              difficulties: [{ id: 10, name: 'Dungeon', sizes: [5] }],
              encounters: [{ id: 400, name: 'Dungeon Boss' }],
            },
            {
              id: 53,
              name: 'The Venomous Abyss',
              difficulties: [{ id: 5, name: 'Mythic', sizes: [20] }],
              encounters: [{ id: 3470, name: "Nek'zali the Soulcoiler" }],
            },
          ],
        },
      },
    },
  ])

  await withRouter(createEncountersRouter(mock.query), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/raids/latest`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      expansion: { id: 7, name: 'Midnight' },
      raid: {
        id: 53,
        name: 'The Venomous Abyss',
        difficulties: [{ id: 5, name: 'Mythic', sizes: [20] }],
        encounters: [{ id: 3470, name: "Nek'zali the Soulcoiler" }],
      },
    })
  })

  assert.equal(mock.calls.length, 2)
  assert.match(mock.calls[0].query, /GetLatestExpansion/)
  assert.deepEqual(mock.calls[1].variables, { expansionID: 7 })
})

test('rankings route passes encounter and class filters to Warcraft Logs', async () => {
  const rankings = {
    page: 1,
    hasMorePages: false,
    count: 1,
    rankings: [{ name: 'Example Mage', amount: 12345 }],
  }
  const mock = createMockQuery([
    {
      worldData: {
        encounter: {
          id: 3492,
          name: "Ula'tek",
          characterRankings: rankings,
        },
      },
    },
  ])

  await withRouter(createEncountersRouter(mock.query), async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/encounter/3492/rankings?className=%20Mage%20&specName=Fire&difficulty=5&page=2&raidSize=20`
    )
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      encounter: { id: 3492, name: "Ula'tek" },
      className: 'Mage',
      specName: 'Fire',
      difficulty: 5,
      raidSize: 20,
      metric: 'dps',
      rankings,
    })
  })

  assert.equal(mock.calls.length, 1)
  assert.deepEqual(mock.calls[0].variables, {
    encounterID: 3492,
    className: 'Mage',
    specName: 'Fire',
    difficulty: 5,
    page: 2,
    raidSize: 20,
  })
  assert.match(mock.calls[0].query, /metric:\s*dps/)
})

test('rankings route validates inputs before querying Warcraft Logs', async () => {
  const mock = createMockQuery([])

  await withRouter(createEncountersRouter(mock.query), async (baseUrl) => {
    const missingClass = await fetch(`${baseUrl}/api/encounter/3492/rankings`)
    assert.equal(missingClass.status, 400)
    assert.deepEqual(await missingClass.json(), {
      error: 'className query param required',
    })

    const invalidDifficulty = await fetch(
      `${baseUrl}/api/encounter/3492/rankings?className=Mage&difficulty=heroic`
    )
    assert.equal(invalidDifficulty.status, 400)
    assert.deepEqual(await invalidDifficulty.json(), {
      error: 'difficulty must be a positive integer',
    })
  })

  assert.equal(mock.calls.length, 0)
})
