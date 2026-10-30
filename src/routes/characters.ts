import { Router, Request, Response } from 'express'
import { wclQuery } from '../wcl.js'

type WclQuery = typeof wclQuery

const parsePositiveInteger = (value: unknown): number | undefined => {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    return undefined
  }

  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

interface PlayerSpec {
  spec: string
  count: number
}

interface PlayerDetailsEntry {
  name?: string
  id?: number
  type?: string
  server?: string
  region?: string
  icon?: string
  specs?: PlayerSpec[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toPlayerDetailsEntry(value: unknown): PlayerDetailsEntry | undefined {
  if (!isRecord(value) || typeof value.name !== 'string') return undefined

  const specs = Array.isArray(value.specs)
    ? value.specs.flatMap((entry) =>
        isRecord(entry) && typeof entry.spec === 'string' && typeof entry.count === 'number'
          ? [{ spec: entry.spec, count: entry.count }]
          : []
      )
    : undefined

  return {
    name: value.name,
    id: typeof value.id === 'number' ? value.id : undefined,
    type: typeof value.type === 'string' ? value.type : undefined,
    server: typeof value.server === 'string' ? value.server : undefined,
    region: typeof value.region === 'string' ? value.region : undefined,
    icon: typeof value.icon === 'string' ? value.icon : undefined,
    specs,
  }
}

function findPlayerDetails(
  payload: unknown,
  characterName: string,
  server: string
): PlayerDetailsEntry | undefined {
  if (!isRecord(payload) || !isRecord(payload.data) || !isRecord(payload.data.playerDetails)) {
    return undefined
  }

  const groups = Object.values(payload.data.playerDetails)
  for (const group of groups) {
    if (!Array.isArray(group)) continue

    const player = group
      .map(toPlayerDetailsEntry)
      .find(
        (entry) =>
          entry?.name?.toLowerCase() === characterName.toLowerCase() &&
          entry.server?.toLowerCase() === server.toLowerCase()
      )

    if (player) return player
  }

  return undefined
}

export function createCharactersRouter(queryWcl: WclQuery = wclQuery) {
  const router = Router()

  router.get('/character/attempt-details', async (req: Request, res: Response) => {
    const { reportCode, fightID, characterName, server } = req.query

    if (typeof reportCode !== 'string' || !reportCode.trim()) {
      return res.status(400).json({ error: 'reportCode query param required' })
    }

    if (
      (characterName !== undefined && (typeof characterName !== 'string' || !characterName.trim())) ||
      (server !== undefined && (typeof server !== 'string' || !server.trim()))
    ) {
      return res.status(400).json({ error: 'characterName and server must be non-empty strings' })
    }

    if ((characterName === undefined) !== (server === undefined)) {
      return res.status(400).json({ error: 'characterName and server must be provided together' })
    }

    const parsedFightID = parsePositiveInteger(fightID)
    if (!parsedFightID) {
      return res.status(400).json({ error: 'fightID must be a positive integer' })
    }

    try {
      const data = await queryWcl<{
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
              fightPercentage: number
            }>
            playerDetails: unknown
          } | null
        }
      }>(
        `
        query CharacterAttemptDetails($reportCode: String!, $fightID: Int!) {
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
                fightPercentage
              }
              playerDetails(fightIDs: [$fightID], includeCombatantInfo: true)
            }
          }
        }
      `,
        { reportCode: reportCode.trim(), fightID: parsedFightID }
      )

      const report = data.reportData.report
      if (!report) {
        return res.status(404).json({ error: 'Report not found' })
      }

      const fight = report.fights[0]
      if (!fight) {
        return res.status(404).json({ error: 'Fight not found in report' })
      }

      const player =
        typeof characterName === 'string' && typeof server === 'string'
          ? findPlayerDetails(report.playerDetails, characterName.trim(), server.trim())
          : undefined

      res.json({
        report: { code: report.code, title: report.title },
        fight,
        player: player
          ? {
            name: player.name,
            id: player.id,
            class: player.type,
            server: player.server,
            region: player.region,
            icon: player.icon,
            specs: player.specs ?? [],
          }
          : null,
        characterFound: typeof characterName === 'string' ? !!player : null,
        playerDetails: report.playerDetails,
      })
    } catch (err) {
      console.error(err)
      const message = err instanceof Error ? err.message : 'Unknown error'
      res.status(500).json({ error: message })
    }
  })

  router.get('/character/encounter-attempts', async (req: Request, res: Response) => {
    const { name, server, region = 'US', encounterID, difficulty, page, limit } = req.query

    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name query param required' })
    }

    if (typeof server !== 'string' || !server.trim()) {
      return res.status(400).json({ error: 'server query param required' })
    }

    if (typeof region !== 'string' || !region.trim()) {
      return res.status(400).json({ error: 'region must be a non-empty string' })
    }

    const parsedEncounterID = parsePositiveInteger(encounterID)
    if (!parsedEncounterID) {
      return res.status(400).json({ error: 'encounterID must be a positive integer' })
    }

    const parsedDifficulty =
      difficulty === undefined ? undefined : parsePositiveInteger(difficulty)
    if (difficulty !== undefined && !parsedDifficulty) {
      return res.status(400).json({ error: 'difficulty must be a positive integer' })
    }

    const parsedPage = page === undefined ? 1 : parsePositiveInteger(page)
    if (!parsedPage) {
      return res.status(400).json({ error: 'page must be a positive integer' })
    }

    const parsedLimit = limit === undefined ? 10 : parsePositiveInteger(limit)
    if (!parsedLimit || parsedLimit > 25) {
      return res.status(400).json({ error: 'limit must be an integer between 1 and 25' })
    }

    try {
      const data = await queryWcl<{
        characterData: {
          character: {
            id: number
            name: string
            classID: number
            level: number
            server: { name: string; region: { name: string } }
            recentReports: {
              total: number
              per_page: number
              current_page: number
              last_page: number
              has_more_pages: boolean
              data: Array<{
                code: string
                title: string
                startTime: number
                endTime: number
                fights: Array<{
                  id: number
                  name: string
                  startTime: number
                  endTime: number
                  encounterID: number
                  difficulty: number
                  kill: boolean
                  fightPercentage: number
                }>
              }>
            } | null
          } | null
        }
      }>(
        `
        query CharacterEncounterAttempts(
          $name: String!
          $serverSlug: String!
          $serverRegion: String!
          $encounterID: Int!
          $difficulty: Int
          $page: Int!
          $limit: Int!
        ) {
          characterData {
            character(
              name: $name
              serverSlug: $serverSlug
              serverRegion: $serverRegion
            ) {
              id
              name
              classID
              level
              server {
                name
                region {
                  name
                }
              }
              recentReports(limit: $limit, page: $page) {
                total
                per_page
                current_page
                last_page
                has_more_pages
                data {
                  code
                  title
                  startTime
                  endTime
                  fights(encounterID: $encounterID, difficulty: $difficulty) {
                    id
                    name
                    startTime
                    endTime
                    encounterID
                    difficulty
                    kill
                    fightPercentage
                  }
                }
              }
            }
          }
        }
      `,
        {
          name: name.trim(),
          serverSlug: server.trim(),
          serverRegion: region.trim(),
          encounterID: parsedEncounterID,
          difficulty: parsedDifficulty,
          page: parsedPage,
          limit: parsedLimit,
        }
      )

      const character = data.characterData.character
      if (!character) {
        return res.status(404).json({ error: 'Character not found' })
      }

      const { recentReports, ...characterDetails } = character
      const attempts = recentReports?.data.flatMap((report) =>
        report.fights.map((fight) => ({
          report: {
            code: report.code,
            title: report.title,
            startTime: report.startTime,
            endTime: report.endTime,
          },
          fight,
        }))
      )

      res.json({
        character: characterDetails,
        encounterID: parsedEncounterID,
        difficulty: parsedDifficulty ?? null,
        pagination: recentReports
          ? {
              total: recentReports.total,
              perPage: recentReports.per_page,
              currentPage: recentReports.current_page,
              lastPage: recentReports.last_page,
              hasMorePages: recentReports.has_more_pages,
            }
          : null,
        attempts: attempts ?? [],
      })
    } catch (err) {
      console.error(err)
      const message = err instanceof Error ? err.message : 'Unknown error'
      res.status(500).json({ error: message })
    }
  })

  return router
}

export default createCharactersRouter()
