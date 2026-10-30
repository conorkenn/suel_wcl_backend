import { Request, Response, Router } from 'express'
import { countPlayers, findPlayerDetails, isRecord } from './character-utils.js'
import { wclQuery } from '../wcl.js'

type WclQuery = typeof wclQuery

interface RankingEntry {
  name: string
  server: string
  reportCode: string
  fightID: number
  amount?: number
  rankPercent?: number
}

interface FightMetadata {
  id: number
  startTime: number
  endTime: number
}

interface ComparisonLog extends RankingEntry {
  actorID: number
  durationMs: number
}

type AbilityMetric = 'damageDone' | 'damageTaken' | 'casts'

interface AbilityValue {
  key: string
  name: string
  value: number
}

interface LogMetrics {
  damageDone: Map<string, AbilityValue>
  damageTaken: Map<string, AbilityValue>
  casts: Map<string, AbilityValue>
  durationMs: number
}

const parsePositiveInteger = (value: unknown): number | undefined => {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    return undefined
  }

  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function getRankingRows(value: unknown, depth = 0): unknown[] | undefined {
  if (depth > 5) return undefined
  if (value === null || value === undefined) return []
  if (Array.isArray(value)) return value

  if (typeof value === 'string') {
    try {
      return getRankingRows(JSON.parse(value), depth + 1)
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error('Warcraft Logs returned rankings as invalid JSON')
      }
      throw error
    }
  }

  if (!isRecord(value)) return undefined
  if ('error' in value) {
    const upstreamError =
      typeof value.error === 'string'
        ? value.error
        : isRecord(value.error) && typeof value.error.message === 'string'
          ? value.error.message
          : JSON.stringify(value.error)
    throw new Error(`Warcraft Logs rankings error: ${upstreamError}`)
  }
  if (typeof value.count === 'number' && value.count === 0) return []

  for (const key of ['rankings', 'data', 'entries']) {
    if (key in value) {
      const rows = getRankingRows(value[key], depth + 1)
      if (rows !== undefined) return rows
    }
  }

  return undefined
}

function getRankingEntries(value: unknown): RankingEntry[] {
  const rows = getRankingRows(value)

  if (!rows) {
    const shape = isRecord(value)
      ? `object with keys: ${Object.keys(value).join(', ') || '(none)'}`
      : typeof value
    throw new Error(`Warcraft Logs returned rankings in an unexpected format (${shape})`)
  }

  return rows.flatMap((row) => {
    if (!isRecord(row) || !isRecord(row.report)) return []

    const reportCode = row.report.code
    const fightID =
      typeof row.report.fightID === 'number'
        ? row.report.fightID
        : parsePositiveInteger(row.report.fightID)
    const name = typeof row.name === 'string' ? row.name : undefined
    const server = isRecord(row.server)
      ? typeof row.server.name === 'string'
        ? row.server.name
        : undefined
      : typeof row.server === 'string'
        ? row.server
        : undefined

    if (
      typeof reportCode !== 'string' ||
      !name ||
      !server ||
      !fightID ||
      !Number.isSafeInteger(fightID)
    ) {
      return []
    }

    return [
      {
        name,
        server,
        reportCode,
        fightID,
        amount: typeof row.amount === 'number' ? row.amount : undefined,
        rankPercent: typeof row.rankPercent === 'number' ? row.rankPercent : undefined,
      },
    ]
  })
}

function getFightByID(value: unknown, fightID: number): FightMetadata | undefined {
  if (!Array.isArray(value)) return undefined

  const fight = value.find((entry) => isRecord(entry) && entry.id === fightID)
  if (
    !isRecord(fight) ||
    typeof fight.startTime !== 'number' ||
    typeof fight.endTime !== 'number'
  ) {
    return undefined
  }

  return {
    id: fightID,
    startTime: fight.startTime,
    endTime: fight.endTime,
  }
}

