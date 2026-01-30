# Polymarket Trading Intelligence System

**Goal:** Detect *truth-changing events* before Polymarket prices fully adjust — and alert traders with confidence, context, and speed.

This system does **three things better than humans**:

1. Watches the *actual settlement sources* 24/7
2. Detects *meaningful change*, not noise
3. Connects *event → probability mispricing* in real time

---

## Core Philosophy (This Is the Edge)

Polymarket markets move when **reality changes**, not when opinions change.

So the edge is:

> **Monitor the sources that literally define reality for each market — before journalists and aggregators react.**

Twitter is late.
News APIs are late.
Blogs are very late.

**Primary sources move first.**

---

## Data Source Tiers

### Tier 1 — Truth Sources (Highest Signal)
These are the **only** sources that can definitively change market outcomes.

### Tier 2 — Market Signals
Detect **informed flow** — often before explanation exists.

### Tier 3 — Context (Used Carefully)
Never fire alerts on Tier 3 alone.

---

## Market → Truth Mapping

Every Polymarket market must have a **Truth Map**.

### Truth Map Schema (per market)

```json
{
  "market_id": "government-shutdown-2026",
  "settlement_authority": "U.S. Congress / President",
  "primary_sources": [
    "Congress.gov",
    "House Appropriations Committee",
    "Senate Appropriations Committee",
    "OMB official statements"
  ],
  "leading_indicators": [
    "CR expiration date",
    "bill text updates",
    "committee markup schedules",
    "cloture votes",
    "whip counts"
  ],
  "update_frequency": "event-driven",
  "noise_sources": [
    "media speculation",
    "anonymous sources",
    "talking heads"
  ]
}
```

---

## Priority Markets (Ranked by Edge vs Complexity)

1. **Government shutdowns / legislation**
2. **Weather (hurricanes, disasters)**
3. **Sports injuries / lineup confirmation**
4. **Fed decisions / rate paths**
5. **Geopolitical escalations**

Avoid celebrity / meme markets early — noisy, low edge.

---

## Alert System

Alerts must answer **three questions immediately**:

### Alert Format

```
🚨 GOVERNMENT SHUTDOWN MARKET

Market moved: +6.8% (YES)
Time: 14:32 ET

Trigger:
• Congress.gov updated bill status
• House Appropriations markup canceled
• No replacement CR introduced

Confidence: HIGH (Tier 1 source)

Why it matters:
• CR expires in 48 hours
• No floor action scheduled
• Similar pattern preceded 2018 shutdown

Related markets:
• Fed delay odds +2.1%
• Treasury volatility market uptick

Actionable takeaway:
Market likely underpricing shutdown risk
```

---

## Confidence Scoring

| Level     | Meaning                            |
| --------- | ---------------------------------- |
| Very High | Official source changed            |
| High      | Multiple primary signals           |
| Medium    | Market flow + partial confirmation |
| Low       | Market flow only                   |

---

## "Explain This Move" Feature

Every market gets this capability:

Returns:
- What changed (truth + market)
- Which sources updated
- Whether move is **news-driven** or **flow-driven**
- Confidence score
- Historical analogs

---

## Build Phases

### Phase 1 (MVP)
- Polymarket WebSocket ingestion
- Congress.gov monitoring
- Alert engine v1
- Dashboard + push alerts

### Phase 2
- Order book intelligence
- Cross-market arb detection
- Explain-this-move engine

### Phase 3
- Automated market playbooks
- User-specific alert thresholds
- Historical pattern learning
