import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import express from 'express'
import { test } from 'node:test'
import { createCharactersRouter } from './characters.js'

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
  router: ReturnType<typeof createCharactersRouter>,
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

test('character encounter attempts returns matching fights and pagination', async () => {
  const mock = createMockQuery([
    {
      characterData: {
        character: {
          id: 123,
          name: 'Suel',
          classID: 8,
          level: 90,
          server: { name: 'Stormrage', region: { name: 'US' } },
          recentReports: {
            total: 14,
            per_page: 1,
            current_page: 2,
            last_page: 14,
            has_more_pages: true,
            data: [
              {
                code: 'ReportCode',
                title: 'Raid night',
                startTime: 1000,
                endTime: 5000,
                fights: [
                  {
                    id: 12,
                    name: "Ula'tek",
                    startTime: 100,
                    endTime: 500,
                    encounterID: 3492,
                    difficulty: 5,
                    kill: true,
                    fightPercentage: 0,
                  },
                ],
              },
            ],
          },
        },
      },
    },
  ])

  await withRouter(createCharactersRouter(mock.query), async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/character/encounter-attempts?name=Suel&server=stormrage&encounterID=3492&difficulty=5&page=2&limit=1`
    )
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      character: {
        id: 123,
        name: 'Suel',
        classID: 8,
        level: 90,
        server: { name: 'Stormrage', region: { name: 'US' } },
      },
      encounterID: 3492,
      difficulty: 5,
      pagination: {
        total: 14,
        perPage: 1,
        currentPage: 2,
        lastPage: 14,
        hasMorePages: true,
      },
      attempts: [
        {
          report: {
            code: 'ReportCode',
            title: 'Raid night',
            startTime: 1000,
            endTime: 5000,
          },
          fight: {
            id: 12,
            name: "Ula'tek",
            startTime: 100,
            endTime: 500,
            encounterID: 3492,
            difficulty: 5,
            kill: true,
            fightPercentage: 0,
          },
        },
      ],
    })
  })

  assert.equal(mock.calls.length, 1)
  assert.deepEqual(mock.calls[0].variables, {
    name: 'Suel',
    serverSlug: 'stormrage',
    serverRegion: 'US',
    encounterID: 3492,
    difficulty: 5,
    page: 2,
    limit: 1,
  })
  assert.match(mock.calls[0].query, /fights\(encounterID:\s*\$encounterID,\s*difficulty:\s*\$difficulty\)/)
})

test('character encounter attempts validates query parameters before calling Warcraft Logs', async () => {
  const mock = createMockQuery([])

  await withRouter(createCharactersRouter(mock.query), async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/character/encounter-attempts?name=Suel&server=stormrage`
    )
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), {
      error: 'encounterID must be a positive integer',
    })
  })

  assert.equal(mock.calls.length, 0)
})

test('character encounter attempts returns 404 when the character is not found', async () => {
  const mock = createMockQuery([
    {
      characterData: {
        character: null,
      },
    },
  ])

  await withRouter(createCharactersRouter(mock.query), async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/character/encounter-attempts?name=Missing&server=stormrage&encounterID=3492`
    )
    assert.equal(response.status, 404)
    assert.deepEqual(await response.json(), { error: 'Character not found' })
  })
})

test('character encounter attempts returns an empty result when the character has no reports', async () => {
  const mock = createMockQuery([
    {
      characterData: {
        character: {
          id: 123,
          name: 'Suel',
          classID: 8,
          level: 90,
          server: { name: 'Stormrage', region: { name: 'US' } },
          recentReports: null,
        },
      },
    },
  ])

  await withRouter(createCharactersRouter(mock.query), async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/character/encounter-attempts?name=Suel&server=stormrage&encounterID=3492`
    )
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      character: {
        id: 123,
        name: 'Suel',
        classID: 8,
        level: 90,
        server: { name: 'Stormrage', region: { name: 'US' } },
      },
      encounterID: 3492,
      difficulty: null,
      pagination: null,
      attempts: [],
    })
  })
})