function getTableRows(value: unknown, depth = 0): unknown[] | undefined {
  if (depth > 5) return undefined
  if (Array.isArray(value)) return value

  if (typeof value === 'string') {
    try {
      return getTableRows(JSON.parse(value), depth + 1)
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error('Warcraft Logs returned table data as invalid JSON')
      }
      throw error
    }
  }

  if (!isRecord(value)) return undefined

  for (const key of ['entries', 'data', 'table']) {
    if (key in value) {
      const rows = getTableRows(value[key], depth + 1)
      if (rows !== undefined) return rows
    }
  }

  return undefined
}

function getAbilityRows(value: unknown, metric: AbilityMetric): Map<string, AbilityValue> {
  const rows = getTableRows(value)

  if (!rows) {
    const shape = isRecord(value)
      ? `object with keys: ${Object.keys(value).join(', ') || '(none)'}`
      : typeof value
    throw new Error(`Warcraft Logs returned ${metric} data in an unexpected format (${shape})`)
  }

  return new Map(
    rows.flatMap((row) => {
      if (!isRecord(row) || typeof row.name !== 'string') return []

      const rawValue =
        metric === 'casts'
          ? typeof row.uses === 'number'
            ? row.uses
            : row.total
          : row.total
      if (typeof rawValue !== 'number' || !Number.isFinite(rawValue)) return []

      const key =
        typeof row.guid === 'number' || typeof row.guid === 'string'
          ? String(row.guid)
          : row.name.toLowerCase()

      return [[key, { key, name: row.name, value: rawValue }] as const]
    })
  )
}

function median(values: number[]): number {
  if (values.length === 0) return 0

  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
}

function sum(values: Iterable<AbilityValue>): number {
  return Array.from(values).reduce((total, entry) => total + entry.value, 0)
}

function rateFor(metric: AbilityMetric, value: number, durationMs: number): number {
  const durationSeconds = durationMs / 1000
  return metric === 'casts'
    ? value / (durationSeconds / 60)
    : value / durationSeconds
}

function compareRate(
  metric: AbilityMetric,
  value: number,
  benchmarkValues: number[]
) {
  const perUnit =
    metric === 'casts'
      ? 'perMinute'
      : metric === 'damageDone'
        ? 'damagePerSecond'
        : 'damageTakenPerSecond'
  const benchmarkMedian = median(benchmarkValues)

  return {
    [perUnit]: value,
    benchmarkMedian,
    delta: value - benchmarkMedian,
  }
}

function buildBatchTableQuery(logs: ComparisonLog[]) {
  const variableDefinitions = logs
    .map(
      (_, index) =>
        `$code${index}: String!, $fight${index}: Int!, $actor${index}: Int!`
    )
    .join(', ')
  const reports = logs
    .map(
      (_, index) => `
        log${index}: report(code: $code${index}) {
          damageDone: table(
            dataType: DamageDone
            viewBy: Ability
            fightIDs: [$fight${index}]
            sourceID: $actor${index}
          )
          damageTaken: table(
            dataType: DamageTaken
            viewBy: Ability
            fightIDs: [$fight${index}]
            sourceID: $actor${index}
          )
          casts: table(
            dataType: Casts
            viewBy: Ability
            fightIDs: [$fight${index}]
            sourceID: $actor${index}
          )
        }
      `
    )
    .join('\n')
  const variables = Object.fromEntries(
    logs.flatMap((log, index) => [
      [`code${index}`, log.reportCode],
      [`fight${index}`, log.fightID],
      [`actor${index}`, log.actorID],
    ])
  )

  return {
    query: `
      query AttemptComparisonTables(${variableDefinitions}) {
        reportData {
          ${reports}
        }
      }
    `,
    variables,
  }
}

