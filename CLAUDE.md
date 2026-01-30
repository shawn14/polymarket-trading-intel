# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Polymarket Trading Intelligence System — detects truth-changing events before Polymarket prices adjust. The system monitors primary settlement sources (not news/Twitter) and alerts on meaningful changes.

## Development Commands

```bash
npm install          # Install dependencies
npm run dev          # Run with hot reload (tsx watch)
npm run build        # Compile TypeScript to dist/
npm run start        # Run compiled output
npm run typecheck    # Type check without emitting
npm run lint         # Run ESLint
```

## Architecture

### Data Source Hierarchy

**Tier 1 (Truth Sources):** Official settlement authorities — Congress.gov, NHC/NWS, FOMC statements, official sports injury reports. These are the ONLY sources that can trigger high-confidence alerts.

**Tier 2 (Market Signals):** Polymarket WebSocket, order book microstructure, cross-platform divergence (Kalshi, Betfair). Used for flow detection.

**Tier 3 (Context):** GDELT, NewsAPI, social media. Never fire alerts on Tier 3 alone.

### Source Directory Structure

- `src/ingestion/` — Data source connectors (polymarket, congress, weather, fed, geopolitical)
- `src/signals/` — Detection engine (truth-change, market-flow, confidence scoring)
- `src/alerts/` — Alert formatting and delivery
- `src/playbooks/` — Market-specific logic (shutdown.ts, hurricane.ts, fed-decision.ts, sports.ts)
- `src/api/` — REST API for dashboard

### Polymarket Client

The `PolymarketClient` in `src/ingestion/polymarket/` connects to the CLOB WebSocket:

```typescript
import { PolymarketClient } from './ingestion/polymarket/index.js';

const client = new PolymarketClient({ autoReconnect: true });

client.on('book', (book) => { /* order book snapshot */ });
client.on('price', (update) => { /* price change */ });
client.on('trade', (trade) => { /* trade executed */ });
client.on('marketResolved', (market, assetId, winner) => { /* settlement */ });

await client.connect();
client.subscribe([tokenId1, tokenId2]);  // Subscribe by token/asset IDs
```

REST methods: `fetchMarkets()`, `fetchMarketBySlug()`, `searchMarkets()`

### Signal Detector

The `SignalDetector` in `src/signals/` processes market data and emits signals:

```typescript
import { SignalDetector } from './signals/index.js';

const detector = new SignalDetector();
detector.attach(polymarketClient);

detector.on('signal', (signal) => {
  // signal.type: 'price_spike' | 'volume_spike' | 'spread_compression' | 'aggressive_sweep' | 'depth_pull'
  // signal.strength: 'low' | 'medium' | 'high' | 'very_high'
  console.log(signal.description);
});
```

Signal types detected:
- **price_spike** — Rapid price movement (configurable threshold, default 3% in 5 min)
- **volume_spike** — Trading volume exceeds baseline multiplier (default 3x)
- **spread_compression** — Bid-ask spread narrows significantly (informed buyer signal)
- **aggressive_sweep** — Multiple directional trades with price impact
- **depth_pull** — Liquidity withdrawal from order book

Built-in 30s warmup period and 60s cooldown between duplicate signals.

### Congress.gov Client

The `CongressClient` in `src/ingestion/congress/` monitors legislative activity:

```typescript
import { CongressClient } from './ingestion/congress/index.js';

const congress = new CongressClient({
  apiKey: process.env.CONGRESS_API_KEY!,
  pollIntervalMs: 5 * 60 * 1000, // 5 minutes
});

congress.on('billChange', (change) => {
  // change.bill: BillSummary
  // change.action: BillAction (latest action)
  // change.significance: 'low' | 'medium' | 'high' | 'critical'
  // change.isNew: boolean
});

congress.start();
```

Auto-tracks bills matching appropriations keywords. Significance levels:
- **critical** — BecameLaw, President action, Veto
- **high** — Floor action, ResolvingDifferences
- **medium** — Committee, Calendars

Requires `CONGRESS_API_KEY` from https://api.congress.gov (free, 5000 req/hr).

### Weather Client (NWS)

The `WeatherClient` in `src/ingestion/weather/` monitors NWS alerts:

```typescript
import { WeatherClient } from './ingestion/weather/index.js';

const weather = new WeatherClient({
  pollIntervalMs: 5 * 60 * 1000,
  states: ['FL', 'TX', 'LA'],  // or use HURRICANE_STATES
  includeMinor: false,
});

weather.on('alert', (event) => {
  // event.event: 'Hurricane Warning', 'Tropical Storm Watch', etc.
  // event.severity: 'Extreme' | 'Severe' | 'Moderate' | 'Minor'
  // event.states: ['FL', 'TX']
  // event.headline, event.description, event.instruction
});

weather.start();
```

