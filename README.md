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

Examples
```
GET http://localhost:3000/api/rate-limit
GET http://localhost:3000/api/report/YOUR_REPORT_CODE
GET http://localhost:3000/api/character?name=sueldh&server=stormrage&region=US
GET http://localhost:3000/api/character/recent-reports?name=sueldh&server=stormrage&region=US&limit=20
```
