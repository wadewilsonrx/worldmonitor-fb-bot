/**
 * World Monitor → Facebook Auto-Post Bot  (Real-Time, Production-Grade)
 *
 * Always-on Render service that:
 *   • Polls World Monitor every 60 s (configurable)
 *   • Detects breaking news with a keyword SCORE system — instant post
 *   • Batches regular news every 15 min (max 3 per batch, configurable)
 *   • Falls back to direct RSS feeds when the World Monitor API is down
 *   • Deduplicates by URL hash + title hash to eliminate false duplicates
 *   • Respects Facebook Graph API rate limits (200 calls/hour guard)
 *   • Retries with exponential back-off on transient failures
 *   • Self-heals: uncaught exceptions are caught and logged, not fatal
 *   • Serves a rich /health dashboard and a /status JSON endpoint
 *   • Pings itself to prevent Render free-tier sleep (configurable)
 *
 * Required env vars (set in Render Dashboard):
 *   FB_PAGE_ACCESS_TOKEN  — Facebook Page access token (never-expiring)
 *   FB_PAGE_ID            — Facebook Page ID (numeric string)
 *   WORLDMONITOR_API_URL  — Your World Monitor deployment URL
 *
 * Optional env vars:
 *   MAX_POSTS_PER_BATCH   default: 3
 *   POLL_INTERVAL_MS      default: 60000  (1 min)
 *   PORT                  default: 3000
 *   KEEP_ALIVE_URL        self-ping URL to prevent Render sleep (optional)
 *   KEEP_ALIVE_INTERVAL   default: 840000 (14 min)
 *   MAX_FB_CALLS_PER_HOUR default: 180   (Safety margin under FB's 200 limit)
 *   DRY_RUN               Set to "true" to skip posting — logs only
 */

import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import sharp from 'sharp';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createHash } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Config ──────────────────────────────────────────────────────────────────
const FB_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN || '';
const FB_PAGE_ID = process.env.FB_PAGE_ID || '';
const WM_API_URL = (process.env.WORLDMONITOR_API_URL || 'https://worldmonitor-oshada.vercel.app').replace(/\/$/, '');
const WM_API_KEY = process.env.WM_API_KEY || '';              // X-WorldMonitor-Key header — required for server-side access
const MAX_PER_BATCH = parseInt(process.env.MAX_POSTS_PER_BATCH || '3', 10);
const POLL_MS = parseInt(process.env.POLL_INTERVAL_MS || '60000', 10);
const PORT = parseInt(process.env.PORT || '3000', 10);
const KEEP_ALIVE_URL = process.env.KEEP_ALIVE_URL || '';          // e.g. https://your-app.onrender.com/health
const BOT_BASE_URL = KEEP_ALIVE_URL ? new URL(KEEP_ALIVE_URL).origin : '';
const KEEP_ALIVE_MS = parseInt(process.env.KEEP_ALIVE_INTERVAL || '840000', 10); // 14 min
const MAX_FB_PER_HOUR = parseInt(process.env.MAX_FB_CALLS_PER_HOUR || '180', 10);
const MAX_ARTICLE_AGE_H = parseFloat(process.env.MAX_ARTICLE_AGE_HOURS || '0.5'); // 30 min — only post truly fresh news
const DRY_RUN = process.env.DRY_RUN === 'true';
const REGULAR_INTERVAL_MS = 15 * 60 * 1000;  // kept for reference, no longer used for batching
const GRAPH_API = 'https://graph.facebook.com/v19.0';
const POSTED_FILE = join(__dirname, 'posted.json');
const VERSION = '2.2.0';

// ─── Runtime State ───────────────────────────────────────────────────────────
const state = {
    startedAt: new Date().toISOString(),
    totalPolls: 0,
    totalPosted: 0,
    breakingPosted: 0,
    regularPosted: 0,
    lastPoll: null,
    lastPost: null,
    lastRegularAt: Date.now(),
    errors: 0,
    lastError: null,
    fbCallsThisHour: 0,
    fbHourWindow: Date.now(),
    isRunning: true,
    recentLogs: [],   // Circular buffer, last 100 log lines
};

// ─── Logging ─────────────────────────────────────────────────────────────────
function log(msg) {
    const ts = new Date().toISOString();
    const line = `[${ts}] ${msg}`;
    console.log(line);
    state.recentLogs.push(line);
    if (state.recentLogs.length > 100) state.recentLogs.shift();
}

