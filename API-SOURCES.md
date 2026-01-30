# API Sources by Market Category

## Polymarket API (Primary Data Source)

**Docs:** https://docs.polymarket.com/

| Endpoint Type | Data Available |
|--------------|----------------|
| Markets API | Market IDs, slugs, prices, volumes, metadata |
| Events API | Event details, related markets |
| Pricing API | Real-time prices, midpoints, historical prices |
| Order Book | Bid/ask spreads, depth |
| WebSocket | Real-time market updates, sports results |
| Positions | Top holders, user positions |

Free access, no API key required for read-only market data.

---

## Tier 1: Truth Sources

### 1. Government Shutdown / Legislation

**Settlement Authority:** U.S. Congress + President

| Source | API/Endpoint | What to Monitor | Update Cadence |
|--------|--------------|-----------------|----------------|
| **Congress.gov API** | `/bill/{congress}/{type}/{number}/actions` | Bill status changes, enrolled status | Event-driven |
| **Congress.gov Appropriations Table** | Scrape required | CR expiration, enacted appropriations | Daily + event |
| **House Clerk** | XML feeds | Floor schedule, votes called | Real-time |
| **Senate.gov** | RSS/Scrape | Floor schedule, cloture filings | Real-time |
| **GovInfo API** | `/collections/BILLS` | Actual bill text changes | Event-driven |
| **WhiteHouse.gov** | Scrape/RSS | Signing statements, veto threats | Event-driven |

**Links:**
- https://api.congress.gov/
- https://www.congress.gov/crs-appropriations-status-table
- https://clerk.house.gov/legislative-activity
- https://www.senate.gov/legislative/schedules.htm
- https://api.govinfo.gov/

**Truth Map:**
```json
{
  "market_id": "government-shutdown-jan-2026",
  "settlement_authority": "Lapse of appropriations as defined by Antideficiency Act",
  "primary_sources": [
    "Congress.gov bill actions API",
    "House/Senate floor schedules",
    "GovInfo enrolled bill text"
  ],
  "leading_indicators": [
    "CR bill introduced → committee → floor → enrolled",
    "Cloture motion filed (Senate)",
    "Rule adopted (House)",
    "Veto threat issued/withdrawn"
  ],
  "binary_triggers": [
    "Bill signed = NO shutdown",
    "Midnight passes + no enacted CR = YES shutdown"
  ],
  "noise_to_ignore": [
    "Pundits predicting shutdown",
    "Anonymous staff quotes",
    "'Talks ongoing' headlines"
  ]
}
```

---

### 2. Federal Reserve / Rate Decisions

**Settlement Authority:** FOMC

| Source | API/Endpoint | What to Monitor | Update Cadence |
|--------|--------------|-----------------|----------------|
| **Federal Reserve Press Releases** | RSS/Scrape | FOMC statements (2:00 PM ET release) | Event-driven |
| **FOMC Calendar** | Scrape | Meeting dates, emergency meetings | Monthly |
| **Fed Governor Speeches** | RSS | Pre-meeting signals | Event-driven |
| **CME FedWatch** | Scrape/unofficial | Futures-implied probabilities | Real-time |
| **FRED API** | `/series/observations` | Fed funds rate (DFF), economic data | Daily |

**Links:**
- https://www.federalreserve.gov/newsevents/pressreleases.htm
- https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm
- https://www.cmegroup.com/markets/interest-rates/cme-fedwatch-tool.html
- https://fred.stlouisfed.org/docs/api/fred/

**Truth Map:**
```json
{
  "market_id": "fed-rate-cut-march-2026",
  "settlement_authority": "FOMC statement published at 2:00 PM ET on meeting day",
  "primary_sources": [
    "federalreserve.gov/newsevents/pressreleases",
    "Official FOMC statement text"
  ],
  "leading_indicators": [
    "Fed governor speeches (hawkish/dovish shift)",
    "CME FedWatch probability movement",
    "Beige Book tone",
    "Emergency meeting announcement"
  ],
  "binary_triggers": [
    "Statement text: 'target range... X to Y percent'"
  ],
  "noise_to_ignore": [
    "WSJ Fed whisperer articles",
    "'Sources say' reporting",
    "Market expectations ≠ Fed action"
  ]
}
```