High-impact events auto-detected: Hurricane/Tropical Storm warnings, Storm Surge, Tornado, Severe Thunderstorm, Flash Flood, Winter Storm, etc.

### Fed Client

The `FedClient` in `src/ingestion/fed/` monitors Federal Reserve releases via RSS:

```typescript
import { FedClient } from './ingestion/fed/index.js';

const fed = new FedClient({
  pollIntervalMs: 5 * 60 * 1000,
  fredApiKey: process.env.FRED_API_KEY,  // optional
});

fed.on('event', (event) => {
  // event.type: 'fomc_statement' | 'fomc_minutes' | 'rate_decision' | 'economic_projections' | 'beige_book' | 'testimony' | 'speech'
  // event.significance: 'critical' | 'high' | 'medium' | 'low'
  // event.sentiment: 'hawkish' | 'dovish' | 'neutral'
  // event.rateDecision: 'hike' | 'cut' | 'hold' | undefined
  // event.rateChange: number (basis points, e.g., 25, -25)
});

fed.start();
```

Event types and significance:
- **critical** — FOMC statements, rate decisions
- **high** — FOMC minutes, economic projections
- **medium** — Beige Book, testimony
- **low** — Speeches

Auto-detects rate decisions (hike/cut/hold) and sentiment (hawkish/dovish/neutral) from announcement text.

`isFOMCDay()` helper returns true on known FOMC meeting days (2025-2026 dates).

Optional: Set `FRED_API_KEY` from https://fred.stlouisfed.org for additional economic data.

### Sports Client

The `SportsClient` in `src/ingestion/sports/` monitors injury reports via ESPN API:

```typescript
import { SportsClient } from './ingestion/sports/index.js';

const sports = new SportsClient({
  leagues: ['NFL', 'NBA', 'MLB'],
  pollIntervalMs: 10 * 60 * 1000,  // 10 minutes
});

sports.on('event', (event) => {
  // event.type: 'injury_update' | 'lineup_confirmed' | 'game_status' | 'trade'
  // event.league: 'NFL' | 'NBA' | 'MLB' | 'NHL' | 'EPL' | 'MLS'
  // event.significance: 'critical' | 'high' | 'medium' | 'low'
  // event.injury: InjuryReport (player, status, team, etc.)
});

sports.start();
```

Injury status types: `out`, `doubtful`, `questionable`, `probable`, `available`, `day-to-day`, `ir`, `pup`, `suspended`.

Significance scoring:
- **critical** — Star player ruled out
- **high** — Star player status change, any player ruled out close to game
- **medium** — Status upgrade (questionable → available), star player any update
- **low** — Routine updates

Star players are defined in `STAR_PLAYERS` constant (top 15-20 per league).

`isInjuryReportWindow(league)` returns true during critical reporting periods:
- NFL: Wednesday-Saturday (official injury report days)
- NBA: 4-7 PM ET (pre-game window)
- MLB: 3-8 PM ET (lineup posting window)

### Truth-Market Linker

The `TruthMarketLinker` in `src/signals/truth-change/` connects truth source events to Polymarket markets:

```typescript
import { TruthMarketLinker } from './signals/index.js';

const linker = new TruthMarketLinker();
linker.attach({
  polymarket: polymarketClient,
  congress: congressClient,  // optional
  weather: weatherClient,    // optional
  fed: fedClient,            // optional
});

linker.on('alert', (alert) => {
  // alert.sourceType: 'congress' | 'weather' | 'fed' | 'sports'
  // alert.sourceEvent: the triggering event
  // alert.affectedMarkets: markets impacted by this event
  // alert.confidence: 'low' | 'medium' | 'high' | 'very_high'
  // alert.urgency: 'low' | 'medium' | 'high' | 'critical'
  // alert.implications: predicted market impacts
});
```

Auto-categorizes markets by keywords:
- **government_shutdown** — shutdown, appropriations, CR, omnibus
- **fed_rate** — federal reserve, fomc, rate cut/hike, interest rate, powell
- **hurricane** — hurricane, tropical storm, landfall
- **legislation** — congress pass, signed into law
- **sports_player** — points, rebounds, yards, touchdowns, o/u, prop
- **sports_outcome** — win, beat, championship, super bowl, finals