test('attempt details fetches fight metadata and player details for the selected fight', async () => {
  const playerDetails = {
    data: {
      playerDetails: {
        dps: [
          {
            name: 'Tempestrike',
            id: 663,
            type: 'DemonHunter',
            server: 'Norgannon',
            region: 'US',
            icon: 'DemonHunter-Devourer',
            specs: [{ spec: 'Devourer', count: 1 }],
          },
          {
            name: 'Sueldh',
            id: 664,
            type: 'DemonHunter',
            server: 'Stormrage',
            region: 'US',
            icon: 'DemonHunter-Havoc',
            specs: [{ spec: 'Havoc', count: 1 }],
          },
        ],
      },
    },
  }
  const mock = createMockQuery([
    {
      reportData: {
        report: {
          code: 'ReportCode',
          title: 'Raid night',
          fights: [
            {
              id: 12,
              name: "Ula'tek",
              startTime: 100,
              endTime: 500,
              encounterID: 3492,
              difficulty: 4,
              kill: true,
              fightPercentage: 0,
            },
          ],
          playerDetails,
        },
      },
    },
  ])

  await withRouter(createCharactersRouter(mock.query), async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/character/attempt-details?reportCode=ReportCode&fightID=12&characterName=Sueldh&server=Stormrage`
    )
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      report: { code: 'ReportCode', title: 'Raid night' },
      fight: {
        id: 12,
        name: "Ula'tek",
        startTime: 100,
        endTime: 500,
        encounterID: 3492,
        difficulty: 4,
        kill: true,
        fightPercentage: 0,
      },
      player: {
        name: 'Sueldh',
        id: 664,
        class: 'DemonHunter',
        server: 'Stormrage',
        region: 'US',
        icon: 'DemonHunter-Havoc',
        specs: [{ spec: 'Havoc', count: 1 }],
      },
      characterFound: true,
      playerDetails,
    })
  })

  assert.equal(mock.calls.length, 1)
  assert.deepEqual(mock.calls[0].variables, { reportCode: 'ReportCode', fightID: 12 })
  assert.match(mock.calls[0].query, /playerDetails\(fightIDs:\s*\[\$fightID\]/)
})

test('attempt details returns raw player details when the character is not found', async () => {
  const playerDetails = {
    data: {
      playerDetails: {
        dps: [
          {
            name: 'Tempestrike',
            id: 663,
            type: 'DemonHunter',
            server: 'Norgannon',
            region: 'US',
            icon: 'DemonHunter-Devourer',
            specs: [{ spec: 'Devourer', count: 1 }],
          },
        ],
      },
    },
  }
  const mock = createMockQuery([
    {
      reportData: {
        report: {
          code: 'ReportCode',
          title: 'Raid night',
          fights: [
            {
              id: 12,
              name: "Ula'tek",
              startTime: 100,
              endTime: 500,
              encounterID: 3492,
              difficulty: 4,
              kill: true,
              fightPercentage: 0,
            },
          ],
          playerDetails,
        },
      },
    },
  ])

  await withRouter(createCharactersRouter(mock.query), async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/character/attempt-details?reportCode=ReportCode&fightID=12&characterName=Sueldh&server=Stormrage`
    )
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      report: { code: 'ReportCode', title: 'Raid night' },
      fight: {
        id: 12,
        name: "Ula'tek",
        startTime: 100,
        endTime: 500,
        encounterID: 3492,
        difficulty: 4,
        kill: true,
        fightPercentage: 0,
      },
      player: null,
      characterFound: false,
      playerDetails,
    })
  })
})

test('attempt details does not claim a character match when no character was requested', async () => {
  const playerDetails = {
    data: {
      playerDetails: {
        dps: [{ name: 'Sueldh', server: 'Stormrage', specs: [{ spec: 'Devourer', count: 1 }] }],
      },
    },
  }
  const mock = createMockQuery([
    {
      reportData: {
        report: {
          code: 'ReportCode',
          title: 'Raid night',
          fights: [
            {
              id: 27,
              name: 'Sszorak',
              startTime: 100,
              endTime: 500,
              encounterID: 3420,
              difficulty: 4,
              kill: true,
              fightPercentage: 0,
            },
          ],
          playerDetails,
        },
      },
    },
  ])

  await withRouter(createCharactersRouter(mock.query), async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/character/attempt-details?reportCode=ReportCode&fightID=27`
    )
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.player, null)
    assert.equal(body.characterFound, null)
    assert.equal(body.fight.name, 'Sszorak')
    assert.deepEqual(body.playerDetails, playerDetails)
  })
})
