# Polymarket Trading Intelligence System

Bloomberg Terminal for truth discovery + probability arbitrage.

## What This Does

Detects **truth-changing events** before Polymarket prices fully adjust:

1. Watches actual settlement sources 24/7 (not Twitter, not news)
2. Detects meaningful change, not noise
3. Connects event → probability mispricing in real time

## Quick Start

```bash
cd ~/projects/polymarket-trading-intel
npm install
npm run dev
```

## Project Structure

```
polymarket-trading-intel/
├── src/
│   ├── ingestion/        # Data source connectors
│   │   ├── polymarket/   # WebSocket + REST client
│   │   ├── congress/     # Congress.gov bill tracker
│   │   ├── weather/      # NWS/NHC alerts
│   │   ├── fed/          # FOMC monitoring
│   │   └── geopolitical/ # GDELT, DoD, State Dept
│   ├── signals/          # Signal detection engine
│   │   ├── truth-change/ # Tier 1 event detection
│   │   ├── market-flow/  # Tier 2 microstructure
│   │   └── confidence/   # Scoring system
│   ├── alerts/           # Alert formatting + delivery
│   ├── playbooks/        # Market-specific logic
│   │   ├── shutdown.ts
│   │   ├── hurricane.ts
│   │   ├── fed-decision.ts
│   │   └── sports.ts
│   └── api/              # REST API for dashboard
├── dashboard/            # Web UI (optional)
├── PLAN.md              # Full system design
├── API-SOURCES.md       # All data sources documented
└── README.md
```

## Documentation

- [PLAN.md](./PLAN.md) - Full system architecture and philosophy
- [API-SOURCES.md](./API-SOURCES.md) - All APIs organized by market category

## Priority Markets

1. Government shutdowns / legislation
2. Weather (hurricanes, disasters)
3. Sports injuries / lineup confirmation
4. Fed decisions / rate paths
5. Geopolitical escalations

## The Edge

> Monitor the sources that literally define reality for each market — before journalists and aggregators react.

- **Tier 1:** Truth sources (settlement authorities)
- **Tier 2:** Market signals (informed flow detection)
- **Tier 3:** Context (confirmation only, never alert alone)
