'use strict';

const express = require('express');
const { chromium } = require('playwright');
const path = require('path');
const { execSync } = require('child_process');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ─── AD BLOCKER DOMAIN LIST ───────────────────────────────────────────────
const AD_DOMAINS = [
    'doubleclick.net', 'googlesyndication.com', 'adnxs.com', 'outbrain.com',
    'taboola.com', 'popads.net', 'popcash.net', 'adform.net', 'adroll.com',
    'advertising.com', 'google-analytics.com', 'analytics.google.com',
    'googletagmanager.com', 'googletagservices.com', 'hotjar.com',
    'mixpanel.com', 'segment.io', 'segment.com', 'connect.facebook.net',
    'amazon-adsystem.com', 'adsafeprotected.com', 'moatads.com',
    'scorecardresearch.com', 'quantserve.com', 'chartbeat.com',
    'criteo.com', 'criteo.net', 'rubiconproject.com', 'openx.net',
    'pubmatic.com', 'appnexus.com', 'yieldmanager.com', 'adtechus.com',
    'mediavine.com', 'gumgud.com', 'lijit.com', 'sovrn.com',
    'indexexchange.com', 'smartadserver.com', 'mathtag.com',
    'bidswitch.net', 'rlcdn.com', 'casalemedia.com', 'bat.bing.com',
    'propellerads.com', 'mgid.com', 'revcontent.com', 'zedo.com',
    'infolinks.com', 'viglink.com', 'skimlinks.com', 'valueclick.com',
    'trafficjunky.net', 'juicyads.com', 'exoclick.com', 'adcash.com',
    'coinhive.com', 'coin-hive.com', 'crypto-loot.com',
];

// Domains that are CDN/direct-download sources (capture their URLs, then abort)
const CDN_PATTERNS = [
    'video-downloads.googleusercontent.com',
    'googlevideo.com',
    'drive.google.com/uc',
    'drive.usercontent.google.com',
    'lh3.googleusercontent.com',
    '.mp4', '.mkv', '.avi', '.mov', '.m4v', '.webm', '.zip', '.rar',
];

function isCdnUrl(url) {
    return CDN_PATTERNS.some(p => url.includes(p));
}

function isAdDomain(url) {
    try {
        const h = new URL(url).hostname.toLowerCase();
        return AD_DOMAINS.some(d => h === d || h.endsWith('.' + d));
    } catch { return false; }
}

// ─── BROWSER ─────────────────────────────────────────────────────────────
let browser = null;
let browserReady = false;

async function getBrowser() {
    if (browser && browser.isConnected()) return browser;
    browser = await chromium.launch({
        headless: true,
        args: [
            '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas', '--disable-gpu',
            '--disable-background-networking', '--no-first-run',
        ],
    });
    browserReady = true;
    console.log('[Browser] Chromium launched');
    browser.on('disconnected', () => { browser = null; browserReady = false; });
    return browser;
}

// ─── SAFE ROUTE ───────────────────────────────────────────────────────────
async function attachRoutes(page, capturedUrls) {
    await page.route('**/*', async (route) => {
        if (page.isClosed()) { try { route.abort().catch(() => { }); } catch { } return; }
        try {
            const req = route.request();
            const url = req.url();
            const rt = req.resourceType();

            // ── Capture direct CDN/video URLs, then abort (saves bandwidth) ──
            if (isCdnUrl(url)) {
                if (capturedUrls && !capturedUrls.includes(url)) capturedUrls.push(url);
                await route.abort('blockedbyclient').catch(() => { });
                return;
            }

            // ── Block heavy & useless resources ──
            if (['image', 'font', 'media', 'stylesheet'].includes(rt)) {
                await route.abort('blockedbyclient').catch(() => { });
                return;
            }

            // ── Block ad networks ──
            if (isAdDomain(url)) {
                await route.abort('blockedbyclient').catch(() => { });
                return;
            }

            await route.continue().catch(() => { });
        } catch { /* page closed mid-handler — safe */ }
    });
}

// ─── PAGE FACTORY ─────────────────────────────────────────────────────────
async function createPage(context, capturedUrls) {
    const page = await context.newPage();
    page.on('popup', async (p) => { try { await p.close(); } catch { } });
    await attachRoutes(page, capturedUrls);
    page.setDefaultTimeout(20000);
    page.setDefaultNavigationTimeout(20000);
    return page;
}

async function closePage(page) {
    if (!page || page.isClosed()) return;
    try { await page.close(); } catch { }
}

