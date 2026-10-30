import { Router, Request, Response } from 'express'
import { wclQuery } from '../wcl.js'

const router = Router()

interface ReportFight {
  id: number
  name: string
  startTime: number
  endTime: number
  encounterID: number
  difficulty: number
  kill: boolean
  fightPercentage: number
}

interface Report {
  code: string
  title: string
  startTime: number
  endTime: number
  owner: { name: string } | null
  guild: {
    name: string
    server: { name: string; region: { name: string } }
  } | null
  fights: ReportFight[]
}

router.get('/report/:code', async (req: Request, res: Response) => {
  try {
    const { code } = req.params

    const data = await wclQuery<{ reportData: { report: Report } }>(
      `
      query GetReport($code: String!) {
        reportData {
          report(code: $code) {
            code
            title
            startTime
            endTime
            owner {
              name
            }
            guild {
              name
              server {
                name
                region {
                  name
                }
              }
            }
            fights {
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
    `,
      { code }
    )

    res.json(data.reportData.report)
  } catch (err) {
    console.error(err)
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(500).json({ error: message })
  }
})

router.get('/character', async (req: Request, res: Response) => {
  try {
    const { name, server, region = 'US' } = req.query as {
      name?: string
      server?: string
      region?: string
    }

    if (!name || !server) {
      return res.status(400).json({ error: 'name and server query params required' })
    }

    const data = await wclQuery<{
      characterData: {
        character: {
          id: number
          name: string
          classID: number
          level: number
          server: { name: string; region: { name: string } }
          guilds: { name: string }[]
        } | null
      }
    }>(
      `
      query GetCharacter($name: String!, $serverSlug: String!, $serverRegion: String!) {
        characterData {
          character(name: $name, serverSlug: $serverSlug, serverRegion: $serverRegion) {
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
            guilds {
              name
            }
          }
        }
      }
    `,
      { name, serverSlug: server, serverRegion: region }
    )

    res.json(data.characterData.character)
  } catch (err) {
    console.error(err)
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(500).json({ error: message })
  }
})

router.get('/rate-limit', async (_req: Request, res: Response) => {
  try {
    const data = await wclQuery<{
      rateLimitData: {
        limitPerHour: number
        pointsSpentThisHour: number
        pointsResetIn: number
      }
    }>(`
      query {
        rateLimitData {
          limitPerHour
          pointsSpentThisHour
          pointsResetIn
        }
      }
    `)

    res.json(data.rateLimitData)
  } catch (err) {
    console.error(err)
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(500).json({ error: message })
  }
})

router.get('/character/recent-reports', async (req: Request, res: Response) => {
  try {
    const { name, server, region = 'US', limit = '10' } = req.query as {
      name?: string
      server?: string
      region?: string
      limit?: string
    }

    if (!name || !server) {
      return res.status(400).json({ error: 'name and server required' })
    }

    const data = await wclQuery<{
      characterData: {
        character: {
          recentReports: {
            data: Array<{
              code: string
              title: string
              startTime: number
              endTime: number
              fights: Array<{
                id: number
                name: string
                kill: boolean
                encounterID: number
                difficulty: number
                startTime: number
                endTime: number
              }>
            }>
          }
        } | null
      }
    }>(
      `
      query RecentReports($name: String!, $serverSlug: String!, $serverRegion: String!, $limit: Int!) {
        characterData {
          character(name: $name, serverSlug: $serverSlug, serverRegion: $serverRegion) {
            recentReports(limit: $limit) {
              data {
                code
                title
                startTime
                endTime
                fights {
                  id
                  name
                  kill
                  encounterID
                  difficulty
                  startTime
                  endTime
                }
              }
            }
          }
        }
      }
    `,
      { name, serverSlug: server, serverRegion: region, limit: Number(limit) }
    )

    res.json(data.characterData.character?.recentReports?.data ?? [])
  } catch (err) {
    console.error(err)
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(500).json({ error: message })
  }
})

router.get('/report/:code/fight/:fightID/events', async (req: Request, res: Response) => {
  try {
    const { code, fightID } = req.params
    const dataType = (req.query.dataType as string) || 'Deaths' // try Deaths first
    const startTime = req.query.startTime ? Number(req.query.startTime) : undefined

    const data = await wclQuery<{
      reportData: {
        report: {
          events: {
            data: unknown[]
            nextPageTimestamp: number | null
          }
        }
      }
    }>(
      `
      query FightEvents(
        $code: String!
        $fightID: Int!
        $dataType: EventDataType
        $startTime: Float
      ) {
        reportData {
          report(code: $code) {
            events(
              fightIDs: [$fightID]
              dataType: $dataType
              startTime: $startTime
              limit: 10000
              useActorIDs: true
              useAbilityIDs: true
            ) {
              data
              nextPageTimestamp
            }
          }
        }
      }
    `,
      {
        code,
        fightID: Number(fightID),
        dataType,
        startTime,
      }
    )

    res.json(data.reportData.report.events)
  } catch (err) {
    console.error(err)
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(500).json({ error: message })
  }
})

// GET /api/report/:code/fight/:fightID/full
// Returns fight metadata + actors + events in one response
router.get('/report/:code/fight/:fightID/full', async (req: Request, res: Response) => {
  try {
    const { code, fightID } = req.params
    const dataType = (req.query.dataType as string) || 'All'
    const startTime = req.query.startTime ? Number(req.query.startTime) : undefined

    const data = await wclQuery<{
      reportData: {
        report: {
          code: string
          title: string
          startTime: number
          endTime: number
          masterData: {
            actors: Array<{
              id: number
              name: string
              type: string
              subType: string
              server: string | null
            }>
          }
          fights: Array<{
            id: number
            name: string
            startTime: number
            endTime: number
            encounterID: number
            difficulty: number
            kill: boolean
          }>
          events: {
            data: unknown[]
            nextPageTimestamp: number | null
          }
        }
      }
    }>(
      `
      query FullFight(
        $code: String!
        $fightID: Int!
        $dataType: EventDataType
        $startTime: Float
      ) {
        reportData {
          report(code: $code) {
            code
            title
            startTime
            endTime
            masterData {
              actors {
                id
                name
                type
                subType
                server
              }
            }
            fights(fightIDs: [$fightID]) {
              id
              name
              startTime
              endTime
              encounterID
              difficulty
              kill
            }
            events(
              fightIDs: [$fightID]
              dataType: $dataType
              startTime: $startTime
              limit: 10000
              useActorIDs: true
              useAbilityIDs: true
            ) {
              data
              nextPageTimestamp
            }
          }
        }
      }
    `,
      {
        code,
        fightID: Number(fightID),
        dataType,
        startTime,
      }
    )

    const report = data.reportData.report
    const fight = report.fights[0] ?? null

    res.json({
      report: {
        code: report.code,
        title: report.title,
        startTime: report.startTime,
        endTime: report.endTime,
      },
      fight,
      actors: report.masterData.actors,
      events: report.events,
    })
  } catch (err) {
    console.error(err)
    const message = err instanceof Error ? err.message : 'Unknown error'
    res.status(500).json({ error: message })
  }
})

export default router