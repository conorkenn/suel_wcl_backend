import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import express from 'express'
import { test } from 'node:test'
import { createComparisonsRouter } from './comparisons.js'

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
  router: ReturnType<typeof createComparisonsRouter>,
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

function playerDetails(name: string, id: number, server = 'Stormrage') {
  return {
    data: {
      playerDetails: {
        dps: [
          {
            name,
            id,
            type: 'DemonHunter',
            server,
            specs: [{ spec: 'Havoc', count: 10 }],
          },
        ],
      },
    },
  }
}

function raidPlayerDetails(
  name: string,
  id: number,
  size: number,
  talents: Array<{ id: number; name: string; rank: number; nodeID: number }> = []
) {
  return {
    data: {
      playerDetails: {
        dps: [
          {
            name,
            id,
            type: 'DemonHunter',
            server: 'Stormrage',
            specs: [{ spec: 'Havoc', count: 10 }],
            combatantInfo: {
              talents: [],
              talentTree: talents.map(({ id, rank, nodeID }) => ({ id, rank, nodeID })),
            },
          },
          ...Array.from({ length: size - 1 }, (_, index) => ({
            name: `RaidMember${index}`,
            id: id + index + 1,
            type: 'Mage',
            server: 'Stormrage',
            specs: [{ spec: 'Frost', count: 10 }],
          })),
        ],
      },
    },
  }
}

