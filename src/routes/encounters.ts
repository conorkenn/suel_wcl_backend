import { Router, Request, Response } from 'express'
import { wclQuery } from '../wcl.js'

const parsePositiveInteger = (value: unknown): number | undefined => {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    return undefined
  }

  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

type WclQuery = typeof wclQuery

interface ExpansionZones {
  id: number
  name: string
  zones: Array<{
    id: number
    name: string
    difficulties: Array<{
      id: number
      name: string
      sizes: number[]
    }>
    encounters: Array<{ id: number; name: string }>
  }> | null
}

async function getExpansionZones(
  expansionID: number,
  queryWcl: WclQuery
): Promise<ExpansionZones | null> {
  const data = await queryWcl<{
    worldData: {
      expansion: ExpansionZones | null
    }
  }>(
    `
    query GetExpansionZones($expansionID: Int!) {
      worldData {
        expansion(id: $expansionID) {
          id
          name
          zones {
            id
            name
            difficulties {
              id
              name
              sizes
            }
            encounters {
              id
              name
            }
          }
        }
      }
    }
  `,
    { expansionID }
  )

  return data.worldData.expansion
}

async function getLatestExpansionZones(queryWcl: WclQuery): Promise<ExpansionZones | null> {
  const data = await queryWcl<{
    worldData: {
      expansions: Array<{ id: number; name: string }>
    }
  }>(`
    query GetLatestExpansion {
      worldData {
        expansions {
          id
          name
        }
      }
    }
  `)

  const latestExpansion = data.worldData.expansions.reduce<
    { id: number; name: string } | undefined
  >((latest, expansion) => (!latest || expansion.id > latest.id ? expansion : latest), undefined)

  if (!latestExpansion) {
    return null
  }

  return getExpansionZones(latestExpansion.id, queryWcl)
}

function getRaidZones(expansion: ExpansionZones): ExpansionZones {
  return {
    ...expansion,
    zones:
      expansion.zones
        ?.filter((zone) => {
          const name = zone.name.toLowerCase()
          const isDevelopmentZone = name.includes('ptr') || name.includes('beta')
          const isCombinedZone = name.includes('complete raid')
          const hasRaidDifficulty = zone.difficulties.some(
            (difficulty) => difficulty.id === 1 || difficulty.id === 5
          )

          return (
            !isDevelopmentZone &&
            !isCombinedZone &&
            hasRaidDifficulty &&
            zone.encounters.length > 0
          )
        })
        .sort((a, b) => b.id - a.id) ?? null,
  }
}

function getLatestRaid(expansion: ExpansionZones) {
  const raid = getRaidZones(expansion).zones?.[0]
  if (!raid) {
    return null
  }

  return {
    expansion: { id: expansion.id, name: expansion.name },
    raid,
  }
}

