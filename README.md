# Warcraft Logs Backend

Simple Express + TypeScript backend for the Warcraft Logs v2 GraphQL API (public data via client credentials).

## Setup

1. Create a `.env` file in the project root:
```
WCL_CLIENT_ID=your_client_id
WCL_CLIENT_SECRET=your_client_secret
PORT=3000
```

Get your credentials at https://www.warcraftlogs.com/api/clients  
(Use a confidential client. Redirect URI can be a dummy like `https://google.com`.)

2. Install and run:

```bash
npm install
npm run dev
```
Server runs at http://localhost:3000.

Run the route tests with:

```bash
npm test
```

Examples
```
GET http://localhost:3000/api/rate-limit
GET http://localhost:3000/api/report/YOUR_REPORT_CODE
GET http://localhost:3000/api/character?name=sueldh&server=stormrage&region=US
GET http://localhost:3000/api/character/recent-reports?name=sueldh&server=stormrage&region=US&limit=20
GET http://localhost:3000/api/expansions
GET http://localhost:3000/api/expansions/latest/zones
GET http://localhost:3000/api/expansions/latest/raids
GET http://localhost:3000/api/raids/latest
GET http://localhost:3000/api/expansions/EXPANSION_ID/zones
GET http://localhost:3000/api/encounter/ID/rankings?className=Mage&specName=Fire&difficulty=5
```

Use `/api/expansions/latest/zones` to get zones, encounters, difficulties, and supported
raid sizes for the highest-ID expansion, or `/api/expansions` and
`/api/expansions/:expansionID/zones` to let users choose a different expansion.
Warcraft Logs does not directly mark one zone as the current raid.
`/api/expansions/latest/raids` returns a filtered version of the latest expansion catalog,
excluding PTR, beta, combined-raid, and non-raid zones for a boss selector.
`/api/raids/latest` returns the highest-ID raid from that filtered catalog and its bosses.
Use a selected boss's encounter ID with `/api/encounter/:encounterID/rankings` to fetch its
rankings on demand, passing the player's class, spec, and difficulty. This avoids fetching
rankings for bosses the player has not selected.

Encounter rankings return DPS parses for the requested class. `specName`, `difficulty`,
`page`, and `raidSize` are optional. `raidSize` filters rankings by raid group size; it
does not limit how many rankings are returned. Encounter IDs, supported class/spec names,
difficulties, and raid sizes come from Warcraft Logs.