---

### 3. Weather / Hurricane Markets

**Settlement Authority:** NWS / NHC official designations

| Source | API/Endpoint | What to Monitor | Update Cadence |
|--------|--------------|-----------------|----------------|
| **NWS Alerts API** | `/alerts/active?area={state}` | Official warnings, watches | Real-time |
| **NHC Atlantic** | GIS shapefiles, RSS | Hurricane advisories, cone updates | 6-hourly + special |
| **NHC API (unofficial)** | Product feeds | Advisory text, intensity changes | Event-driven |
| **NOAA Storm Prediction Center** | RSS/Scrape | Tornado/severe storm outlooks | 4x daily |
| **USGS Earthquake API** | `/query` | Magnitude, location, tsunami alerts | Real-time |

**Links:**
- https://api.weather.gov/alerts/active
- https://www.nhc.noaa.gov/gis/
- https://www.spc.noaa.gov/
- https://earthquake.usgs.gov/fdsnws/event/1/

**Truth Map:**
```json
{
  "market_id": "hurricane-landfall-florida-2026",
  "settlement_authority": "NHC official advisory (not models, not Euro)",
  "primary_sources": [
    "NHC public advisory",
    "NHC forecast cone",
    "NWS local office warnings"
  ],
  "leading_indicators": [
    "Reconnaissance aircraft data (before advisory update)",
    "Cone shift toward/away from target",
    "Intensity forecast change",
    "Watch → Warning upgrade"
  ],
  "binary_triggers": [
    "NHC declares landfall at location X",
    "NHC post-storm report"
  ],
  "noise_to_ignore": [
    "Euro model runs (until NHC incorporates)",
    "Weather Twitter speculation",
    "Local news hype"
  ]
}
```

---

### 4. Sports Markets

**Settlement Authority:** League official injury reports + final scores

| Source | API/Endpoint | What to Monitor | Update Cadence |
|--------|--------------|-----------------|----------------|
| **NFL Official Injury Report** | Scrape | Wed/Thu/Fri injury designations | 3x weekly |
| **NBA Official Injury Report** | JSON feed | Game-day status (5:00 PM ET deadline) | Daily |
| **ESPN API (unofficial)** | `/sports/{sport}/{league}/scoreboard` | Live scores, game status | Real-time |
| **Team Twitter/X** | Stream | Lineup announcements (often first) | Event-driven |

**Links:**
- https://www.nfl.com/injuries/
- https://official.nba.com/nba-injury-report/
- http://site.api.espn.com/apis/site/v2/sports/

**Truth Map:**
```json
{
  "market_id": "chiefs-win-afc-championship",
  "settlement_authority": "NFL official game result",
  "primary_sources": [
    "NFL.com final score",
    "Official box score"
  ],
  "leading_indicators": [
    "Official injury report (OUT vs Questionable)",
    "Team beat reporter confirmations",
    "Sharp book line movement (Pinnacle, Circa)",
    "Weather at game site"
  ],
  "high_value_signals": [
    "Star player ruled OUT (after questionable)",
    "Line moves 1+ point without news = sharp action"
  ],
  "noise_to_ignore": [
    "'Sources say' injury speculation",
    "Fantasy football Twitter",
    "Public betting percentages"
  ]
}
```

---

### 5. Geopolitical / Military Action

**Settlement Authority:** Official government statements + verifiable events