// ─── Breaking News  (keyword scoring) ────────────────────────────────────────
const BREAKING_SCORES = {
    // Tier 3 — Extreme urgency (score 3)
    'breaking': 3, 'urgent': 3, 'just in': 3, 'flash': 3,
    'alert': 3, 'war declared': 3, 'nuclear launch': 3,
    // Tier 2 — High urgency (score 2)
    'explosion': 2, 'earthquake': 2, 'tsunami': 2, 'attack': 2,
    'assassination': 2, 'coup': 2, 'missile': 2, 'invasion': 2,
    'mass shooting': 2, 'hostage': 2, 'collapse': 2, 'emergency': 2,
    'nuclear': 2, 'crashed': 2, 'shot down': 2, 'ceasefire': 2,
    // Tier 1 — Elevated (score 1)
    'developing': 1, 'breaking news': 1, 'killed': 1, 'wounded': 1,
    'evacuated': 1, 'fire': 1, 'flood': 1, 'blackout': 1, 'strike': 1,
    'arrested': 1, 'protests': 1, 'storm': 1, 'hurricane': 1,
    'sanctions': 1, 'resign': 1, 'resign': 1,
};

const BREAKING_THRESHOLD = 2;  // Sum of keyword scores must meet this

function breakingScore(item) {
    const text = `${item.title} ${item.description || ''}`.toLowerCase();
    let score = 0;
    for (const [kw, pts] of Object.entries(BREAKING_SCORES)) {
        if (text.includes(kw)) score += pts;
    }
    // Age boost: articles < 8 min old get +1
    if (item.pubDate) {
        const ageMin = (Date.now() - new Date(item.pubDate).getTime()) / 60000;
        if (ageMin < 8) score += 1;
    }
    return score;
}

function isBreaking(item) {
    return breakingScore(item) >= BREAKING_THRESHOLD;
}

// ─── Category Meta ────────────────────────────────────────────────────────────
const CAT_EMOJI = {
    conflict: '🔴', war: '🔴', military: '🎖️', terrorism: '🚨',
    politics: '🏛️', diplomacy: '🤝', economy: '📊', business: '💼',
    finance: '📈', markets: '📉', technology: '💻', tech: '💻',
    cyber: '🛡️', science: '🔬', health: '🏥', climate: '🌡️',
    environment: '🌿', weather: '⛈️', disaster: '🌊', energy: '⚡',
    nuclear: '☢️', space: '🚀', sports: '⚽', culture: '🎭',
    breaking: '🚨', world: '🌍', asia: '🌏', europe: '🇪🇺',
    americas: '🌎', africa: '🌍', 'middle-east': '🕌', general: '📰',
};

const CAT_HASHTAGS = {
    conflict: '#Conflict #Geopolitics', war: '#War #Conflict',
    military: '#Military #Defense', terrorism: '#Security #Terrorism',
    politics: '#Politics #Government', diplomacy: '#Diplomacy #ForeignPolicy',
    economy: '#Economy #Economics', business: '#Business #Industry',
    finance: '#Finance #Markets', markets: '#StockMarket #Trading',
    technology: '#Technology #Innovation', tech: '#Tech #Innovation',
    cyber: '#CyberSecurity #InfoSec', science: '#Science #Research',
    health: '#Health #PublicHealth', climate: '#Climate #ClimateChange',
    environment: '#Environment #Sustainability', disaster: '#NaturalDisaster #Emergency',
    energy: '#Energy #Power', nuclear: '#Nuclear', space: '#Space #Astronomy',
};

// ─── Deduplication (URL hash + title hash) ──────────────────────────────────
function sha8(str) {
    return createHash('sha256').update(str.toLowerCase().trim()).digest('hex').slice(0, 8);
}

function makeItemId(item) {
    // If we have a URL, use its hash — much more reliable than title
    if (item.link) return `url:${sha8(item.link)}`;
    // Fall back to normalised-title hash
    const normalized = item.title
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120);
    return `ttl:${sha8(normalized)}`;
}

let postedSet = new Set();
let postedHistory = { posted: [], lastRun: null };

