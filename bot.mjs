/**
 * World Monitor → Facebook Auto-Post Bot (Real-Time)
 *
 * Runs as a persistent service on Render.
 * Polls World Monitor every 60 seconds for new headlines.
 * Posts INSTANTLY when breaking news is detected.
 * Regular news is batched and posted every 15 minutes.
 *
 * Environment variables (set in Render Dashboard):
 *   FB_PAGE_ACCESS_TOKEN  - Facebook Page access token (permanent)
 *   FB_PAGE_ID            - Facebook Page ID
 *   WORLDMONITOR_API_URL  - Your World Monitor URL
 *   MAX_POSTS_PER_BATCH   - Max regular posts per batch (default: 3)
 *   POLL_INTERVAL_MS      - Polling interval in ms (default: 60000 = 1 min)
 *   PORT                  - HTTP port for Render health check (default: 3000)
 */

import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Config ──────────────────────────────────────────────────────────
const FB_PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN || '';
const FB_PAGE_ID = process.env.FB_PAGE_ID || '';
const WORLDMONITOR_API_URL = (process.env.WORLDMONITOR_API_URL || 'https://worldmonitor-oshada.vercel.app').replace(/\/$/, '');
const MAX_POSTS_PER_BATCH = parseInt(process.env.MAX_POSTS_PER_BATCH || '3', 10);
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL_MS || '60000', 10); // 1 min
const REGULAR_POST_INTERVAL = 15 * 60 * 1000; // 15 min for regular news
const PORT = parseInt(process.env.PORT || '3000', 10);
const GRAPH_API = 'https://graph.facebook.com/v19.0';
const POSTED_FILE = join(__dirname, 'posted.json');

// ─── State ───────────────────────────────────────────────────────────
let stats = {
    startedAt: new Date().toISOString(),
    totalPolls: 0,
    totalPosted: 0,
    breakingPosted: 0,
    regularPosted: 0,
    lastPoll: null,
    lastPost: null,
    lastRegularBatch: Date.now(),
    errors: 0,
    lastError: null,
    isRunning: true,
};

// ─── Breaking News Detection ─────────────────────────────────────────
const BREAKING_KEYWORDS = [
    'breaking',
    'urgent',
    'just in',
    'alert',
    'developing',
    'flash',
    'explosion',
    'earthquake',
    'tsunami',
    'attack',
    'war declared',
    'ceasefire',
    'assassination',
    'coup',
    'nuclear',
    'missile',
    'invasion',
    'emergency',
    'crashed',
    'shot down',
    'mass shooting',
    'hostage',
    'collapse',
];

function isBreakingNews(item) {
    const text = `${item.title} ${item.description || ''}`.toLowerCase();

    // Check for breaking keywords
    for (const keyword of BREAKING_KEYWORDS) {
        if (text.includes(keyword)) return true;
    }

    // Check if published very recently (within 10 minutes)
    if (item.pubDate) {
        const pubTime = new Date(item.pubDate).getTime();
        const now = Date.now();
        const ageMinutes = (now - pubTime) / 60000;
        if (ageMinutes < 10) return true; // Very fresh = treat as urgent
    }

    return false;
}

// ─── Category Styling ────────────────────────────────────────────────
const CATEGORY_EMOJI = {
    'conflict': '🔴', 'war': '🔴', 'military': '🎖️',
    'terrorism': '🚨', 'politics': '🏛️', 'diplomacy': '🤝',
    'economy': '📊', 'business': '💼', 'finance': '📈',
    'markets': '📉', 'technology': '💻', 'tech': '💻',
    'cyber': '🛡️', 'science': '🔬', 'health': '🏥',
    'climate': '🌡️', 'environment': '🌿', 'weather': '⛈️',
    'disaster': '🌊', 'energy': '⚡', 'nuclear': '☢️',
    'space': '🚀', 'sports': '⚽', 'culture': '🎭',
    'breaking': '🚨', 'world': '🌍', 'asia': '🌏',
    'europe': '🇪🇺', 'americas': '🌎', 'africa': '🌍',
    'middle-east': '🕌', 'general': '📰',
};

const CATEGORY_HASHTAGS = {
    'conflict': '#Conflict #Geopolitics',
    'war': '#War #Conflict',
    'military': '#Military #Defense',
    'terrorism': '#Security #Terrorism',
    'politics': '#Politics #Government',
    'diplomacy': '#Diplomacy #ForeignPolicy',
    'economy': '#Economy #Economics',
    'business': '#Business #Industry',
    'finance': '#Finance #Markets',
    'markets': '#StockMarket #Trading',
    'technology': '#Technology #Innovation',
    'tech': '#Tech #Innovation',
    'cyber': '#CyberSecurity #InfoSec',
    'science': '#Science #Research',
    'health': '#Health #PublicHealth',
    'climate': '#Climate #ClimateChange',
    'environment': '#Environment #Sustainability',
    'disaster': '#NaturalDisaster #Emergency',
    'energy': '#Energy #Power',
    'nuclear': '#Nuclear',
    'space': '#Space #Astronomy',
};