### Alert Engine

The `AlertEngine` in `src/alerts/` dispatches alerts to multiple channels:

```typescript
import { AlertEngine } from './alerts/index.js';

const engine = new AlertEngine({
  channels: [
    { type: 'console', minPriority: 'low' },
    { type: 'webhook', url: 'https://...', minPriority: 'high' },
    { type: 'file', path: './alerts.jsonl', format: 'json' },
  ],
  dedupeWindowMs: 60000,  // 1 minute deduplication
  rateLimitPerMinute: 60,
});

// Send different alert types
engine.sendSignal(signal);
engine.sendCongressChange(billChange);
engine.sendLinkedAlert(linkedAlert);
engine.sendCustom('Title', 'Body', 'high');
```

Environment variables:
- `ALERT_WEBHOOK_URL` — Webhook endpoint for high-priority alerts
- `ALERT_LOG_PATH` — File path for JSON alert logging

### Playbooks

Market-specific logic modules in `src/playbooks/` provide specialized analysis:

```typescript
import { findPlaybook, getAllPlaybooks } from './playbooks/index.js';

// Find playbook for a market
const playbook = findPlaybook(market.question, market.description);
if (playbook) {
  const status = await playbook.analyze(market.id, market.question, currentPrice);
  // status.phase: 'monitoring' | 'approaching' | 'imminent' | 'active' | 'resolution' | 'settled'
  // status.urgency: 'low' | 'medium' | 'high' | 'critical'
  // status.countdown: { daysRemaining, hoursRemaining }
  // status.signals: analysis signals
  // status.recommendation: { action, confidence, reasoning, caveats }
}
```

Available playbooks:
- **ShutdownPlaybook** — CR expirations, appropriations deadlines, funding gaps
- **HurricanePlaybook** — Storm tracking, NHC advisories, landfall forecasts
- **FedDecisionPlaybook** — FOMC meetings, rate decisions, blackout periods
- **SportsPlaybook** — Injury reports, lineup confirmations, game timing

Each playbook provides:
- `matches(question, description)` — Check if playbook applies
- `analyze(marketId, question, price)` — Get current status and signals
- `getKeyDates()` — Upcoming critical events

### REST API

The `APIServer` in `src/api/` provides a REST API on port 3000 (configurable via `API_PORT`):

```bash
# Start the system (includes API server)
npm run dev

# API endpoints
curl http://localhost:3000/           # Dashboard (HTML)
curl http://localhost:3000/api        # API info
curl http://localhost:3000/api/health # Health check
curl http://localhost:3000/api/status # System status & metrics
curl http://localhost:3000/api/markets # Tracked markets
curl http://localhost:3000/api/alerts?limit=20 # Recent alerts
curl http://localhost:3000/api/analysis # All market analysis
curl http://localhost:3000/api/analysis?market=ID # Specific market
curl http://localhost:3000/api/dates  # Key upcoming dates
curl http://localhost:3000/api/playbooks # Available playbooks
```

Dashboard available at `http://localhost:3000/` — auto-refreshes every 30 seconds.

### Truth Map Pattern

Each monitored market requires a "Truth Map" that defines:
- Settlement authority (who/what determines outcome)
- Primary sources to monitor
- Leading indicators
- Binary triggers
- Noise sources to ignore

See API-SOURCES.md for detailed truth maps per market category.

### Polling Strategy

Match polling intervals to source update cadence:
- Congress.gov: 5-min during session, 1-hr overnight
- NHC: 15-min (matches advisory schedule)
- Fed releases: Event-driven (2:00 PM ET on meeting days)
- Polymarket: WebSocket (real-time)
- Sports injury: At deadline times (NFL W/Th/F 4PM; NBA 5PM)

### Confidence Scoring

| Level | Trigger | Action |
|-------|---------|--------|
| VERY HIGH | Tier 1 source changed + matches settlement criteria | Immediate alert |
| HIGH | Multiple Tier 1 signals + market confirming | Alert with context |
| MEDIUM | Tier 2 flow + partial Tier 1 | Alert as "watching" |
| LOW | Tier 2 or Tier 3 only | Log, no alert |

## Key Documentation

- **PLAN.md** — Full system design and philosophy
- **API-SOURCES.md** — All APIs organized by market category with truth maps

## Priority Markets

1. Government shutdowns / legislation
2. Weather (hurricanes, disasters)
3. Sports injuries / lineup confirmation
4. Fed decisions / rate paths
5. Geopolitical escalations