function initPostedHistory() {
    if (existsSync(POSTED_FILE)) {
        try {
            postedHistory = JSON.parse(readFileSync(POSTED_FILE, 'utf-8'));
            postedSet = new Set(postedHistory.posted);
            log(`📋 Loaded ${postedSet.size} previously posted IDs`);
        } catch (err) {
            log(`⚠️  Could not load posted.json: ${err.message} — starting fresh`);
        }
    }
}

function markPosted(id) {
    postedSet.add(id);
    postedHistory.posted.push(id);
    postedHistory.posted = postedHistory.posted.slice(-2000);
    postedHistory.lastRun = new Date().toISOString();
    try { writeFileSync(POSTED_FILE, JSON.stringify(postedHistory, null, 2)); }
    catch (err) { log(`⚠️  Could not save posted.json: ${err.message}`); }
}

// ─── Rate-Limit Guard ─────────────────────────────────────────────────────────
function fbRateLimitOk() {
    const now = Date.now();
    if (now - state.fbHourWindow > 3_600_000) {  // Reset hourly window
        state.fbCallsThisHour = 0;
        state.fbHourWindow = now;
    }
    return state.fbCallsThisHour < MAX_FB_PER_HOUR;
}

// ─── Exponential Back-off Fetch ───────────────────────────────────────────────
async function fetchWithRetry(url, options = {}, maxTries = 3) {
    let lastErr;
    for (let attempt = 1; attempt <= maxTries; attempt++) {
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(30_000), ...options });
            return res;
        } catch (err) {
            lastErr = err;
            if (attempt < maxTries) {
                const delay = 1000 * Math.pow(2, attempt - 1);  // 1s, 2s, 4s
                log(`⚠️  Fetch attempt ${attempt}/${maxTries} failed (${err.message}) — retrying in ${delay / 1000}s`);
                await sleep(delay);
            }
        }
    }
    throw lastErr;
}

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';

// ─── World Monitor API ────────────────────────────────────────────────────────
async function fetchNewsDigest() {
    const url = `${WM_API_URL}/api/news/v1/list-feed-digest`;
    const headers = {
        Accept: 'application/json',
        'User-Agent': BROWSER_UA,
        'X-WorldMonitor-Client': `Bot/${VERSION}`
    };
    if (WM_API_KEY) headers['X-WorldMonitor-Key'] = WM_API_KEY;

    const res = await fetchWithRetry(url, { headers });
    if (!res.ok) throw new Error(`WM API returned ${res.status}`);

    const data = await res.json();
    const items = [];

    // API returns categories as an OBJECT: { "categoryName": { "items": [...] } }
    if (data.categories && typeof data.categories === 'object' && !Array.isArray(data.categories)) {
        for (const [catName, bucket] of Object.entries(data.categories)) {
            if (!bucket || !Array.isArray(bucket.items)) continue;

            for (const raw of bucket.items) {
                items.push({
                    title: raw.title || '',
                    link: raw.link || raw.url || '',
                    source: raw.source || raw.feedTitle || '',
                    pubDate: raw.publishedAt || raw.pubDate || '',
                    category: catName,
                    description: raw.description || raw.summary || '',
                    image: raw.image || '',
                });
            }
        }
    }

    return items.sort((a, b) => {
        const dateA = new Date(a.pubDate || 0).getTime();
        const dateB = new Date(b.pubDate || 0).getTime();
        return dateB - dateA;
    });
}

