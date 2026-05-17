'use strict';

const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 7860;
const MAX_CONCURRENCY = parseInt(process.env.MAX_CONCURRENCY, 10) || 3;
const NAV_TIMEOUT = parseInt(process.env.NAVIGATION_TIMEOUT, 10) || 30000;
const PAGE_WAIT = parseInt(process.env.PAGE_WAIT_AFTER_LOAD, 10) || 2000;
const ENABLE_WATCH = process.env.ENABLE_WATCH_ENDPOINT !== '0';

// Accept all origins — frontend is on a different domain (Cloudflare Pages)
app.use(cors({
    origin: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: false
}));

// Handle preflight requests
app.options('*', cors());
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
    const launchOpts = {
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-extensions',
            '--disable-background-timer-throttling',
        ],
        headless: true,
    };
    const chromePath = process.env.CHROME_BIN || process.env.CHROME_PATH;
    if (chromePath) launchOpts.executablePath = chromePath;
    browser = await chromium.launch(launchOpts);
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
                if (capturedUrls && !capturedUrls.includes(url)) {
                    capturedUrls.push(url);
                    console.log('[Route] Captured CDN URL:', url.substring(0, 100) + (url.length > 100 ? '…' : ''));
                }
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
    console.log('[Step1] Navigating to FXLinks page:', url);
    const page = await createPage(session.context, null);
    session.pages.add(page);
    try {
        if (session.aborted) throw new Error('Aborted');
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
        console.log('[Step1] Page loaded, waiting', PAGE_WAIT, 'ms for JS to render…');
        await page.waitForTimeout(PAGE_WAIT);

        const results = await page.evaluate(() => {
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
        console.log('[Step1] Extracted', results.length, 'episode(s) from page');
        return results;
    } finally {
        await closePage(page);
        session.pages.delete(page);
    }
}

// ─── STEP 2 + 3: GDFlix → click INSTANT DL → extract direct URL ─────────
async function step2and3(session, episodeHref) {
    if (session.aborted) throw new Error('Aborted');

    const capturedUrls = [];
    const page = await createPage(session.context, capturedUrls);
    session.pages.add(page);

    try {
        console.log('[Step2] Navigating to GDFlix page:', episodeHref);
        await page.goto(episodeHref, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
        await page.waitForTimeout(PAGE_WAIT);
        if (session.aborted) throw new Error('Aborted');

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

        if (!instantInfo) {
            console.log('[Step2] INSTANT DL button NOT found');
            throw new Error('INSTANT DL button not found');
        }
        console.log('[Step2] INSTANT DL found — type:', instantInfo.type, instantInfo.href ? 'href=' + instantInfo.href.substring(0, 80) : '');

        let finalPage = page;
        let popupOpened = false;

        if (instantInfo.type === 'anchor') {
            console.log('[Step2] Following anchor to:', instantInfo.href.substring(0, 80));
            await page.goto(instantInfo.href, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
            await page.waitForTimeout(PAGE_WAIT);
        } else {
            console.log('[Step2] Clicking INSTANT DL button, waiting for popup/navigation…');
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
                page.waitForNavigation({ timeout: NAV_TIMEOUT, waitUntil: 'domcontentloaded' }).catch(() => null),
                popupPromise,
            ]);

            if (popup && !popup.isClosed()) {
                console.log('[Step2] Popup opened:', popup.url().substring(0, 80));
                await attachRoutes(popup, capturedUrls);
                session.pages.add(popup);
                popupOpened = true;
                popup.on('popup', async (p2) => { try { await p2.close(); } catch { } });
                await popup.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => { });
                await popup.waitForTimeout(PAGE_WAIT);
                finalPage = popup;
            } else {
                console.log('[Step2] No popup — staying on same page');
                await page.waitForTimeout(PAGE_WAIT);
                finalPage = page;
            }
        }

        if (session.aborted) throw new Error('Aborted');

        console.log('[Step3] Extracting direct link — captured CDN URLs so far:', capturedUrls.length);
        const link = await extractDirectLink(finalPage, capturedUrls);
        console.log('[Step3] Direct link extracted:', link.substring(0, 100) + (link.length > 100 ? '…' : ''));

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

// ─── EXTRACT DIRECT LINK ─────────────────────────────────────────────────
// This is the critical function — gets the real CDN URL, not the page URL
async function extractDirectLink(page, capturedUrls = []) {
    if (!page || page.isClosed()) throw new Error('Page closed before extraction');

    console.log('[Extract] Waiting for networkidle…');
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => { });
    await page.waitForTimeout(1500);

    // ── Priority 1: captured CDN URLs from network interception ──────────
    if (capturedUrls.length > 0) {
        console.log('[Extract] Priority 1 — checking', capturedUrls.length, 'captured CDN URL(s)');
        const googleDl = capturedUrls.find(u => u.includes('video-downloads.googleusercontent'));
        if (googleDl) { console.log('[Extract] Found googleusercontent CDN URL'); return googleDl; }
        const gv = capturedUrls.find(u => u.includes('googlevideo.com') || u.includes('drive.usercontent.google'));
        if (gv) { console.log('[Extract] Found googlevideo/usercontent CDN URL'); return gv; }
        const gd = capturedUrls.find(u => u.includes('drive.google.com/uc'));
        if (gd) { console.log('[Extract] Found drive.google.com/uc URL'); return gd; }
        const fileUrl = capturedUrls.find(u => /\.(mp4|mkv|avi|mov|m4v|webm|zip|rar)/i.test(u));
        if (fileUrl) { console.log('[Extract] Found file-extension CDN URL'); return fileUrl; }
        console.log('[Extract] Returning first captured URL');
        return capturedUrls[0];
    }

    console.log('[Extract] Priority 1 empty — falling back to DOM scraping');
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

    console.log('[Fetch] ──────────────────────────────────────');
    console.log('[Fetch] New request —', urls.length, 'URL(s):', urls.join(', '));

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.flushHeaders();

    let closed = false;
    req.on('close', () => { closed = true; clearInterval(keepAlive); console.log('[Fetch] Client disconnected'); });

    // Keep-alive ping every 15s to prevent Hugging Face proxy from killing the connection
    const keepAlive = setInterval(() => {
        if (!closed && !res.writableEnded) res.write(':ping\n\n');
    }, 15000);

    const send = obj => { if (!closed && !res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };

    // Acknowledge connection immediately so frontend knows it's connected
    send({ type: 'connected' });
    console.log('[Fetch] SSE connection established, flushing headers');

    let session;
    try {
        session = await createSession();
        console.log('[Fetch] Session created:', session.id);
    } catch (err) {
        console.error('[Fetch] Browser start failed:', err.message);
        send({ type: 'error', message: 'Browser start failed: ' + err.message }); res.end(); return;
    }

    req.on('close', () => destroySession(session).catch(() => { }));

    const enqueue = makeQueue(MAX_CONCURRENCY);
    let total = 0, done = 0;

    try {
        send({ type: 'status', message: 'Scanning FXLinks pages for episodes…' });

        const allEps = [];
        for (let i = 0; i < urls.length; i++) {
            if (session.aborted || closed) break;
            try {
                console.log('[Fetch] Scanning URL', i + 1, 'of', urls.length, '—', urls[i]);
                send({ type: 'status', message: `Scanning URL ${i + 1} of ${urls.length}…` });
                const eps = await step1_getEpisodes(session, urls[i]);
                console.log('[Fetch] URL', i + 1, '→ found', eps.length, 'episode(s)');
                if (!eps.length) {
                    console.log('[Fetch] WARNING: No episodes found in URL', i + 1);
                    send({ type: 'warning', message: `No episodes found in URL ${i + 1}` });
                }
                allEps.push(...eps);
            } catch (err) {
                if (!session.aborted) {
                    console.error('[Fetch] URL', i + 1, 'scan failed:', err.message);
                    send({ type: 'warning', message: `URL ${i + 1} scan failed: ${err.message}` });
                }
            }
        }

        console.log('[Fetch] Total episodes collected:', allEps.length);
        allEps.forEach((ep, idx) => console.log(`  [${idx + 1}] ${ep.text} → ${ep.href}`));

        if (!allEps.length) {
            console.log('[Fetch] No episodes found — ending');
            send({ type: 'done', total: 0 }); res.end(); await destroySession(session); return;
        }

        total = allEps.length;
        send({ type: 'episodes_found', count: total, episodes: allEps.map(e => e.text) });
        console.log('[Fetch] Sent episodes_found event — starting link extraction for', total, 'episode(s)');

        await Promise.allSettled(allEps.map(ep => enqueue(async () => {
            if (session.aborted || closed) {
                done++;
                console.log('[Fetch]', ep.text, '→ ABORTED');
                send({ type: 'result', episode: ep.text, status: 'failed', error: 'Aborted', processed: done, total });
                return;
            }
            console.log('[Fetch]', ep.text, '→ STARTING extraction…');
            send({ type: 'progress', episode: ep.text, status: 'fetching', processed: done, total });
            try {
                const link = await step2and3(session, ep.href);
                done++;
                console.log('[Fetch]', ep.text, '→ DONE —', link.substring(0, 100) + (link.length > 100 ? '…' : ''));
                send({ type: 'result', episode: ep.text, status: 'done', link, processed: done, total });
            } catch (err) {
                done++;
                console.error('[Fetch]', ep.text, '→ FAILED:', err.message);
                send({ type: 'result', episode: ep.text, status: 'failed', error: err.message, processed: done, total });
            }
        })));

        console.log('[Fetch] All episodes processed —', done, '/', total);
    } catch (err) {
        console.error('[Fetch] Unhandled error:', err.message);
        send({ type: 'error', message: err.message });
    } finally {
        clearInterval(keepAlive);
        if (!closed) { send({ type: 'done', total }); res.end(); }
        console.log('[Fetch] Session destroyed, response ended');
        await destroySession(session).catch(() => { });
    }
});

// ─── GOOGLE DRIVE DIRECT LINK RESOLVER ──────────────────────────────────
// The trick: navigate to drive.usercontent.google.com/download?... URL,
// the "Download anyway" anchor's href already contains the direct CDN URL
// with confirm token — no clicking needed, just read the href from DOM.
async function gdirectResolve(session, driveUrl) {
    if (session.aborted) throw new Error('Aborted');

    let targetUrl = driveUrl.trim();
    const fileIdMatch = targetUrl.match(/\/d\/([a-zA-Z0-9_-]{20,})/);
    if (fileIdMatch) {
        targetUrl = `https://drive.usercontent.google.com/download?id=${fileIdMatch[1]}&export=download`;
        console.log('[GDirect-Resolve] Converted file/d/ URL to usercontent format');
    }
    const openIdMatch = targetUrl.match(/[?&]id=([a-zA-Z0-9_-]{20,})/);
    if (!fileIdMatch && openIdMatch) {
        targetUrl = `https://drive.usercontent.google.com/download?id=${openIdMatch[1]}&export=download`;
        console.log('[GDirect-Resolve] Converted open?id= URL to usercontent format');
    }
    console.log('[GDirect-Resolve] Navigating to:', targetUrl.substring(0, 100));

    const page = await createPage(session.context, null);
    session.pages.add(page);
    try {
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(2000);
        console.log('[GDirect-Resolve] Page loaded, scanning for "Download anyway" link…');

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

        if (directUrl) {
            console.log('[GDirect-Resolve] Found "Download anyway" direct URL');
            return directUrl;
        }

        // If no warning page detected, the targetUrl IS the direct link
        // (small files bypass the warning and start downloading directly)
        console.log('[GDirect-Resolve] No warning page — returning targetUrl as direct link');
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

    console.log('[GDirect] ──────────────────────────────────────');
    console.log('[GDirect] New request —', urls.length, 'URL(s)');

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.flushHeaders();

    let closed = false;
    req.on('close', () => { closed = true; clearInterval(keepAlive); console.log('[GDirect] Client disconnected'); });

    // Keep-alive ping every 15s to prevent Hugging Face proxy from killing the connection
    const keepAlive = setInterval(() => {
        if (!closed && !res.writableEnded) res.write(':ping\n\n');
    }, 15000);

    const send = obj => { if (!closed && !res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };

    let session;
    try { session = await createSession(); console.log('[GDirect] Session created:', session.id); }
    catch (err) { console.error('[GDirect] Browser start failed:', err.message); send({ type: 'error', message: 'Browser start failed: ' + err.message }); res.end(); return; }
    req.on('close', () => destroySession(session).catch(() => { }));

    const enqueue = makeQueue(MAX_CONCURRENCY);
    let total = urls.length, done = 0;

    send({ type: 'total', count: total });

    try {
        await Promise.allSettled(urls.map((url, i) => enqueue(async () => {
            if (session.aborted || closed) {
                done++;
                console.log('[GDirect]', i + 1, '→ ABORTED');
                send({ type: 'result', index: i, originalUrl: url, status: 'failed', error: 'Aborted', processed: done, total });
                return;
            }
            console.log('[GDirect]', i + 1, '→ Resolving:', url.substring(0, 80));
            send({ type: 'progress', index: i, originalUrl: url, status: 'resolving', processed: done, total });
            try {
                const link = await gdirectResolve(session, url);
                done++;
                console.log('[GDirect]', i + 1, '→ DONE:', link.substring(0, 100) + (link.length > 100 ? '…' : ''));
                send({ type: 'result', index: i, originalUrl: url, status: 'done', link, processed: done, total });
            } catch (err) {
                done++;
                console.error('[GDirect]', i + 1, '→ FAILED:', err.message);
                send({ type: 'result', index: i, originalUrl: url, status: 'failed', error: err.message, processed: done, total });
            }
        })));
        console.log('[GDirect] All URLs processed —', done, '/', total);
    } catch (err) {
        console.error('[GDirect] Unhandled error:', err.message);
        send({ type: 'error', message: err.message });
    } finally {
        if (!closed) { send({ type: 'done', total }); res.end(); }
        console.log('[GDirect] Session destroyed, response ended');
        await destroySession(session).catch(() => { });
    }
});

// ─── WATCHING YOU — Real non-headless browser playback ───────────────────────
// Opens actual visible browser windows for real video playback.
// A separate chromium instance (headless:false) is used so existing scraping
// sessions are unaffected.

let watchAbortFlag = false;
let watchBrowserInstance = null;

// ─── /api/watch/stop ──────────────────────────────────────────────────────────
app.post('/api/watch/stop', async (_req, res) => {
    watchAbortFlag = true;
    if (watchBrowserInstance) {
        await watchBrowserInstance.close().catch(() => { });
        watchBrowserInstance = null;
    }
    res.json({ status: 'stopped' });
});

app.get('/api/watch', async (req, res) => {
    if (!ENABLE_WATCH) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.flushHeaders();
        res.write(`data: ${JSON.stringify({ type: 'error', message: 'Watch endpoint disabled on this deployment' })}\n\n`);
        res.end();
        return;
    }

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
        // Force headless:true for server deployments (no display available)
        if (watchBrowserInstance && watchBrowserInstance.isConnected()) {
            wb = watchBrowserInstance;
        } else {
            const launchOpts = {
                headless: true,
                args: [
                    '--no-sandbox', '--disable-setuid-sandbox',
                    '--autoplay-policy=no-user-gesture-required',
                    '--disable-features=PreloadMediaEngagementData,MediaEngagementBypassAutoplayPolicies',
                    '--no-first-run', '--disable-background-networking',
                    '--no-zygote', '--single-process',
                ],
            };
            const chromePath = process.env.CHROME_BIN || process.env.CHROME_PATH;
            if (chromePath) launchOpts.executablePath = chromePath;
            wb = await chromium.launch(launchOpts);
            watchBrowserInstance = wb;
            wb.on('disconnected', () => { watchBrowserInstance = null; });
        }
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

// ─── REQUEST LOGGER ───────────────────────────────────────────────────────
app.use((req, res, next) => {
    console.log('[HTTP]', req.method, req.url);
    next();
});

// ─── /api/clear ───────────────────────────────────────────────────────────

app.post('/api/clear', async (_req, res) => {
    let n = 0;
    for (const s of sessions.values()) { await destroySession(s).catch(() => { }); n++; }
    res.json({ status: 'cleared', sessions: n });
});

// ─── /api/health ──────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({ status: 'ok', sessions: sessions.size, browser: browserReady }));

// ─── Root and Health Routes ───────────────────────────────────────────────
app.get('/', (req, res) => {
    res.json({ status: 'ok', message: 'Fetch Links Backend is running!' });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

// ─── START ────────────────────────────────────────────────────────────────
async function start() {
    console.log('');
    console.log('═══════════════════════════════════════════');
    console.log('  LINK FETCHER — Starting up');
    console.log('═══════════════════════════════════════════');
    console.log('[Config] PORT:', PORT);
    console.log('[Config] MAX_CONCURRENCY:', MAX_CONCURRENCY);
    console.log('[Config] NAV_TIMEOUT:', NAV_TIMEOUT, 'ms');
    console.log('[Config] PAGE_WAIT:', PAGE_WAIT, 'ms');
    console.log('[Config] ENABLE_WATCH:', ENABLE_WATCH);
    console.log('');
    await getBrowser();
    console.log('[Server] Listening on 0.0.0.0:' + PORT);
    console.log('[Server] Ready to accept requests');
    console.log('');
    // Hugging Face Spaces and most cloud platforms require binding to 0.0.0.0
    const server = app.listen(PORT, '0.0.0.0', () =>
        console.log(`🔗 LINK FETCHER → http://0.0.0.0:${PORT}`)
    );
    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.log(`[Port] ${PORT} in use — trying ${PORT + 1}…`);
            setTimeout(() => {
                server.close();
                app.listen(PORT + 1, '0.0.0.0', () =>
                    console.log(`\n🔗 LINK FETCHER → http://0.0.0.0:${PORT + 1}\n`)
                );
            }, 1000);
        } else {
            console.error(err);
            process.exit(1);
        }
    });
}

// ─── GLOBAL ERROR HANDLERS ────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err.message);
});

process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason && reason.message ? reason.message : reason);
});

process.on('SIGTERM', async () => {
    console.log('\nSIGTERM — Shutting down…');
    for (const s of sessions.values()) await destroySession(s).catch(() => { });
    if (browser) await browser.close().catch(() => { });
    if (watchBrowserInstance) await watchBrowserInstance.close().catch(() => { });
    process.exit(0);
});

process.on('SIGINT', async () => {
    console.log('\nShutting down…');
    for (const s of sessions.values()) await destroySession(s).catch(() => { });
    if (browser) await browser.close().catch(() => { });
    process.exit(0);
});

start().catch(err => { console.error('Startup error:', err); process.exit(1); });