// ─── Deduplication ───────────────────────────────────────────────────
function loadPosted() {
    if (!existsSync(POSTED_FILE)) return { posted: [], lastRun: null };
    try {
        return JSON.parse(readFileSync(POSTED_FILE, 'utf-8'));
    } catch {
        return { posted: [], lastRun: null };
    }
}

function savePosted(data) {
    data.posted = data.posted.slice(-1000); // Keep last 1000
    data.lastRun = new Date().toISOString();
    try {
        writeFileSync(POSTED_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
        console.warn(`⚠️ Could not save posted.json: ${err.message}`);
    }
}

function makeHeadlineId(headline) {
    return headline
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 100);
}

// In-memory set for faster lookups (file is backup for restarts)
let postedSet = new Set();
let postedHistory = { posted: [], lastRun: null };

function initPostedHistory() {
    postedHistory = loadPosted();
    postedSet = new Set(postedHistory.posted);
    console.log(`📋 Loaded ${postedSet.size} previously posted items`);
}

function markAsPosted(headlineId) {
    postedSet.add(headlineId);
    postedHistory.posted.push(headlineId);
    savePosted(postedHistory);
}

// ─── World Monitor API ──────────────────────────────────────────────
async function fetchNewsDigest() {
    const url = `${WORLDMONITOR_API_URL}/api/news/v1/list-feed-digest`;

    const res = await fetch(url, {
        headers: {
            'Accept': 'application/json',
            'User-Agent': 'WorldMonitor-FB-Bot/1.0',
        },
        signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
        throw new Error(`News API ${res.status}`);
    }

    const data = await res.json();
    const allItems = [];

    if (data.categories && Array.isArray(data.categories)) {
        for (const cat of data.categories) {
            const categoryName = cat.name || cat.category || 'general';
            if (cat.items && Array.isArray(cat.items)) {
                for (const item of cat.items) {
                    allItems.push({
                        title: item.title || '',
                        link: item.link || item.url || '',
                        source: item.source || item.feedTitle || '',
                        pubDate: item.pubDate || item.publishedAt || '',
                        category: categoryName,
                        description: item.description || item.summary || '',
                    });
                }
            }
        }
    }

    // Sort newest first
    allItems.sort((a, b) => {
        const da = new Date(a.pubDate || 0).getTime();
        const db = new Date(b.pubDate || 0).getTime();
        return db - da;
    });

    return allItems;
}

// ─── AI Summary ──────────────────────────────────────────────────────
async function fetchAISummary(headlines) {
    try {
        const url = `${WORLDMONITOR_API_URL}/api/news/v1/summarize-article`;
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'WorldMonitor-FB-Bot/1.0',
            },
            body: JSON.stringify({
                headlines: headlines.slice(0, 5),
                provider: 'groq',
                mode: 'brief',
                variant: 'full',
                lang: 'en',
            }),
            signal: AbortSignal.timeout(15_000),
        });

        if (!res.ok) return null;
        const data = await res.json();
        return data.summary || null;
    } catch {
        return null;
    }
}

// ─── Post Formatting ─────────────────────────────────────────────────
function formatPost(item, aiSummary, isBreaking) {
    const catKey = (item.category || 'general').toLowerCase();
    const emoji = isBreaking ? '🚨' : (CATEGORY_EMOJI[catKey] || '📰');
    const hashtags = CATEGORY_HASHTAGS[catKey] || '#WorldNews';
    const timeAgo = getTimeAgo(item.pubDate);

    let body = '';

    // Breaking banner
    if (isBreaking) {
        body += `🔴 BREAKING NEWS 🔴\n\n`;
    }

    // Headline
    body += `${emoji} ${item.title}\n\n`;

    // AI Summary or description
    if (aiSummary) {
        body += `📝 ${aiSummary}\n\n`;
    } else if (item.description) {
        const cleanDesc = item.description
            .replace(/<[^>]*>/g, '')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .trim()
            .slice(0, 280);
        if (cleanDesc.length > 20) {
            body += `📝 ${cleanDesc}${cleanDesc.length >= 280 ? '...' : ''}\n\n`;
        }
    }

    // Meta
    if (item.source) body += `📌 Source: ${item.source}\n`;
    if (timeAgo) body += `🕐 ${timeAgo}\n`;

    // Link
    if (item.link) {
        body += `\n🔗 Read more: ${item.link}\n`;
    }

    // Hashtags
    body += `\n${hashtags} #WorldMonitor #News`;
    if (isBreaking) body += ` #BreakingNews`;
    body += `\n━━━━━━━━━━━━━━━━━━━━━\n`;
    body += `🌍 Powered by World Monitor`;

    return body;
}

function getTimeAgo(dateStr) {
    if (!dateStr) return '';
    try {
        const diffMin = Math.floor((Date.now() - new Date(dateStr).getTime()) / 60000);
        if (diffMin < 1) return 'Just now';
        if (diffMin < 60) return `${diffMin}m ago`;
        const diffHr = Math.floor(diffMin / 60);
        if (diffHr < 24) return `${diffHr}h ago`;
        return `${Math.floor(diffHr / 24)}d ago`;
    } catch { return ''; }
}