// ─── RSS Fallback Feeds ────────────────────────────────────────────────────────
const RSS_FALLBACK_FEEDS = [
    // Tier 1 — highly reliable on cloud IPs
    { url: 'https://feeds.bbci.co.uk/news/world/rss.xml', category: 'world', source: 'BBC News' },
    { url: 'https://www.aljazeera.com/xml/rss/all.xml', category: 'world', source: 'Al Jazeera' },
    { url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml', category: 'world', source: 'NYT' },
    { url: 'https://feeds.npr.org/1004/rss.xml', category: 'world', source: 'NPR' },
    { url: 'https://www.theguardian.com/world/rss', category: 'world', source: 'The Guardian' },
    { url: 'https://rss.dw.com/rdf/rss-en-world', category: 'world', source: 'DW News' },
    // Tier 2 — usually available
    { url: 'https://feeds.bbci.co.uk/news/technology/rss.xml', category: 'tech', source: 'BBC Tech' },
    { url: 'https://www.theguardian.com/science/rss', category: 'science', source: 'Guardian Science' },
    { url: 'https://feeds.bbci.co.uk/news/business/rss.xml', category: 'business', source: 'BBC Business' },
];

function parseRssItem(xml, fallback) {
    const items = [];
    const itemBlocks = xml.match(/<item>([\s\S]*?)<\/item>/gi) || [];
    for (const block of itemBlocks.slice(0, 10)) {
        const title = (block.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/i) || block.match(/<title>(.*?)<\/title>/i) || [])[1] || '';
        const link = (block.match(/<link>(.*?)<\/link>/i) || [])[1] || '';
        const pubDate = (block.match(/<pubDate>(.*?)<\/pubDate>/i) || [])[1] || '';
        const desc = (block.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/i) || block.match(/<description>(.*?)<\/description>/i) || [])[1] || '';
        if (title) items.push({
            title: htmlEntities(title.trim()),
            link: link.trim(),
            source: fallback.source,
            pubDate: pubDate.trim(),
            category: fallback.category,
            description: htmlEntities(desc.replace(/<[^>]*>/g, '').trim()).slice(0, 300),
        });
    }
    return items;
}

function htmlEntities(str) {
    return str
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/&#039;/g, "'");
}

async function fetchRssFallback() {
    log('📡 World Monitor API down — falling back to RSS feeds');
    const allItems = [];
    await Promise.allSettled(RSS_FALLBACK_FEEDS.map(async (feed) => {
        try {
            const res = await fetchWithRetry(feed.url, {
                headers: { 'User-Agent': BROWSER_UA },
            }, 2);
            if (!res.ok) return;
            const xml = await res.text();
            allItems.push(...parseRssItem(xml, feed));
        } catch (err) {
            log(`  ⚠️  RSS fallback failed (${feed.source}): ${err.message}`);
        }
    }));
    return allItems.sort((a, b) => new Date(b.pubDate || 0) - new Date(a.pubDate || 0));
}

// ─── AI Summary ───────────────────────────────────────────────────────────────
async function fetchAISummary(headlines) {
    try {
        const res = await fetch(`${WM_API_URL}/api/news/v1/summarize-article`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': BROWSER_UA,
                'X-WorldMonitor-Key': WM_API_KEY || ''
            },
            body: JSON.stringify({ headlines: headlines.slice(0, 3), provider: 'groq', mode: 'brief', variant: 'full', lang: 'en' }),
            signal: AbortSignal.timeout(12_000),
        });
        if (!res.ok) return null;
        const data = await res.json();
        return data.summary || null;
    } catch { return null; }
}

// ─── Post Formatting ──────────────────────────────────────────────────────────
function fmtTimeAgo(dateStr) {
    if (!dateStr) return '';
    try {
        const m = Math.floor((Date.now() - new Date(dateStr).getTime()) / 60000);
        if (m < 1) return 'Just now';
        if (m < 60) return `${m}m ago`;
        const h = Math.floor(m / 60);
        if (h < 24) return `${h}h ago`;
        return `${Math.floor(h / 24)}d ago`;
    } catch { return ''; }
}

function formatPost(item, aiSummary, breaking) {
    const cat = (item.category || 'general').toLowerCase();
    const emoji = breaking ? '🚨' : (CAT_EMOJI[cat] || '📰');
    const hashtags = CAT_HASHTAGS[cat] || '#WorldNews';
    let body = '';

    if (breaking) body += `🔴 BREAKING NEWS 🔴\n\n`;
    body += `${emoji} ${item.title}\n\n`;

    if (aiSummary) {
        body += `📝 ${aiSummary}\n\n`;
    } else if (item.description && item.description.length > 20) {
        const d = item.description.replace(/<[^>]*>/g, '').trim().slice(0, 280);
        body += `📝 ${d}${d.length >= 280 ? '…' : ''}\n\n`;
    }

    if (item.source) body += `📌 Source: ${item.source}\n`;
    const ago = fmtTimeAgo(item.pubDate);
    if (ago) body += `🕐 ${ago}\n`;

    body += `\n${hashtags} #WorldMonitor #News`;
    if (breaking) body += ` #BreakingNews`;
    body += `\n━━━━━━━━━━━━━━━━\n🌍 World Monitor`;
    return body;
}

