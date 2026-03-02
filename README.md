# 🌍 World Monitor → Facebook Auto-Post Bot

Real-time news bot that monitors [World Monitor](https://worldmonitor.app) and instantly posts breaking news to your Facebook Page.

## How It Works

```
World Monitor API ──(poll every 60s)──▶ Bot ──(instant)──▶ Facebook Page
                                        │
                              ┌─────────┴──────────┐
                              │                    │
                        🚨 BREAKING            📰 Regular
                        Post instantly         Batch every 15min
```

- **Breaking News** → Detected by keyword matching → Posted **instantly**
- **Regular News** → Batched and posted every **15 minutes** (max 3 per batch)
- **Deduplication** → Never posts the same headline twice
- **AI Summaries** → Fetches AI-generated summaries from World Monitor

## Deploy on Render

1. Push this repo to GitHub
2. Go to [render.com](https://render.com) → **New** → **Web Service**
3. Connect your GitHub repo
4. Settings:
   - **Build Command**: `echo "No build needed"`
   - **Start Command**: `node bot.mjs`
   - **Instance Type**: Free
5. Add Environment Variables:

| Variable | Required | Value |
|---|---|---|
| `FB_PAGE_ACCESS_TOKEN` | ✅ | Your Facebook Page access token |
| `FB_PAGE_ID` | ✅ | Your Facebook Page ID |
| `WORLDMONITOR_API_URL` | ✅ | `https://worldmonitor-oshada.vercel.app` |
| `POLL_INTERVAL_MS` | ❌ | `60000` (default: 1 min) |
| `MAX_POSTS_PER_BATCH` | ❌ | `3` (default) |

## Health Check

Visit `https://your-service.onrender.com/health` to see bot status:

```json
{
  "status": "ok",
  "totalPolls": 142,
  "totalPosted": 37,
  "breakingPosted": 5,
  "regularPosted": 32,
  "lastPoll": "2026-03-02T11:15:00.000Z",
  "lastPost": "2026-03-02T11:10:00.000Z"
}
```

## Facebook Setup

See the setup guide for getting your Page Access Token.