// ─── Facebook Graph API ──────────────────────────────────────────────
async function postToFacebook(message, link) {
    const url = `${GRAPH_API}/${FB_PAGE_ID}/feed`;
    const body = { message, access_token: FB_PAGE_ACCESS_TOKEN };
    if (link) body.link = link;

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
    });

    const data = await res.json();
    if (!res.ok) {
        throw new Error(`FB API: ${JSON.stringify(data.error || data)}`);
    }
    return data.id;
}

async function publishItem(item, isBreaking) {
    const headlineId = makeHeadlineId(item.title);
    if (postedSet.has(headlineId)) return false;

    const tag = isBreaking ? '🚨 BREAKING' : '📰 Regular';
    console.log(`\n${tag}: ${item.title}`);

    // Get AI summary
    const aiSummary = await fetchAISummary([item.title]);
    const postContent = formatPost(item, aiSummary, isBreaking);

    try {
        const postId = await postToFacebook(postContent, item.link);
        console.log(`  ✅ Posted → FB ID: ${postId}`);
        markAsPosted(headlineId);
        stats.totalPosted++;
        stats.lastPost = new Date().toISOString();
        if (isBreaking) stats.breakingPosted++;
        else stats.regularPosted++;
        return true;
    } catch (err) {
        console.error(`  ❌ Failed: ${err.message}`);
        stats.errors++;
        stats.lastError = err.message;
        return false;
    }
}

// ─── Main Poll Loop ──────────────────────────────────────────────────
async function poll() {
    stats.totalPolls++;
    stats.lastPoll = new Date().toISOString();

    try {
        const items = await fetchNewsDigest();
        if (items.length === 0) return;

        // Separate breaking vs regular news
        const newItems = items.filter(item => {
            const id = makeHeadlineId(item.title);
            return id && !postedSet.has(id);
        });

        if (newItems.length === 0) return;

        const breakingItems = newItems.filter(item => isBreakingNews(item));
        const regularItems = newItems.filter(item => !isBreakingNews(item));

        // ── BREAKING: Post immediately ──
        for (const item of breakingItems) {
            await publishItem(item, true);
            // 2 sec delay between posts
            await sleep(2000);
        }

        // ── REGULAR: Post in batches every 15 min ──
        const now = Date.now();
        const timeSinceLastBatch = now - stats.lastRegularBatch;

        if (regularItems.length > 0 && timeSinceLastBatch >= REGULAR_POST_INTERVAL) {
            console.log(`\n📦 Regular batch — ${regularItems.length} new items available`);
            const batch = regularItems.slice(0, MAX_POSTS_PER_BATCH);

            for (const item of batch) {
                await publishItem(item, false);
                await sleep(3000);
            }

            stats.lastRegularBatch = now;
        }

    } catch (err) {
        console.error(`❌ Poll error: ${err.message}`);
        stats.errors++;
        stats.lastError = err.message;
    }
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// ─── Health Check Server (Render requires a port) ────────────────────
function startHealthServer() {
    const server = createServer((req, res) => {
        if (req.url === '/health' || req.url === '/') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'ok',
                service: 'worldmonitor-fb-bot',
                ...stats,
                uptime: process.uptime(),
                memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
            }, null, 2));
        } else {
            res.writeHead(404);
            res.end('Not found');
        }
    });

    server.listen(PORT, () => {
        console.log(`🏥 Health check server on port ${PORT}`);
    });
}

// ─── Startup ────────────────────────────────────────────────────────
async function start() {
    console.log('═══════════════════════════════════════════');
    console.log('  🤖 World Monitor → Facebook Bot (Live)');
    console.log('═══════════════════════════════════════════');
    console.log(`📅 Started: ${new Date().toISOString()}`);
    console.log(`🌐 API: ${WORLDMONITOR_API_URL}`);
    console.log(`⏱️  Poll interval: ${POLL_INTERVAL / 1000}s`);
    console.log(`📦 Regular batch interval: ${REGULAR_POST_INTERVAL / 60000}min`);
    console.log(`📝 Max posts per batch: ${MAX_POSTS_PER_BATCH}`);
    console.log('');

    // Validate
    if (!FB_PAGE_ACCESS_TOKEN) {
        console.error('❌ FB_PAGE_ACCESS_TOKEN is required');
        process.exit(1);
    }
    if (!FB_PAGE_ID) {
        console.error('❌ FB_PAGE_ID is required');
        process.exit(1);
    }

    // Initialize
    initPostedHistory();
    startHealthServer();

    console.log('\n🟢 Bot is LIVE — monitoring for news...\n');

    // Initial poll
    await poll();

    // Continuous polling
    setInterval(async () => {
        await poll();
    }, POLL_INTERVAL);
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
    console.log('\n🛑 Shutting down gracefully...');
    stats.isRunning = false;
    savePosted(postedHistory);
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('\n🛑 Interrupted — saving state...');
    stats.isRunning = false;
    savePosted(postedHistory);
    process.exit(0);
});

start();