// ─── SESSION ─────────────────────────────────────────────────────────────
const sessions = new Map();

async function createSession() {
    const b = await getBrowser();
    const context = await b.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 800 },
        javaScriptEnabled: true,
    });
    const session = { id: uuidv4(), context, aborted: false, pages: new Set() };
    sessions.set(session.id, session);
    return session;
}

async function destroySession(session) {
    if (!session) return;
    session.aborted = true;
    sessions.delete(session.id);
    for (const p of session.pages) { try { if (!p.isClosed()) await p.close(); } catch { } }
    session.pages.clear();
    try { await session.context.close(); } catch { }
}

// ─── STEP 1: Scrape FXLinks → collect Episode XX links ──────────────────
async function step1_getEpisodes(session, url) {
    const page = await createPage(session.context, null);
    session.pages.add(page);
    try {
        if (session.aborted) throw new Error('Aborted');
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
        await page.waitForTimeout(2000);

        return await page.evaluate(() => {
            const seen = new Set();
            const results = [];
            const re = /^episode\s+\d+/i;
            for (const a of document.querySelectorAll('a[href]')) {
                const text = (a.innerText || a.textContent || '').replace(/\s+/g, ' ').trim();
                const href = a.href;
                if (re.test(text) && href && href.startsWith('http') && !seen.has(href)) {
                    seen.add(href);
                    results.push({ text, href });
                }
            }
            results.sort((a, b) => {
                const n = s => parseInt((s.text.match(/\d+/) || ['0'])[0]);
                return n(a) - n(b);
            });
            return results;
        });
    } finally {
        await closePage(page);
        session.pages.delete(page);
    }
}

// ─── STEP 2 + 3: GDFlix → click INSTANT DL → extract direct URL ─────────
async function step2and3(session, episodeHref) {
    if (session.aborted) throw new Error('Aborted');

    // Shared array: route handler will push captured CDN URLs here
    const capturedUrls = [];

    const page = await createPage(session.context, capturedUrls);
    session.pages.add(page);

    try {
        // ── STEP 2: GDFlix page ─────────────────────────────────────────
        await page.goto(episodeHref, { waitUntil: 'domcontentloaded', timeout: 25000 });
        await page.waitForTimeout(2500);
        if (session.aborted) throw new Error('Aborted');

        // Find INSTANT DL element — try anchor href first (most reliable)
        const instantInfo = await page.evaluate(() => {
            const re = /instant\s*d(own)?l(oad)?/i;
            for (const el of document.querySelectorAll('a, button')) {
                if (re.test((el.innerText || el.textContent || '').trim())) {
                    if (el.tagName === 'A' && el.href && !el.href.endsWith('#') && el.href !== window.location.href) {
                        return { type: 'anchor', href: el.href };
                    }
                    return { type: 'button', href: null };
                }
            }
            return null;
        });

        if (!instantInfo) throw new Error('INSTANT DL button not found');

        let finalPage = page;
        let popupOpened = false;

        if (instantInfo.type === 'anchor') {
            // Direct navigation — cleanest path
            await page.goto(instantInfo.href, { waitUntil: 'domcontentloaded', timeout: 25000 });
            await page.waitForTimeout(2500);
        } else {
            // Button click — could open popup or navigate same page
            const popupPromise = page.waitForEvent('popup', { timeout: 7000 }).catch(() => null);

            await page.evaluate(() => {
                const re = /instant\s*d(own)?l(oad)?/i;
                for (const el of document.querySelectorAll('a, button')) {
                    if (re.test((el.innerText || el.textContent || '').trim())) {
                        el.click(); return;
                    }
                }
            });

            const [, popup] = await Promise.all([
                page.waitForNavigation({ timeout: 8000, waitUntil: 'domcontentloaded' }).catch(() => null),
                popupPromise,
            ]);

            if (popup && !popup.isClosed()) {
                // Attach our route handler to the popup page too
                await attachRoutes(popup, capturedUrls);
                session.pages.add(popup);
                popupOpened = true;
                popup.on('popup', async (p2) => { try { await p2.close(); } catch { } });
                await popup.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => { });
                await popup.waitForTimeout(2500);
                finalPage = popup;
            } else {
                await page.waitForTimeout(2500);
                finalPage = page;
            }
        }

        if (session.aborted) throw new Error('Aborted');

        // ── STEP 3: Extract the DIRECT download URL ────────────────────
        const link = await extractDirectLink(finalPage, capturedUrls);

        if (popupOpened && finalPage !== page) {
            await closePage(finalPage);
            session.pages.delete(finalPage);
        }

        return link;
    } finally {
        await closePage(page);
        session.pages.delete(page);
    }
}

