interface PlayerSpec {
  spec: string
  count: number
}

export interface PlayerTalent {
  id: string
  name: string | null
  rank: number | null
  nodeID: string | null
}

export interface PlayerDetailsEntry {
  name?: string
  id?: number
  type?: string
  server?: string
  region?: string
  icon?: string
  specs?: PlayerSpec[]
  talents?: PlayerTalent[]
}

export function isRecord(value: unknown): value is Record<string, unknown> {
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
  const combatantInfo = isRecord(value.combatantInfo) ? value.combatantInfo : undefined
  const rawTalents = Array.isArray(combatantInfo?.talentTree)
    ? combatantInfo.talentTree
    : Array.isArray(combatantInfo?.talents)
      ? combatantInfo.talents
    : Array.isArray(value.talents)
      ? value.talents
      : undefined
  const talents = rawTalents?.flatMap((entry) => {
    if (typeof entry === 'number' || typeof entry === 'string') {
      const id = String(entry)
      return [{ id, name: null, rank: null, nodeID: null }]
    }

    if (!isRecord(entry)) return []

    const rawID = entry.id ?? entry.guid
    if (typeof rawID !== 'number' && typeof rawID !== 'string') return []

    const rank =
      typeof entry.rank === 'number'
        ? entry.rank
        : typeof entry.points === 'number'
          ? entry.points
          : null
    if (rank === 0) return []

    const id = String(rawID)
    const nodeID =
      typeof entry.nodeID === 'number' || typeof entry.nodeID === 'string'
        ? String(entry.nodeID)
        : null
    const name =
      typeof entry.name === 'string'
        ? entry.name
        : typeof entry.abilityName === 'string'
          ? entry.abilityName
          : null

    return [{ id, name, rank, nodeID }]
  })

  return {
    name: value.name,
    id: typeof value.id === 'number' ? value.id : undefined,
    type: typeof value.type === 'string' ? value.type : undefined,
    server: typeof value.server === 'string' ? value.server : undefined,
    region: typeof value.region === 'string' ? value.region : undefined,
    icon: typeof value.icon === 'string' ? value.icon : undefined,
    specs,
    talents,
  }
}

function getPlayerGroups(payload: unknown): unknown[][] {
  if (!isRecord(payload) || !isRecord(payload.data) || !isRecord(payload.data.playerDetails)) {
    return []
  }

  return Object.values(payload.data.playerDetails).filter(
    (group): group is unknown[] => Array.isArray(group)
  )
}

export function findPlayerDetails(
  payload: unknown,
  characterName: string,
  server: string
): PlayerDetailsEntry | undefined {
  for (const group of getPlayerGroups(payload)) {
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

export function countPlayers(payload: unknown): number {
  return getPlayerGroups(payload)
    .flatMap((group) => group.map(toPlayerDetailsEntry))
    .filter((player) => player !== undefined).length
}
