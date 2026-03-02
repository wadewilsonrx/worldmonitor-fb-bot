# 🌍 World Monitor → Facebook Auto-Post Bot  v2.0

Real-time, always-on service that monitors [World Monitor](https://worldmonitor-oshada.vercel.app)  
and **instantly posts breaking news** to your Facebook Page.

---

## Architecture

```
World Monitor API ──(poll every 60s)──────────▶ Bot ──▶ Facebook Page
        │                                        │
        │ (if API down)                    ┌─────┴──────────────┐
        ▼                                  │                    │
  RSS Fallback Feeds             🚨 BREAKING NEWS         📰 Regular News
  BBC · CNN · Reuters            Score ≥ 2 → Post INSTANTLY  Batch every 15 min
  NYT · Al Jazeera                                         (max 3 per batch)
```

---

## What's New in v2

| Feature | Details |
|---|---|
| **Keyword Scoring** | Tiered scoring (1–3 pts per keyword) replaces simple keyword matching. Score ≥ 2 = breaking. |
| **URL-based Dedup** | Articles are ID'd by URL hash, not title text — eliminates false duplicates across sources. |
| **RSS Fallback** | When World Monitor API is down, the bot automatically falls back to BBC, CNN, Reuters, NYT, Al Jazeera. |
| **Exponential Back-off** | All API calls retry up to 3× with 1s → 2s → 4s delays before giving up. |
| **FB Rate Limit Guard** | Tracks Facebook Graph API calls per rolling hour; stops at 180/200 to stay within limits. |
| **Auto-recovery** | `uncaughtException` and `unhandledRejection` are caught and logged — the process never crashes. |
| **Keep-Alive Ping** | Self-pings every 14 min to prevent Render free tier from sleeping. |
| **Live Dashboard** | Visit `/` for a rich, auto-refreshing (30s) HTML dashboard with charts and live log tail. |
| **Dry Run Mode** | Set `DRY_RUN=true` to preview posts without actually posting. |
| **`render.yaml`** | One-click Render Blueprint deploy. |

---

## Deploy on Render

### Option A — One-click Blueprint (recommended)

1. Push this folder to a GitHub repo
2. Go to [dashboard.render.com](https://dashboard.render.com) → **New** → **Blueprint**
3. Connect your repo — Render reads `render.yaml` automatically
4. Set the two secret env vars manually (see below)
5. Click **Apply**

### Option B — Manual Web Service

1. **New** → **Web Service** → connect your repo
2. Settings:
   - **Build Command**: `echo "No build needed"`
   - **Start Command**: `node bot.mjs`
   - **Instance Type**: Free (or Starter for 24/7 uptime without sleep)
   - **Health Check Path**: `/health`

### Required Environment Variables

Set these in **Render Dashboard → Environment**:

| Variable | Required | Description |
|---|---|---|
| `FB_PAGE_ACCESS_TOKEN` | ✅ | Facebook Page access token (permanent token) |
| `FB_PAGE_ID` | ✅ | Facebook Page ID (numeric) |
| `WORLDMONITOR_API_URL` | ✅ | `https://worldmonitor-oshada.vercel.app` |

### Optional Environment Variables

| Variable | Default | Description |
|---|---|---|
| `POLL_INTERVAL_MS` | `60000` | Polling interval (ms) |
| `MAX_POSTS_PER_BATCH` | `3` | Regular posts per batch |
| `MAX_FB_CALLS_PER_HOUR` | `180` | Facebook rate-limit guard |
| `KEEP_ALIVE_URL` | _(empty)_ | Set to `https://your-service.onrender.com/health` after first deploy |
| `KEEP_ALIVE_INTERVAL` | `840000` | Keep-alive ping interval (14 min) |
| `DRY_RUN` | `false` | `true` = log only, don't post |

---

## Getting a Facebook Page Access Token

1. Go to [developers.facebook.com](https://developers.facebook.com) → your app
2. Open **Graph API Explorer**
3. Select your app → click **Get Page Access Token**
4. Select your page from the dropdown
5. Click **Generate Access Token**

> ⚠️ **Important**: The default token expires in 60 days.  
> To get a **permanent (never-expiring) token**, use the token exchange:  
> ```
> GET https://graph.facebook.com/oauth/access_token
>   ?grant_type=fb_exchange_token
>   &client_id=APP_ID
>   &client_secret=APP_SECRET
>   &fb_exchange_token=SHORT_LIVED_TOKEN
> ```
> Then use *that* long-lived User Token to get a Page Token (which never expires as long as you remain admin).

---

## Health Dashboard

Visit your Render URL — three endpoints available:

| Endpoint | Description |
|---|---|
| `/` or `/dashboard` | **Live HTML dashboard** — auto-refreshes every 30s |
| `/health` or `/status` | JSON status for monitoring tools / uptime checkers |

### Example JSON response from `/status`

```json
{
  "status": "ok",
  "version": "2.0.0",
  "dryRun": false,
  "uptime": "4h 23m 11s",
  "memory": "28MB",
  "totalPolls": 267,
  "totalPosted": 51,
  "breakingPosted": 8,
  "regularPosted": 43,
  "errors": 2,
  "fbCallsThisHour": 3,
  "fbCallsLimit": 180,
  "lastPoll": "2026-03-02T11:15:00.000Z",
  "lastPost": "2026-03-02T11:10:00.000Z"
}
```

---

## Breaking News Score System

| Keyword | Score |
|---|---|
| `breaking`, `urgent`, `just in`, `flash`, `alert`, `war declared` | 3 pts |
| `explosion`, `earthquake`, `tsunami`, `attack`, `assassination`, `coup`, `missile`, `invasion`, `mass shooting`, `hostage`, `collapse`, `emergency`, `nuclear`, `crashed`, `shot down`, `ceasefire` | 2 pts |
| `developing`, `killed`, `wounded`, `evacuated`, `fire`, `flood`, `blackout`, `strike`, `storm`, `hurricane`, `sanctions`, `arrested`, `protests` | 1 pt |
| Article age < 8 minutes | +1 pt |

> **Threshold**: Score ≥ 2 → classified as Breaking → posted immediately

---

## Local Development

```bash
# Install (nothing to install — pure Node.js built-ins + fetch)
# Node 18+ required

# Copy env template
cp .env.example .env
# Edit .env with your values

# Test without posting
DRY_RUN=true node bot.mjs

# Run live
node bot.mjs
```

---

## Project Files

```
worldmonitor-fb-bot/
├── bot.mjs          ← Main bot (single file, no dependencies)
├── package.json     ← Node config
├── render.yaml      ← Render Blueprint (one-click deploy)
├── .env.example     ← Environment variable template
├── .gitignore       ← Excludes .env and posted.json
├── posted.json      ← Runtime: tracks posted articles (auto-created)
└── README.md        ← This file
```