// ─── EXTRACT DIRECT LINK ──────────────────────────────────────────────────
// This is the critical function — gets the real CDN URL, not the page URL
async function extractDirectLink(page, capturedUrls = []) {
    if (!page || page.isClosed()) throw new Error('Page closed before extraction');

    // Wait for JS to render the player/download box
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => { });
    await page.waitForTimeout(1500);

    // ── Priority 1: captured CDN URLs from network interception ──────────
    // These are the most accurate — we catch the exact URL the browser requests
    if (capturedUrls.length > 0) {
        // Prefer video-downloads.googleusercontent.com
        const googleDl = capturedUrls.find(u => u.includes('video-downloads.googleusercontent'));
        if (googleDl) return googleDl;
        // Any googlevideo or googleapis direct link
        const gv = capturedUrls.find(u => u.includes('googlevideo.com') || u.includes('drive.usercontent.google'));
        if (gv) return gv;
        // Drive direct download
        const gd = capturedUrls.find(u => u.includes('drive.google.com/uc'));
        if (gd) return gd;
        // File extension match
        const fileUrl = capturedUrls.find(u => /\.(mp4|mkv|avi|mov|m4v|webm|zip|rar)/i.test(u));
        if (fileUrl) return fileUrl;
        // Return first captured
        return capturedUrls[0];
    }

    // ── Priority 2: DOM scraping ─────────────────────────────────────────
    const link = await page.evaluate(() => {
        function clean(href) {
            if (!href || typeof href !== 'string') return null;
            if (!href.startsWith('http')) return null;
            if (href === window.location.href) return null;
            return href;
        }

        // 2a. <video src> or <source src>
        const video = document.querySelector('video');
        if (video?.src) { const c = clean(video.src); if (c) return c; }
        for (const src of document.querySelectorAll('video source, source')) {
            const c = clean(src.src); if (c) return c;
        }

        // 2b. iframe pointing to a file host/CDN
        const cdnHosts = ['googleusercontent', 'googlevideo', 'googleapis', 'drive.google', 'mediafire', 'mega.nz', 'pixeldrain'];
        for (const iframe of document.querySelectorAll('iframe[src]')) {
            if (cdnHosts.some(h => (iframe.src || '').includes(h))) {
                const c = clean(iframe.src); if (c) return c;
            }
        }

        // 2c. <a href> with googleusercontent / googleapis / cdn patterns
        for (const a of document.querySelectorAll('a[href]')) {
            const href = a.href || '';
            if (
                href.includes('googleusercontent.com') ||
                href.includes('googlevideo.com') ||
                href.includes('drive.usercontent.google') ||
                href.includes('drive.google.com/uc')
            ) {
                const c = clean(href); if (c) return c;
            }
        }

        // 2d. "Download Here" / "Download Link" / "Download Now" anchor text
        for (const a of document.querySelectorAll('a[href]')) {
            const txt = (a.innerText || a.textContent || '').trim();
            const href = a.href || '';
            if (/download\s*(here|link|now|file)/i.test(txt)) {
                const c = clean(href);
                if (c && !c.includes(window.location.hostname)) return c;
            }
        }

        // 2e. data-* attributes that might hold the URL
        for (const el of document.querySelectorAll('[data-url],[data-href],[data-src],[data-link],[data-download]')) {
            const u = el.dataset.url || el.dataset.href || el.dataset.src || el.dataset.link || el.dataset.download;
            if (u && u.startsWith('http')) return u;
        }

        // 2f. File extension match in any anchor
        for (const a of document.querySelectorAll('a[href]')) {
            if (/\.(mp4|mkv|avi|mov|m4v|webm|zip|rar)(\?|$)/i.test(a.href || '')) {
                const c = clean(a.href); if (c) return c;
            }
        }

        // 2g. Any external anchor with "download" in text and external href
        const host = window.location.hostname;
        for (const a of document.querySelectorAll('a[href]')) {
            const txt = (a.innerText || a.textContent || '').toLowerCase();
            const href = a.href || '';
            if (txt.includes('download') && href.startsWith('http') && !href.includes(host)) {
                return href;
            }
        }

        return null;
    });

    if (!link) throw new Error('No direct download link found');
    return link;
}