// ─── Facebook Graph API ───────────────────────────────────────────────────────
async function postToFacebook(message, link) {
    if (DRY_RUN) {
        log(`  🧪 [DRY RUN] Would post: ${message.slice(0, 80)}…`);
        return 'dry-run';
    }
    if (!fbRateLimitOk()) {
        log(`  ⚠️  FB rate limit reached (${state.fbCallsThisHour}/${MAX_FB_PER_HOUR}/hr) — skipping`);
        return null;
    }

    const body = { message, access_token: FB_TOKEN };
    if (link) body.link = link;

    const res = await fetch(`${GRAPH_API}/${FB_PAGE_ID}/feed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
    });

    state.fbCallsThisHour++;
    const data = await res.json();
    if (!res.ok) throw new Error(`FB ${res.status}: ${JSON.stringify(data.error || data)}`);
    return data.id;
}

async function postPhotoToFacebook(message, imageUrl) {
    if (DRY_RUN) {
        log(`  🧪 [DRY RUN] Would post photo: ${message.slice(0, 80)}…`);
        return 'dry-run';
    }
    if (!fbRateLimitOk()) return null;

    const body = { caption: message, url: imageUrl, access_token: FB_TOKEN };
    const res = await fetch(`${GRAPH_API}/${FB_PAGE_ID}/photos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
    });

    state.fbCallsThisHour++;
    const data = await res.json();
    if (!res.ok) throw new Error(`FB Photo ${res.status}: ${JSON.stringify(data.error || data)}`);
    return data.id;
}

async function publishItem(item, breaking) {
    const itemId = makeItemId(item);
    if (postedSet.has(itemId)) return false;

    const tag = breaking ? '🚨 BREAKING' : '📰 Regular';
    log(`${tag}: ${item.title}`);

    const aiSummary = await fetchAISummary([item.title]);
    const postText = formatPost(item, aiSummary, breaking);

    try {
        let fbId;
        if (item.image && BOT_BASE_URL) {
            // Use the dynamic card generator if we have a source image
            const cardUrl = `${BOT_BASE_URL}/card?title=${encodeURIComponent(item.title)}&image=${encodeURIComponent(item.image)}`;
            fbId = await postPhotoToFacebook(postText, cardUrl);
        } else {
            // Fallback to regular link post
            fbId = await postToFacebook(postText, item.link);
        }

        if (fbId === null) return false;  // rate limited

        log(`  ✅ Posted → FB ${fbId}`);
        markPosted(itemId);
        state.totalPosted++;
        state.lastPost = new Date().toISOString();
        if (breaking) state.breakingPosted++;
        else state.regularPosted++;
        return true;
    } catch (err) {
        log(`  ❌ Post failed: ${err.message}`);
        state.errors++;
        state.lastError = err.message;
        return false;
    }
}

// ─── Main Poll Loop ───────────────────────────────────────────────────────────
async function poll() {
    state.totalPolls++;
    state.lastPoll = new Date().toISOString();
    log(`📡 Poll #${state.totalPolls}`);

    let items;
    try {
        items = await fetchNewsDigest();
        log(`  ↳ ${items.length} items from World Monitor API`);
    } catch (apiErr) {
        log(`  ⚠️  WM API failed: ${apiErr.message}`);
        state.errors++;
        state.lastError = apiErr.message;
        try {
            items = await fetchRssFallback();
            log(`  ↳ ${items.length} items from RSS fallback`);
        } catch (rssErr) {
            log(`  ❌ RSS fallback also failed: ${rssErr.message}`);
            return;
        }
    }

    if (!items || items.length === 0) return;

    // ── NEW ARTICLE DETECTION ──
    // We do NOT filter by pubDate — World Monitor shows "9 min ago" meaning it DETECTED
    // the article 9 min ago, but the article's RSS pubDate may be hours old.
    // The seeding system (run on startup) marks all currently-available articles as seen.
    // So anything NOT in postedSet = genuinely new to the feed since the bot started = post it.
    const newItems = items.filter(i => i.title && !postedSet.has(makeItemId(i)));
    const breakingList = newItems.filter(i => isBreaking(i));
    const regularList = newItems.filter(i => !isBreaking(i));

    log(`  ↳ New items: ${newItems.length} (🚨 ${breakingList.length} breaking, 📰 ${regularList.length} regular)`);

    // ── POST BREAKING IMMEDIATELY (always) ──
    for (const item of breakingList) {
        await publishItem(item, true);
        await sleep(2000);
    }

    // ── POST REGULAR IMMEDIATELY (capped at MAX_PER_BATCH per poll to avoid flooding) ──
    if (regularList.length > 0) {
        const toPost = regularList.slice(0, MAX_PER_BATCH);
        log(`📦 Posting ${toPost.length} regular article${toPost.length > 1 ? 's' : ''} now`);
        for (const item of toPost) {
            await publishItem(item, false);
            await sleep(3000);
        }
    }
}