export function createComparisonsRouter(queryWcl: WclQuery = wclQuery) {
  const router = Router()

  router.get('/character/attempt-comparison', async (req: Request, res: Response) => {
    const { reportCode, fightID, characterName, server } = req.query

    if (typeof reportCode !== 'string' || !reportCode.trim()) {
      return res.status(400).json({ error: 'reportCode query param required' })
    }
    if (typeof characterName !== 'string' || !characterName.trim()) {
      return res.status(400).json({ error: 'characterName query param required' })
    }
    if (typeof server !== 'string' || !server.trim()) {
      return res.status(400).json({ error: 'server query param required' })
    }

    const parsedFightID = parsePositiveInteger(fightID)
    if (!parsedFightID) {
      return res.status(400).json({ error: 'fightID must be a positive integer' })
    }

    try {
      const attemptData = await queryWcl<{
        reportData: {
          report: {
            code: string
            title: string
            fights: Array<{
              id: number
              name: string
              startTime: number
              endTime: number
              encounterID: number
              difficulty: number
              kill: boolean
            }>
            playerDetails: unknown
          } | null
        }
      }>(
        `
        query AttemptComparisonDetails($reportCode: String!, $fightID: Int!) {
          reportData {
            report(code: $reportCode) {
              code
              title
              fights(fightIDs: [$fightID]) {
                id
                name
                startTime
                endTime
                encounterID
                difficulty
                kill
              }
              playerDetails(fightIDs: [$fightID], includeCombatantInfo: true)
            }
          }
        }
      `,
        { reportCode: reportCode.trim(), fightID: parsedFightID }
      )

      const report = attemptData.reportData.report
      if (!report) {
        return res.status(404).json({ error: 'Report not found' })
      }

      const fight = report.fights[0]
      if (!fight) {
        return res.status(404).json({ error: 'Fight not found in report' })
      }

      const player = findPlayerDetails(
        report.playerDetails,
        characterName.trim(),
        server.trim()
      )
      if (!player) {
        return res.status(404).json({ error: 'Character not found in fight' })
      }
      if (!player.id || !player.type || !player.specs?.length) {
        return res.status(422).json({
          error: 'The selected fight does not include the character class, spec, or actor ID',
        })
      }

      const selectedSpec = [...player.specs].sort((a, b) => b.count - a.count)[0].spec
      const raidSize = countPlayers(report.playerDetails)
      const rankingData = await queryWcl<{
        worldData: {
          encounter: { id: number; name: string; characterRankings: unknown } | null
        }
      }>(
        `
        query AttemptComparisonRankings(
          $encounterID: Int!
          $className: String!
          $specName: String!
          $difficulty: Int!
        ) {
          worldData {
            encounter(id: $encounterID) {
              id
              name
              characterRankings(
                className: $className
                specName: $specName
                difficulty: $difficulty
                metric: dps
                page: 1
                includeCombatantInfo: true
              )
            }
          }
        }
      `,
        {
          encounterID: fight.encounterID,
          className: player.type,
          specName: selectedSpec,
          difficulty: fight.difficulty,
        }
      )

      const encounter = rankingData.worldData.encounter
      if (!encounter) {
        return res.status(404).json({ error: 'Encounter not found' })
      }

      const rankingEntries = getRankingEntries(encounter.characterRankings)
        .filter(
          (entry) =>
            entry.reportCode !== report.code || entry.fightID !== fight.id
        )
        .slice(0, 10)
      if (rankingEntries.length === 0) {
        return res.status(404).json({ error: 'No matching ranked logs found' })
      }

      const metadataVariables = Object.fromEntries(
        rankingEntries.flatMap((entry, index) => [
          [`code${index}`, entry.reportCode],
          [`fight${index}`, entry.fightID],
        ])
      )
      const metadataFields = rankingEntries
        .map(
          (_, index) => `
            candidate${index}: report(code: $code${index}) {
              fights(fightIDs: [$fight${index}]) {
                id
                startTime
                endTime
              }
              playerDetails(fightIDs: [$fight${index}], includeCombatantInfo: true)
            }
          `
        )
        .join('\n')
      const metadataDefinitions = rankingEntries
        .map((_, index) => `$code${index}: String!, $fight${index}: Int!`)
        .join(', ')
      const metadata = await queryWcl<{ reportData: Record<string, unknown> }>(
        `
        query AttemptComparisonCandidates(${metadataDefinitions}) {
          reportData {
            ${metadataFields}
          }
        }
      `,
        metadataVariables
      )

      const comparisonLogs: Array<ComparisonLog & { raidSize: number }> = rankingEntries.flatMap((entry, index) => {
        const candidate = metadata.reportData[`candidate${index}`]
        if (!isRecord(candidate)) return []

        const candidateFight = getFightByID(candidate.fights, entry.fightID)
        const candidatePlayer = findPlayerDetails(
          candidate.playerDetails,
          entry.name,
          entry.server
        )
        const candidateRaidSize = countPlayers(candidate.playerDetails)
        if (
          !candidateFight ||
          candidateFight.endTime <= candidateFight.startTime ||
          !candidatePlayer?.id ||
          candidatePlayer.type?.toLowerCase() !== player.type?.toLowerCase() ||
          !candidatePlayer.specs?.some(
            (spec) => spec.spec.toLowerCase() === selectedSpec.toLowerCase()
          ) ||
          !candidateRaidSize
        ) {
          return []
        }

        return [
          {
            ...entry,
            actorID: candidatePlayer.id,
            durationMs: candidateFight.endTime - candidateFight.startTime,
            raidSize: candidateRaidSize,
          },
        ]
      })

      if (comparisonLogs.length === 0) {
        return res.status(422).json({
          error: 'No top-ranked logs could be matched to the requested character and spec',
        })
      }

      const attemptDurationMs = fight.endTime - fight.startTime
      if (attemptDurationMs <= 0) {
        return res.status(422).json({ error: 'Selected fight has an invalid duration' })
      }

      const allLogs: ComparisonLog[] = [
        {
          name: player.name ?? characterName.trim(),
          server: player.server ?? server.trim(),
          reportCode: report.code,
          fightID: fight.id,
          actorID: player.id,
          durationMs: attemptDurationMs,
        },
        ...comparisonLogs,
      ]
      const tableQuery = buildBatchTableQuery(allLogs)
      const tableData = await queryWcl<{ reportData: Record<string, unknown> }>(
        tableQuery.query,
        tableQuery.variables
      )

      const logMetrics = allLogs.map((log, index): LogMetrics => {
        const response = tableData.reportData[`log${index}`]
        if (!isRecord(response)) {
          throw new Error(`Warcraft Logs returned no tables for ${log.reportCode}`)
        }

        return {
          damageDone: getAbilityRows(response.damageDone, 'damageDone'),
          damageTaken: getAbilityRows(response.damageTaken, 'damageTaken'),
          casts: getAbilityRows(response.casts, 'casts'),
          durationMs: log.durationMs,
        }
      })
      const [attemptMetrics, ...benchmarkMetrics] = logMetrics

      const abilityKeys = new Set<string>()
      for (const metrics of logMetrics) {
        for (const metric of ['damageDone', 'damageTaken', 'casts'] as const) {
          for (const key of metrics[metric].keys()) abilityKeys.add(key)
        }
      }

      const attemptTotalDamage = sum(attemptMetrics.damageDone.values())
      const abilities = [...abilityKeys]
        .map((key) => {
          const ownName =
            attemptMetrics.damageDone.get(key)?.name ??
            attemptMetrics.damageTaken.get(key)?.name ??
            attemptMetrics.casts.get(key)?.name ??
            benchmarkMetrics
              .map(
                (metrics) =>
                  metrics.damageDone.get(key)?.name ??
                  metrics.damageTaken.get(key)?.name ??
                  metrics.casts.get(key)?.name
              )
              .find((name) => name !== undefined) ??
            key

          const compareAbilityMetric = (metric: AbilityMetric) => {
            const ownValue = attemptMetrics[metric].get(key)?.value ?? 0
            const ownRate = rateFor(metric, ownValue, attemptMetrics.durationMs)
            const benchmarkRates = benchmarkMetrics.map((metrics) => {
              const value = metrics[metric].get(key)?.value ?? 0
              return rateFor(metric, value, metrics.durationMs)
            })

            return compareRate(metric, ownRate, benchmarkRates)
          }

          const ownDamage = attemptMetrics.damageDone.get(key)?.value ?? 0
          const ownCasts = attemptMetrics.casts.get(key)?.value ?? 0
          const ownDamageShare = attemptTotalDamage > 0
            ? (ownDamage / attemptTotalDamage) * 100
            : 0
          const benchmarkDamageShares = benchmarkMetrics.flatMap((metrics) => {
            const totalDamage = sum(metrics.damageDone.values())
            return totalDamage > 0
              ? [((metrics.damageDone.get(key)?.value ?? 0) / totalDamage) * 100]
              : []
          })
          const benchmarkDamagePerCast = benchmarkMetrics.flatMap((metrics) => {
            const casts = metrics.casts.get(key)?.value ?? 0
            return casts > 0
              ? [(metrics.damageDone.get(key)?.value ?? 0) / casts]
              : []
          })

          return {
            id: key,
            name: ownName,
            damageDone: compareAbilityMetric('damageDone'),
            damageShare: {
              percent: ownDamageShare,
              benchmarkMedian: median(benchmarkDamageShares),
              deltaPercentagePoints: ownDamageShare - median(benchmarkDamageShares),
            },
            damagePerCast: {
              amount: ownCasts > 0 ? ownDamage / ownCasts : null,
              benchmarkMedian:
                benchmarkDamagePerCast.length > 0 ? median(benchmarkDamagePerCast) : null,
              delta:
                ownCasts > 0 && benchmarkDamagePerCast.length > 0
                  ? ownDamage / ownCasts - median(benchmarkDamagePerCast)
                  : null,
              benchmarkSampleSize: benchmarkDamagePerCast.length,
            },
            damageTaken: compareAbilityMetric('damageTaken'),
            casts: compareAbilityMetric('casts'),
          }
        })
        .sort((a, b) => a.damageDone.delta - b.damageDone.delta)

      const summaryMetric = (metric: AbilityMetric) => {
        const attemptTotal = sum(attemptMetrics[metric].values())
        const attemptRate = rateFor(metric, attemptTotal, attemptMetrics.durationMs)
        const benchmarkRates = benchmarkMetrics.map((metrics) =>
          rateFor(metric, sum(metrics[metric].values()), metrics.durationMs)
        )
        return {
          total: attemptTotal,
          ...compareRate(metric, attemptRate, benchmarkRates),
        }
      }

      res.json({
        report: { code: report.code, title: report.title },
        fight: {
          id: fight.id,
          name: fight.name,
          encounterID: fight.encounterID,
          difficulty: fight.difficulty,
          durationMs: attemptDurationMs,
        },
        player: {
          name: player.name,
          class: player.type,
          spec: selectedSpec,
          server: player.server,
        },
        benchmark: {
          method: 'median',
          requestedParses: 10,
          sampleSize: comparisonLogs.length,
          filters: {
            encounterID: fight.encounterID,
            difficulty: fight.difficulty,
            className: player.type,
            specName: selectedSpec,
            raidSize: null,
          },
          playerRaidSize: raidSize || null,
          raidSizeFilterApplied: false,
          topLogs: comparisonLogs.map((entry) => ({
            name: entry.name,
            server: entry.server,
            reportCode: entry.reportCode,
            fightID: entry.fightID,
            raidSize: entry.raidSize,
            rankingDps: entry.amount ?? null,
            rankPercent: entry.rankPercent ?? null,
          })),
        },
        summary: {
          damageDone: summaryMetric('damageDone'),
          damageTaken: summaryMetric('damageTaken'),
          casts: summaryMetric('casts'),
        },
        abilities,
      })
    } catch (err) {
      console.error(err)
      const message = err instanceof Error ? err.message : 'Unknown error'
      res.status(500).json({ error: message })
    }
  })

  return router
}

export default createComparisonsRouter()