// ─── CONCURRENCY QUEUE ────────────────────────────────────────────────────
function makeQueue(n) {
    let r = 0; const q = [];
    const next = () => {
        while (r < n && q.length) {
            r++;
            const { fn, res, rej } = q.shift();
            Promise.resolve().then(fn).then(res).catch(rej).finally(() => { r--; next(); });
        }
    };
    return fn => new Promise((res, rej) => { q.push({ fn, res, rej }); next(); });
}

// ─── SSE /api/fetch ───────────────────────────────────────────────────────
app.get('/api/fetch', async (req, res) => {
    const urls = (req.query.urls || '').split(',').map(u => u.trim()).filter(Boolean).slice(0, 10);
    if (!urls.length) return res.status(400).json({ error: 'No URLs' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    let closed = false;
    req.on('close', () => { closed = true; });

    const send = obj => { if (!closed && !res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };

    let session;
    try { session = await createSession(); }
    catch (err) { send({ type: 'error', message: 'Browser start failed: ' + err.message }); res.end(); return; }

    req.on('close', () => destroySession(session).catch(() => { }));

    const enqueue = makeQueue(4);
    let total = 0, done = 0;

    try {
        send({ type: 'status', message: 'Scanning FXLinks pages for episodes…' });

        const allEps = [];
        for (let i = 0; i < urls.length; i++) {
            if (session.aborted || closed) break;
            try {
                send({ type: 'status', message: `Scanning URL ${i + 1} of ${urls.length}…` });
                const eps = await step1_getEpisodes(session, urls[i]);
                if (!eps.length) send({ type: 'warning', message: `No episodes found in URL ${i + 1}` });
                allEps.push(...eps);
            } catch (err) {
                if (!session.aborted) send({ type: 'warning', message: `URL ${i + 1} scan failed: ${err.message}` });
            }
        }

        if (!allEps.length) { send({ type: 'done', total: 0 }); res.end(); await destroySession(session); return; }

        total = allEps.length;
        send({ type: 'episodes_found', count: total, episodes: allEps.map(e => e.text) });

        await Promise.allSettled(allEps.map(ep => enqueue(async () => {
            if (session.aborted || closed) {
                done++;
                send({ type: 'result', episode: ep.text, status: 'failed', error: 'Aborted', processed: done, total });
                return;
            }
            send({ type: 'progress', episode: ep.text, status: 'fetching', processed: done, total });
            try {
                const link = await step2and3(session, ep.href);
                done++;
                send({ type: 'result', episode: ep.text, status: 'done', link, processed: done, total });
            } catch (err) {
                done++;
                console.error(`[${ep.text}] ${err.message}`);
                send({ type: 'result', episode: ep.text, status: 'failed', error: err.message, processed: done, total });
            }
        })));
    } catch (err) {
        send({ type: 'error', message: err.message });
    } finally {
        if (!closed) { send({ type: 'done', total }); res.end(); }
        await destroySession(session).catch(() => { });
    }
});

// ─── GOOGLE DRIVE DIRECT LINK RESOLVER ──────────────────────────────────
// The trick: navigate to drive.usercontent.google.com/download?... URL,
// the "Download anyway" anchor's href already contains the direct CDN URL
// with confirm token — no clicking needed, just read the href from DOM.
async function gdirectResolve(session, driveUrl) {
    if (session.aborted) throw new Error('Aborted');

    // Normalise Google Drive share URLs → usercontent download URL
    let targetUrl = driveUrl.trim();
    // Handles: drive.google.com/file/d/FILE_ID/view  →  drive.usercontent format
    const fileIdMatch = targetUrl.match(/\/d\/([a-zA-Z0-9_-]{20,})/);
    if (fileIdMatch) {
        targetUrl = `https://drive.usercontent.google.com/download?id=${fileIdMatch[1]}&export=download`;
    }
    // Handles: drive.google.com/open?id=FILE_ID
    const openIdMatch = targetUrl.match(/[?&]id=([a-zA-Z0-9_-]{20,})/);
    if (!fileIdMatch && openIdMatch) {
        targetUrl = `https://drive.usercontent.google.com/download?id=${openIdMatch[1]}&export=download`;
    }

    const page = await createPage(session.context, null);
    session.pages.add(page);
    try {
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(2000);

        // Check if we're on the virus-warning page ("Download anyway" link present)
        const directUrl = await page.evaluate((originalUrl) => {
            // Look for "Download anyway" anchor — its href IS the direct URL
            const re = /download\s*any\s*way/i;
            for (const a of document.querySelectorAll('a[href]')) {
                const txt = (a.innerText || a.textContent || '').trim();
                if (re.test(txt) && a.href && a.href.startsWith('http')) {
                    return a.href;
                }
            }
            // Fallback: form with "Download anyway" button
            for (const form of document.querySelectorAll('form')) {
                if (re.test(form.innerText || '')) {
                    // Build URL from form action + hidden inputs
                    const action = form.action;
                    const params = new URLSearchParams();
                    for (const inp of form.querySelectorAll('input')) {
                        if (inp.name) params.set(inp.name, inp.value || '');
                    }
                    if (action) return action + (params.toString() ? '?' + params.toString() : '');
                }
            }
            // If no warning page — the URL itself might already be direct
            // or page redirected to a direct download
            return null;
        }, targetUrl);

        if (directUrl) return directUrl;

        // If no warning page detected, the targetUrl IS the direct link
        // (small files bypass the warning and start downloading directly)
        return targetUrl;
    } finally {
        await closePage(page);
        session.pages.delete(page);
    }
}

// ─── SSE /api/gdirect ────────────────────────────────────────────────────
app.get('/api/gdirect', async (req, res) => {
    const urls = (req.query.urls || '').split(',').map(u => u.trim()).filter(Boolean).slice(0, 20);
    if (!urls.length) return res.status(400).json({ error: 'No URLs' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    let closed = false;
    req.on('close', () => { closed = true; });
    const send = obj => { if (!closed && !res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };

    let session;
    try { session = await createSession(); }
    catch (err) { send({ type: 'error', message: 'Browser start failed: ' + err.message }); res.end(); return; }
    req.on('close', () => destroySession(session).catch(() => { }));

    const enqueue = makeQueue(4);
    let total = urls.length, done = 0;

    send({ type: 'total', count: total });

    try {
        await Promise.allSettled(urls.map((url, i) => enqueue(async () => {
            if (session.aborted || closed) {
                done++;
                send({ type: 'result', index: i, originalUrl: url, status: 'failed', error: 'Aborted', processed: done, total });
                return;
            }
            send({ type: 'progress', index: i, originalUrl: url, status: 'resolving', processed: done, total });
            try {
                const link = await gdirectResolve(session, url);
                done++;
                send({ type: 'result', index: i, originalUrl: url, status: 'done', link, processed: done, total });
            } catch (err) {
                done++;
                console.error(`[GDirect ${i + 1}] ${err.message}`);
                send({ type: 'result', index: i, originalUrl: url, status: 'failed', error: err.message, processed: done, total });
            }
        })));
    } catch (err) {
        send({ type: 'error', message: err.message });
    } finally {
        if (!closed) { send({ type: 'done', total }); res.end(); }
        await destroySession(session).catch(() => { });
    }
});

// ─── WATCHING YOU — Real non-headless browser playback ───────────────────────
// Opens actual visible browser windows for real video playback.
// A separate chromium instance (headless:false) is used so existing scraping
// sessions are unaffected.

let watchAbortFlag = false;
let watchBrowserInstance = null;

async function getWatchBrowser() {
    if (watchBrowserInstance && watchBrowserInstance.isConnected()) return watchBrowserInstance;
    watchBrowserInstance = await chromium.launch({
        headless: false,
        args: [
            '--no-sandbox', '--disable-setuid-sandbox',
            '--autoplay-policy=no-user-gesture-required',  // allow videos to autoplay
            '--disable-features=PreloadMediaEngagementData,MediaEngagementBypassAutoplayPolicies',
            '--no-first-run', '--disable-background-networking',
        ],
    });
    watchBrowserInstance.on('disconnected', () => { watchBrowserInstance = null; });
    return watchBrowserInstance;
}

app.get('/api/watch', async (req, res) => {
    const urls = (req.query.urls || '').split(',').map(u => u.trim()).filter(Boolean).slice(0, 4);
    if (!urls.length) return res.status(400).json({ error: 'No URLs' });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    let closed = false;
    req.on('close', () => { closed = true; watchAbortFlag = true; });
    const send = obj => { if (!closed && !res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };

    const CYCLES = 10, DURATION = 15;
    let wb = null, ctx = null;
    watchAbortFlag = false;

    try {
        wb = await getWatchBrowser();
        ctx = await wb.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
            viewport: null,  // use window size
        });

        send({ type: 'start', total: CYCLES, duration: DURATION, urlCount: urls.length });

        for (let cycle = 1; cycle <= CYCLES; cycle++) {
            if (closed || watchAbortFlag) break;

            send({ type: 'cycle_start', cycle, total: CYCLES });
            console.log(`[Watch] Cycle ${cycle}/${CYCLES} — opening ${urls.length} page(s)`);

            // ── Open all URLs concurrently ──
            const pages = await Promise.all(urls.map(async (url, i) => {
                try {
                    const page = await ctx.newPage();
                    // Block ads/trackers to speed up load
                    await page.route('**/*', async route => {
                        const h = (() => { try { return new URL(route.request().url()).hostname; } catch { return ''; } })();
                        if (AD_DOMAINS.some(d => h === d || h.endsWith('.' + d))) {
                            await route.abort('blockedbyclient').catch(() => { });
                        } else {
                            await route.continue().catch(() => { });
                        }
                    });
                    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => { });

                    // Try to click play button for YouTube / common players
                    await page.evaluate(() => {
                        // YouTube large play button
                        const ytPlay = document.querySelector('.ytp-large-play-button, .ytp-play-button, button[aria-label*="Play"], button[title*="Play"]');
                        if (ytPlay) ytPlay.click();
                        // HTML5 video element
                        const vid = document.querySelector('video');
                        if (vid && vid.paused) vid.play().catch(() => { });
                    }).catch(() => { });

                    send({ type: 'page_opened', index: i, url, cycle });
                    return page;
                } catch (err) {
                    send({ type: 'page_error', index: i, url, cycle, error: err.message });
                    return null;
                }
            }));

            // ── Countdown 15 seconds ──
            for (let s = DURATION; s > 0; s--) {
                if (closed || watchAbortFlag) break;
                send({ type: 'countdown', cycle, total: CYCLES, seconds: s });
                await new Promise(r => setTimeout(r, 1000));
            }

            // ── Close all pages ──
            await Promise.all(pages.map(p => p ? p.close().catch(() => { }) : Promise.resolve()));
            send({ type: 'cycle_end', cycle, total: CYCLES });

            // 1.2s gap between cycles
            if (cycle < CYCLES && !closed && !watchAbortFlag) {
                await new Promise(r => setTimeout(r, 1200));
            }
        }

        if (!closed) send({ type: 'done', cycles: CYCLES });
    } catch (err) {
        console.error('[Watch] Error:', err.message);
        if (!closed) send({ type: 'error', message: err.message });
    } finally {
        if (ctx) await ctx.close().catch(() => { });
        if (!closed) res.end();
    }
});

// ─── /api/watch/stop ──────────────────────────────────────────────────────────
app.post('/api/watch/stop', async (_req, res) => {
    watchAbortFlag = true;
    if (watchBrowserInstance) {
        await watchBrowserInstance.close().catch(() => { });
        watchBrowserInstance = null;
    }
    res.json({ status: 'stopped' });
});

// ─── /api/clear ───────────────────────────────────────────────────────────

app.post('/api/clear', async (_req, res) => {
    let n = 0;
    for (const s of sessions.values()) { await destroySession(s).catch(() => { }); n++; }
    res.json({ status: 'cleared', sessions: n });
});

// ─── /api/health ──────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({ status: 'ok', sessions: sessions.size, browser: browserReady }));

// ─── Serve frontend ───────────────────────────────────────────────────────
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ─── AUTO-FREE PORT & START ───────────────────────────────────────────────
async function freePort(port) {
    try {
        const out = execSync(
            `netstat -ano | findstr :${port} | findstr LISTENING`,
            { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
        );
        const pid = out.trim().split(/\s+/).pop();
        if (pid && !isNaN(pid)) {
            execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
            console.log(`[Port] Freed port ${port} (killed PID ${pid})`);
            await new Promise(r => setTimeout(r, 800));
        }
    } catch { /* port was free */ }
}

async function start() {
    await freePort(PORT);
    await getBrowser();
    const server = app.listen(PORT, () =>
        console.log(`\n🔗 LINK FETCHER → http://localhost:${PORT}\n`)
    );
    server.on('error', async (err) => {
        if (err.code === 'EADDRINUSE') {
            console.log(`[Port] ${PORT} still in use — retrying once…`);
            await freePort(PORT);
            setTimeout(() => server.listen(PORT), 1000);
        } else {
            console.error(err);
            process.exit(1);
        }
    });
}

process.on('SIGINT', async () => {
    console.log('\nShutting down…');
    for (const s of sessions.values()) await destroySession(s).catch(() => { });
    if (browser) await browser.close().catch(() => { });
    process.exit(0);
});

start().catch(err => { console.error('Startup error:', err); process.exit(1); });