| Source | API/Endpoint | What to Monitor | Update Cadence |
|--------|--------------|-----------------|----------------|
| **DoD Press Releases** | RSS | Military action confirmations | Event-driven |
| **State Dept Briefings** | RSS | Diplomatic status, sanctions | Event-driven |
| **White House Statements** | RSS | Presidential actions | Event-driven |
| **UN Security Council** | Scrape | Resolutions, emergency sessions | Event-driven |
| **GDELT** | Event API | First detection of incidents | 15-min |
| **Flightradar24** | Scrape/API | Military aircraft activity | Real-time |
| **MarineTraffic** | API | Naval movements | Real-time |

**Links:**
- https://www.defense.gov/News/
- https://www.state.gov/briefings/
- https://www.whitehouse.gov/briefing-room/statements-releases/
- https://api.gdeltproject.org/api/v2/doc/doc
- https://www.flightradar24.com/
- https://www.marinetraffic.com/

**Truth Map:**
```json
{
  "market_id": "us-strikes-iran-2026",
  "settlement_authority": "DoD/White House official confirmation of strike",
  "primary_sources": [
    "Pentagon press release",
    "Presidential statement",
    "CENTCOM announcement"
  ],
  "leading_indicators": [
    "Flightradar: military tankers airborne over Gulf",
    "MarineTraffic: carrier strike group positioning",
    "NOTAM/airspace closures",
    "State Dept travel advisory upgrade"
  ],
  "noise_to_ignore": [
    "Iranian state media claims",
    "Unverified Telegram channels",
    "'Imminent strike' reporting"
  ]
}
```

---

## Tier 2: Market Signal APIs

| Source | What It Tells You | API |
|--------|-------------------|-----|
| **Polymarket WebSocket** | Price moves, volume spikes, depth | https://docs.polymarket.com/ |
| **Polymarket Order Book** | Aggressive sweeps, bid/ask imbalance | https://docs.polymarket.com/ |
| **Kalshi API** | Cross-platform probability divergence | https://trading-api.readme.io/reference/ |
| **Pinnacle** (via Unabated) | Sharpest sports book, first mover | $3K/mo - https://unabated.com/ |
| **Betfair Exchange API** | UK sharp money, liquidity depth | https://developer.betfair.com/ |

**Market Microstructure Signals:**
- Spread compression + volume spike → informed buyer
- Repeated aggressive buys at resistance → accumulation
- Depth pulled before move → market maker knows something
- Price drift during Asia hours → non-US informed flow
- Polymarket-Kalshi divergence > 5% → arb or info asymmetry

---

## Tier 3: Context APIs (Confirmation Only)

**Never fire alerts on Tier 3 alone.**

| Source | Use Case | Link |
|--------|----------|------|
| **GDELT DOC API** | Tone shift detection, early coverage | https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/ |
| **NewsAPI** | Confirmation that Tier 1 event hit mainstream | https://newsapi.org/ |
| **Reddit API** | r/politics, r/wallstreetbets sentiment | https://www.reddit.com/dev/api/ |
| **Twitter/X** | Detection (not validation) | Firehose access required |

---

## Polling Strategy

| Source Type | Strategy | Frequency |
|-------------|----------|-----------|
| Congress.gov | Poll + webhook simulation | 5-min during session, 1-hr overnight |
| NHC Advisories | Poll | 15-min (matches advisory schedule) |
| Fed releases | Cron job at 2:00 PM ET | Event-driven |
| Polymarket WS | Persistent connection | Real-time |
| Sports injury | Poll at deadline times | NFL: W/Th/F 4PM ET; NBA: 5PM ET |
| GDELT | Poll | 15-min |
| Flight/Ship tracking | Poll or stream | 5-min |

---

## Alert Confidence Matrix

| Confidence | Trigger Combination | Action |
|------------|---------------------|--------|
| **VERY HIGH** | Tier 1 source changed + matches settlement criteria | Immediate alert |
| **HIGH** | Multiple Tier 1 signals + market confirming | Alert with context |
| **MEDIUM** | Tier 2 market flow + partial Tier 1 | Alert as "watching" |
| **LOW** | Tier 2 only or Tier 3 only | Log, no alert |