export function createEncountersRouter(queryWcl: WclQuery = wclQuery) {
  const router = Router()

  router.get('/expansions', async (_req: Request, res: Response) => {
    try {
      const data = await queryWcl<{
        worldData: {
          expansions: Array<{ id: number; name: string }>
        }
      }>(`
        query GetExpansions {
          worldData {
            expansions {
              id
              name
            }
          }
        }
      `)

      res.json(data.worldData.expansions)
    } catch (err) {
      console.error(err)
      const message = err instanceof Error ? err.message : 'Unknown error'
      res.status(500).json({ error: message })
    }
  })

  router.get('/expansions/latest/zones', async (_req: Request, res: Response) => {
    try {
      const expansion = await getLatestExpansionZones(queryWcl)
      if (!expansion) {
        return res.status(404).json({ error: 'No expansions found' })
      }

      res.json(expansion)
    } catch (err) {
      console.error(err)
      const message = err instanceof Error ? err.message : 'Unknown error'
      res.status(500).json({ error: message })
    }
  })

  router.get('/expansions/latest/raids', async (_req: Request, res: Response) => {
    try {
      const expansion = await getLatestExpansionZones(queryWcl)
      if (!expansion) {
        return res.status(404).json({ error: 'No expansions found' })
      }

      res.json(getRaidZones(expansion))
    } catch (err) {
      console.error(err)
      const message = err instanceof Error ? err.message : 'Unknown error'
      res.status(500).json({ error: message })
    }
  })

  router.get('/raids/latest', async (_req: Request, res: Response) => {
    try {
      const expansion = await getLatestExpansionZones(queryWcl)
      if (!expansion) {
        return res.status(404).json({ error: 'No expansions found' })
      }

      const latestRaid = getLatestRaid(expansion)
      if (!latestRaid) {
        return res.status(404).json({ error: 'No raids found in the latest expansion' })
      }

      res.json(latestRaid)
    } catch (err) {
      console.error(err)
      const message = err instanceof Error ? err.message : 'Unknown error'
      res.status(500).json({ error: message })
    }
  })

  router.get('/expansions/:expansionID/zones', async (req: Request, res: Response) => {
    const expansionID = parsePositiveInteger(req.params.expansionID)
    if (!expansionID) {
      return res.status(400).json({ error: 'expansionID must be a positive integer' })
    }

    try {
      const expansion = await getExpansionZones(expansionID, queryWcl)
      if (!expansion) {
        return res.status(404).json({ error: 'Expansion not found' })
      }

      res.json(expansion)
    } catch (err) {
      console.error(err)
      const message = err instanceof Error ? err.message : 'Unknown error'
      res.status(500).json({ error: message })
    }
  })

  router.get('/encounter/:encounterID/rankings', async (req: Request, res: Response) => {
    const encounterID = parsePositiveInteger(req.params.encounterID)
    const { className, specName, difficulty, page, raidSize } = req.query

    if (!encounterID) {
      return res.status(400).json({ error: 'encounterID must be a positive integer' })
    }

    if (typeof className !== 'string' || !className.trim()) {
      return res.status(400).json({ error: 'className query param required' })
    }

    if (specName !== undefined && (typeof specName !== 'string' || !specName.trim())) {
      return res.status(400).json({ error: 'specName must be a non-empty string' })
    }

    const parsedDifficulty = difficulty === undefined ? undefined : parsePositiveInteger(difficulty)
    const parsedPage = page === undefined ? undefined : parsePositiveInteger(page)
    const parsedRaidSize = raidSize === undefined ? undefined : parsePositiveInteger(raidSize)

    if (difficulty !== undefined && parsedDifficulty === undefined) {
      return res.status(400).json({ error: 'difficulty must be a positive integer' })
    }
    if (page !== undefined && parsedPage === undefined) {
      return res.status(400).json({ error: 'page must be a positive integer' })
    }
    if (raidSize !== undefined && parsedRaidSize === undefined) {
      return res.status(400).json({ error: 'raidSize must be a positive integer' })
    }

    try {
      const data = await queryWcl<{
        worldData: {
          encounter: {
            id: number
            name: string
            characterRankings: unknown
          } | null
        }
      }>(
        `
        query EncounterCharacterRankings(
          $encounterID: Int!
          $className: String!
          $specName: String
          $difficulty: Int
          $page: Int
          $raidSize: Int
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
                page: $page
                size: $raidSize
                includeCombatantInfo: true
              )
            }
          }
        }
      `,
        {
          encounterID,
          className: className.trim(),
          specName: typeof specName === 'string' ? specName.trim() : undefined,
          difficulty: parsedDifficulty,
          page: parsedPage,
          raidSize: parsedRaidSize,
        }
      )

      const encounter = data.worldData.encounter
      if (!encounter) {
        return res.status(404).json({ error: 'Encounter not found' })
      }

      res.json({
        encounter: { id: encounter.id, name: encounter.name },
        className: className.trim(),
        specName: typeof specName === 'string' ? specName.trim() : null,
        difficulty: parsedDifficulty ?? null,
        raidSize: parsedRaidSize ?? null,
        metric: 'dps',
        rankings: encounter.characterRankings,
      })
    } catch (err) {
      console.error(err)
      const message = err instanceof Error ? err.message : 'Unknown error'
      res.status(500).json({ error: message })
    }
  })

  return router
}

export default createEncountersRouter()