test('attempt comparison calculates per-ability metrics against the top-10 median', async () => {
  const roster = [
    {
      name: 'Sueldh',
      id: 100,
      type: 'DemonHunter',
      server: 'Stormrage',
      specs: [{ spec: 'Havoc', count: 10 }],
      combatantInfo: {
        talents: [],
        talentTree: [
          { id: 1001, rank: 1, nodeID: 9001 },
          { id: 1002, rank: 2, nodeID: 9002 },
        ],
      },
    },
    ...Array.from({ length: 19 }, (_, index) => ({
      name: `Player${index}`,
      id: index + 101,
      type: 'Mage',
      server: 'Stormrage',
      specs: [{ spec: 'Frost', count: 10 }],
    })),
  ]
  const rankingEntries = Array.from({ length: 10 }, (_, index) => ({
    name: `Ranker${index}`,
    server: { name: 'Stormrage' },
    amount: 15000 + index,
    rankPercent: 99 - index,
    report: { code: `TopLog${index}`, fightID: index + 1 },
  }))
  const candidateMetadata = Object.fromEntries(
    rankingEntries.map((entry, index) => [
      `candidate${index}`,
      {
        fights: [{ id: index + 1, startTime: 1000, endTime: 201000 }],
        playerDetails: raidPlayerDetails(entry.name, index + 1, 20, [
          ...(index < 5 ? [{ id: 1001, name: 'Talent A', rank: 1, nodeID: 9001 }] : []),
          ...(index < 6 ? [{ id: 1004, name: 'Talent D', rank: 1, nodeID: 9002 }] : []),
          ...(index < 8 ? [{ id: 1003, name: 'Talent C', rank: 1, nodeID: 9003 }] : []),
        ]),
      },
    ])
  )
  const tableResponse = Object.fromEntries(
    Array.from({ length: 11 }, (_, index) => [
      `log${index}`,
      {
        damageDone: {
          data: {
            entries: [
              { guid: 1, name: 'Chaos Strike', total: index === 0 ? 1_000_000 : 3_000_000 },
              { guid: 3, name: 'Annihilation', total: index === 0 ? 200_000 : 1_000_000 },
            ],
          },
        },
        damageTaken: {
          data: {
            entries: [
              { guid: 2, name: 'Boss Strike', total: index === 0 ? 100_000 : 400_000 },
            ],
          },
        },
        casts: {
          data: {
            entries: [
              { guid: 1, name: 'Chaos Strike', uses: index === 0 ? 100 : 200 },
              { guid: 3, name: 'Annihilation', uses: index === 0 ? 20 : 50 },
            ],
          },
        },
      },
    ])
  )
  const mock = createMockQuery([
    {
      reportData: {
        report: {
          code: 'MyLog',
          title: 'Raid night',
          fights: [
            {
              id: 12,
              name: "Ula'tek",
              startTime: 0,
              endTime: 100_000,
              encounterID: 3492,
              difficulty: 4,
              kill: true,
            },
          ],
          playerDetails: { data: { playerDetails: { dps: roster } } },
        },
      },
    },
    {
      worldData: {
        encounter: {
          id: 3492,
          name: "Ula'tek",
          characterRankings: { data: { rankings: rankingEntries } },
        },
      },
    },
    { reportData: candidateMetadata },
    { reportData: tableResponse },
  ])

  await withRouter(createComparisonsRouter(mock.query), async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/character/attempt-comparison?reportCode=MyLog&fightID=12&characterName=Sueldh&server=Stormrage`
    )
    assert.equal(response.status, 200)
    const body = await response.json()

    assert.deepEqual(body.player, {
      name: 'Sueldh',
      class: 'DemonHunter',
      spec: 'Havoc',
      server: 'Stormrage',
    })
    assert.equal(body.benchmark.method, 'median')
    assert.equal(body.benchmark.requestedParses, 10)
    assert.equal(body.benchmark.sampleSize, 10)
    assert.equal(body.benchmark.filters.raidSize, null)
    assert.equal(body.benchmark.playerRaidSize, 20)
    assert.equal(body.benchmark.raidSizeFilterApplied, false)
    assert.equal(body.benchmark.topLogs[0].raidSize, 20)
    assert.deepEqual(body.talentComparison, {
      available: true,
      reason: null,
      benchmarkSampleSize: 8,
      playerSelected: [
        {
          id: '1002',
          name: null,
          rank: 2,
          nodeID: '9002',
          benchmark: {
            id: '1002',
            name: null,
            nodeID: '9002',
            pickedIn: 0,
            sampleSize: 8,
            pickRate: 0,
            nodePickedIn: 6,
            nodePickRate: 75,
            alternatives: [
              {
                id: '1004',
                name: null,
                nodeID: '9002',
                pickedIn: 6,
                sampleSize: 8,
                pickRate: 75,
              },
            ],
          },
        },
        {
          id: '1001',
          name: null,
          rank: 1,
          nodeID: '9001',
          benchmark: {
            id: '1001',
            name: null,
            nodeID: '9001',
            pickedIn: 5,
            sampleSize: 8,
            pickRate: 62.5,
            nodePickedIn: 5,
            nodePickRate: 62.5,
            alternatives: [],
          },
        },
      ],
      commonBenchmarkTalentsNotSelected: [
        {
          id: '1003',
          name: null,
          nodeID: '9003',
          pickedIn: 8,
          sampleSize: 8,
          pickRate: 100,
        },
      ],
    })
    assert.equal(body.summary.damageDone.total, 1_200_000)
    assert.equal(body.summary.damageDone.damagePerSecond, 12_000)
    assert.equal(body.summary.damageDone.benchmarkMedian, 20_000)
    assert.equal(body.summary.damageTaken.damageTakenPerSecond, 1_000)
    assert.equal(body.summary.damageTaken.benchmarkMedian, 2_000)
    assert.equal(body.summary.damageTaken.delta, -1_000)
    assert.equal(body.summary.casts.perMinute, 72)
    assert.equal(body.summary.casts.benchmarkMedian, 75)
    assert.equal(body.abilities[0].name, 'Chaos Strike')
    assert.equal(body.abilities[1].name, 'Annihilation')
    const bossStrike = body.abilities.find(
      (ability: { name: string }) => ability.name === 'Boss Strike'
    )
    assert.deepEqual(bossStrike, {
      id: '2',
      name: 'Boss Strike',
      damageDone: { damagePerSecond: 0, benchmarkMedian: 0, delta: 0 },
      damageShare: {
        percent: 0,
        benchmarkMedian: 0,
        deltaPercentagePoints: 0,
      },
      damagePerCast: {
        amount: null,
        benchmarkMedian: null,
        delta: null,
        benchmarkSampleSize: 0,
      },
      damageTaken: {
        damageTakenPerSecond: 1_000,
        benchmarkMedian: 2_000,
        delta: -1_000,
      },
      casts: { perMinute: 0, benchmarkMedian: 0, delta: 0 },
    })
    const chaosStrike = body.abilities[0]
    assert.deepEqual(chaosStrike.damageShare, {
      percent: 83.33333333333334,
      benchmarkMedian: 75,
      deltaPercentagePoints: 8.333333333333343,
    })
    assert.deepEqual(chaosStrike.damagePerCast, {
      amount: 10_000,
      benchmarkMedian: 15_000,
      delta: -5_000,
      benchmarkSampleSize: 10,
    })
    assert.deepEqual(chaosStrike.casts, {
      perMinute: 60,
      benchmarkMedian: 60,
      delta: 0,
    })
  })

  assert.equal(mock.calls.length, 4)
  assert.deepEqual(mock.calls[1].variables, {
    encounterID: 3492,
    className: 'DemonHunter',
    specName: 'Havoc',
    difficulty: 4,
  })
  assert.doesNotMatch(mock.calls[1].query, /size:\s*\$raidSize/)
  assert.match(mock.calls[3].query, /dataType:\s*DamageTaken/)
  assert.match(mock.calls[3].query, /dataType:\s*DamageTaken[\s\S]*?sourceID:\s*\$actor/)
  assert.match(mock.calls[3].query, /dataType:\s*Casts/)
})

test('attempt comparison marks talent comparison unavailable when no talents are parsed', async () => {
  const mock = createMockQuery([
    {
      reportData: {
        report: {
          code: 'MyLog',
          title: 'Raid night',
          fights: [
            {
              id: 12,
              name: "Ula'tek",
              startTime: 0,
              endTime: 100_000,
              encounterID: 3492,
              difficulty: 4,
              kill: true,
            },
          ],
          playerDetails: raidPlayerDetails('Sueldh', 100, 1),
        },
      },
    },
    {
      worldData: {
        encounter: {
          id: 3492,
          name: "Ula'tek",
          characterRankings: {
            data: [
              {
                name: 'Ranker',
                server: { name: 'Stormrage' },
                report: { code: 'TopLog', fightID: 1 },
              },
            ],
          },
        },
      },
    },
    {
      reportData: {
        candidate0: {
          fights: [{ id: 1, startTime: 0, endTime: 100_000 }],
          playerDetails: raidPlayerDetails('Ranker', 200, 1),
        },
      },
    },
    {
      reportData: {
        log0: {
          damageDone: { data: { entries: [] } },
          damageTaken: { data: { entries: [] } },
          casts: { data: { entries: [] } },
        },
        log1: {
          damageDone: { data: { entries: [] } },
          damageTaken: { data: { entries: [] } },
          casts: { data: { entries: [] } },
        },
      },
    },
  ])

  await withRouter(createComparisonsRouter(mock.query), async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/character/attempt-comparison?reportCode=MyLog&fightID=12&characterName=Sueldh&server=Stormrage`
    )
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.deepEqual(body.talentComparison, {
      available: false,
      reason:
        'Talent data was not available or could not be parsed for the attempt and benchmark logs.',
      benchmarkSampleSize: 0,
      playerSelected: [],
      commonBenchmarkTalentsNotSelected: [],
    })
  })
})