// ─── Keep-Alive Ping ──────────────────────────────────────────────────────────
function startKeepAlive() {
    if (!KEEP_ALIVE_URL) return;
    setInterval(async () => {
        try {
            const res = await fetch(KEEP_ALIVE_URL, { signal: AbortSignal.timeout(10_000) });
            log(`💓 Keep-alive ping → ${res.status}`);
        } catch (err) {
            log(`⚠️  Keep-alive ping failed: ${err.message}`);
        }
    }, KEEP_ALIVE_MS);
    log(`💓 Keep-alive enabled → ${KEEP_ALIVE_URL} every ${KEEP_ALIVE_MS / 60000} min`);
}

// ─── Health / Status Server ───────────────────────────────────────────────────
function buildStatusHtml() {
    const up = fmtUptime(process.uptime());
    const mem = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    const logs = state.recentLogs.slice(-30).reverse().map(l =>
        `<span class="log-line">${escHtml(l)}</span>`
    ).join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="refresh" content="30">
  <title>World Monitor Bot — Status</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Segoe UI',system-ui,sans-serif;background:#0d1117;color:#c9d1d9;min-height:100vh}
    header{background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%);padding:24px 32px;border-bottom:1px solid #21262d}
    h1{font-size:1.6rem;font-weight:700;color:#f0f6fc}
    .badge{display:inline-block;background:#238636;color:#fff;font-size:.75rem;padding:3px 10px;border-radius:20px;margin-left:12px;vertical-align:middle}
    .badge.dry{background:#b08800}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;padding:24px 32px}
    .card{background:#161b22;border:1px solid #21262d;border-radius:12px;padding:20px;text-align:center}
    .card .num{font-size:2.2rem;font-weight:700;color:#58a6ff;margin-bottom:4px}
    .card .lbl{font-size:.8rem;color:#8b949e;text-transform:uppercase;letter-spacing:.05em}
    .card.breaking .num{color:#f85149}
    .card.ok .num{color:#3fb950}
    section{padding:0 32px 32px}
    h2{font-size:1rem;color:#8b949e;margin-bottom:12px;text-transform:uppercase;letter-spacing:.08em}
    .log-box{background:#0d1117;border:1px solid #21262d;border-radius:8px;padding:16px;font-family:'Cascadia Code','Fira Code',monospace;font-size:.78rem;max-height:400px;overflow-y:auto;display:flex;flex-direction:column-reverse}
    .log-line{display:block;line-height:1.6;color:#8b949e}
    .log-line:has([data-brk]){color:#f85149}
    footer{padding:16px 32px;border-top:1px solid #21262d;font-size:.75rem;color:#484f58;text-align:center}
  </style>
</head>
<body>
<header>
  <h1>🌍 World Monitor → Facebook Bot
    <span class="badge${DRY_RUN ? ' dry' : ''}">${DRY_RUN ? '🧪 DRY RUN' : '🟢 LIVE'}</span>
  </h1>
  <div style="margin-top:8px;font-size:.85rem;color:#8b949e">v${VERSION} · Started ${state.startedAt} · Up ${up}</div>
</header>

<div class="grid">
  <div class="card"><div class="num">${state.totalPolls}</div><div class="lbl">Polls</div></div>
  <div class="card ok"><div class="num">${state.totalPosted}</div><div class="lbl">Posts Total</div></div>
  <div class="card breaking"><div class="num">${state.breakingPosted}</div><div class="lbl">Breaking</div></div>
  <div class="card"><div class="num">${state.regularPosted}</div><div class="lbl">Regular</div></div>
  <div class="card"><div class="num">${state.errors}</div><div class="lbl">Errors</div></div>
  <div class="card"><div class="num">${mem}MB</div><div class="lbl">Memory</div></div>
  <div class="card"><div class="num">${state.fbCallsThisHour}/${MAX_FB_PER_HOUR}</div><div class="lbl">FB Calls/hr</div></div>
  <div class="card"><div class="num">${postedSet.size}</div><div class="lbl">Seen URLs</div></div>
</div>

<section>
  <h2>📋 Recent Log (last 30 lines · auto-refreshes every 30s)</h2>
  <div class="log-box">${logs}</div>
</section>

<footer>
  Last poll: ${state.lastPoll || 'None yet'} &nbsp;·&nbsp;
  Last post: ${state.lastPost || 'None yet'} &nbsp;·&nbsp;
  Last error: ${state.lastError ? escHtml(state.lastError) : 'None'}
</footer>
</body>
</html>`;
}

function escHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtUptime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${h}h ${m}m ${s}s`;
}

function startHealthServer() {
    const server = createServer((req, res) => {
        if (req.url === '/status' || req.url === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'ok',
                version: VERSION,
                dryRun: DRY_RUN,
                uptime: fmtUptime(process.uptime()),
                memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
                fbCallsThisHour: state.fbCallsThisHour,
                fbCallsLimit: MAX_FB_PER_HOUR,
                ...state,
                recentLogs: undefined,  // exclude from JSON — use dashboard
            }, null, 2));
        } else if (req.url === '/' || req.url === '/dashboard') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(buildStatusHtml());
        } else if (req.url.startsWith('/card')) {
            handleCardRequest(req, res);
        } else {
            res.writeHead(404);
            res.end('Not found');
        }
    });

    server.listen(PORT, () => log(`🏥 Health server → http://localhost:${PORT}/`));
    return server;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function handleCardRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const title = url.searchParams.get('title') || 'Breaking News';
    const imageUrl = url.searchParams.get('image');

    try {
        const card = await renderNewsCard(title, imageUrl);
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' });
        res.end(card);
    } catch (err) {
        log(`  ⚠️  Card render failed: ${err.message}`);
        res.writeHead(500);
        res.end('Internal Server Error');
    }
}

async function renderNewsCard(title, imageUrl) {
    const width = 1080;
    const height = 1080;
    const redColor = '#D0021B';

    // 1. Fetch the main photo
    let mainPhoto;
    try {
        const resp = await fetch(imageUrl, { signal: AbortSignal.timeout(5000), headers: { 'User-Agent': BROWSER_UA } });
        if (!resp.ok) throw new Error('Photo fetch failed');
        mainPhoto = Buffer.from(await resp.arrayBuffer());
    } catch {
        // Fallback or placeholder
        mainPhoto = readFileSync(join(__dirname, 'placeholder_news.jpg'));
    }

    // 2. Process background (square crop)
    const background = await sharp(mainPhoto)
        .resize(width, height, { fit: 'cover' })
        .toBuffer();

    // 3. Create SVG Layers (Header and Bottom Bar)
    const logoFile = join(__dirname, 'logo.png');
    let logoOverlay = [];
    if (existsSync(logoFile)) {
        logoOverlay = [{ input: logoFile, top: 20, left: 20, width: 80, height: 80 }];
    }

    const titleEscaped = title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const footerSvg = Buffer.from(`
        <svg width="${width}" height="300">
            <rect x="0" y="0" width="${width}" height="300" fill="${redColor}" />
            <foreignObject x="40" y="40" width="${width - 80}" height="220">
                <div xmlns="http://www.w3.org/1999/xhtml" style="color: white; font-family: 'Helvetica', 'Arial', sans-serif; font-weight: 800; font-size: 56px; line-height: 1.1; text-align: center; display: flex; align-items: center; justify-content: center; height: 100%; text-transform: uppercase;">
                    ${titleEscaped}
                </div>
            </foreignObject>
        </svg>
    `);

    const headerSvg = Buffer.from(`
        <svg width="${width}" height="100">
            <rect x="0" y="0" width="${width}" height="100" fill="${redColor}" />
            <text x="540" y="65" font-family="sans-serif" font-weight="900" font-size="42px" fill="white" text-anchor="middle" letter-spacing="4px">WORLD MONITOR NEWS</text>
        </svg>
    `);

    // 4. Composite final image
    return sharp(background)
        .composite([
            { input: headerSvg, top: 0, left: 0 },
            { input: footerSvg, top: height - 300, left: 0 },
            ...logoOverlay
        ])
        .png()
        .toBuffer();
}

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
function shutdown(sig) {
    log(`\n🛑 ${sig} — saving state and exiting…`);
    state.isRunning = false;
    try { writeFileSync(POSTED_FILE, JSON.stringify(postedHistory, null, 2)); }
    catch { }
    process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Catch uncaught errors so the process doesn't crash
process.on('uncaughtException', err => { log(`🔥 uncaughtException: ${err.message}`); state.errors++; state.lastError = err.message; });
process.on('unhandledRejection', err => { log(`🔥 unhandledRejection: ${err?.message || err}`); state.errors++; state.lastError = String(err?.message || err); });

// ─── Startup Seed (prevents re-posting on restart) ───────────────────────────
// On first boot (or after Render wipes the ephemeral disk), posted.json is empty.
// Without seeding, the bot would post every article currently in the feeds — many
// of which are hours or days old. This function fetches all current articles once
// and marks them as already-posted WITHOUT publishing anything to Facebook.
// After this, only articles that appear for the FIRST TIME after startup get posted.
async function seedPostedHistory() {
    if (postedSet.size > 0) {
        log(`🌱 Seed skipped — ${postedSet.size} items already in posted history`);
        return;
    }

    log('🌱 Seeding posted history (marking existing articles as seen — will NOT post them)…');
    try {
        let items = [];
        try {
            items = await fetchNewsDigest();
        } catch {
            items = await fetchRssFallback().catch(() => []);
        }

        let seeded = 0;
        for (const item of items) {
            if (!item.title) continue;
            const id = makeItemId(item);
            if (!postedSet.has(id)) {
                postedSet.add(id);
                postedHistory.posted.push(id);
                seeded++;
            }
        }
        // Persist the seeded IDs (inline save — same logic as markPosted)
        postedHistory.posted = postedHistory.posted.slice(-2000);
        postedHistory.lastRun = new Date().toISOString();
        try { writeFileSync(POSTED_FILE, JSON.stringify(postedHistory, null, 2)); }
        catch (e) { log(`⚠️  Could not save seed state: ${e.message}`); }
        log(`🌱 Seeded ${seeded} existing articles — bot will only post NEW content from now on`);
    } catch (err) {
        log(`⚠️  Seed failed (non-fatal): ${err.message}`);
    }
}

// ─── Start ────────────────────────────────────────────────────────────────────
async function start() {
    log('═══════════════════════════════════════════════════════');
    log(`  🤖 World Monitor → Facebook Bot  v${VERSION}`);
    log('═══════════════════════════════════════════════════════');
    log(`  API URL:        ${WM_API_URL}`);
    log(`  Poll interval:  ${POLL_MS / 1000}s`);
    log(`  Batch interval: ${REGULAR_INTERVAL_MS / 60000} min`);
    log(`  Max per batch:  ${MAX_PER_BATCH}`);
    log(`  FB rate limit:  ${MAX_FB_PER_HOUR} calls/hr`);
    log(`  Max article age: ${MAX_ARTICLE_AGE_H * 60} min — older articles are skipped`);
    log(`  Dry run:        ${DRY_RUN}`);
    log('═══════════════════════════════════════════════════════');

    if (!DRY_RUN) {
        if (!FB_TOKEN) { log('❌ FB_PAGE_ACCESS_TOKEN is required'); process.exit(1); }
        if (!FB_PAGE_ID) { log('❌ FB_PAGE_ID is required'); process.exit(1); }
    }

    initPostedHistory();
    startHealthServer();
    startKeepAlive();

    log('\n🟢 Bot is LIVE — monitoring for breaking news…\n');

    // ── Startup seed: mark ALL currently-available articles as seen ──
    // This prevents re-posting old news after a restart (Render ephemeral disk).
    // We fetch once, mark everything as seen WITHOUT posting, then start polling normally.
    await seedPostedHistory();

    // First real poll immediately
    await poll();

    // Then on interval
    setInterval(async () => {
        try { await poll(); }
        catch (err) {
            log(`❌ Interval poll error: ${err.message}`);
            state.errors++;
            state.lastError = err.message;
        }
    }, POLL_MS);
}

start();