test('attempt comparison reports no matching logs when Warcraft Logs rankings are empty', async () => {
  const mock = createMockQuery([
    {
      reportData: {
        report: {
          code: 'MyLog',
          title: 'Raid night',
          fights: [
            {
              id: 12,
              name: "Ula'tek",
              startTime: 0,
              endTime: 100_000,
              encounterID: 3492,
              difficulty: 4,
              kill: true,
            },
          ],
          playerDetails: playerDetails('Sueldh', 100),
        },
      },
    },
    {
      worldData: {
        encounter: {
          id: 3492,
          name: "Ula'tek",
          characterRankings: { page: 1, hasMorePages: false, count: 0, rankings: null },
        },
      },
    },
  ])

  await withRouter(createComparisonsRouter(mock.query), async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/character/attempt-comparison?reportCode=MyLog&fightID=12&characterName=Sueldh&server=Stormrage`
    )
    assert.equal(response.status, 404)
    assert.deepEqual(await response.json(), {
      error: 'No matching ranked logs found',
    })
  })

  assert.equal(mock.calls.length, 2)
})

test('attempt comparison exposes errors returned by Warcraft Logs rankings', async () => {
  const mock = createMockQuery([
    {
      reportData: {
        report: {
          code: 'MyLog',
          title: 'Raid night',
          fights: [
            {
              id: 12,
              name: "Ula'tek",
              startTime: 0,
              endTime: 100_000,
              encounterID: 3492,
              difficulty: 4,
              kill: true,
            },
          ],
          playerDetails: playerDetails('Sueldh', 100),
        },
      },
    },
    {
      worldData: {
        encounter: {
          id: 3492,
          name: "Ula'tek",
          characterRankings: { error: 'The supplied filters are invalid' },
        },
      },
    },
  ])

  await withRouter(createComparisonsRouter(mock.query), async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/character/attempt-comparison?reportCode=MyLog&fightID=12&characterName=Sueldh&server=Stormrage`
    )
    assert.equal(response.status, 500)
    assert.deepEqual(await response.json(), {
      error: 'Warcraft Logs rankings error: The supplied filters are invalid',
    })
  })

  assert.equal(mock.calls.length, 2)
})

test('attempt comparison validates required identity before querying Warcraft Logs', async () => {
  const mock = createMockQuery([])

  await withRouter(createComparisonsRouter(mock.query), async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/character/attempt-comparison?reportCode=MyLog&fightID=12`
    )
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), {
      error: 'characterName query param required',
    })
  })

  assert.equal(mock.calls.length, 0)
})
