'use strict';

const cheerio = require('cheerio');
const { DEFAULT_HEADERS, isCdnUrl, isAdDomain } = require('./constants');
const { BrowserSession, attachRoutes } = require('./browser');

/**
 * Normalizes and extracts episode links from FXLinks / Series index page
 */
async function getEpisodes(pageUrl, session) {
    // If browser session provided, scrape with browser to bypass Cloudflare
    if (session && session.newPage) {
        const page = await session.newPage();
        try {
            await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
            await page.waitForTimeout(1500);

            const results = await page.evaluate(() => {
                const seen = new Set();
                const items = [];
                const re = /^(?:episode|ep\.?)\s*(\d+)/i;

                for (const a of document.querySelectorAll('a[href]')) {
                    const text = (a.innerText || a.textContent || '').replace(/\s+/g, ' ').trim();
                    const href = a.href;
                    if (re.test(text) && href && href.startsWith('http') && !seen.has(href)) {
                        seen.add(href);
                        items.push({ text, href });
                    }
                }

                if (items.length === 0) {
                    const looseRe = /episode\s*(\d+)/i;
                    for (const a of document.querySelectorAll('a[href]')) {
                        const text = (a.innerText || a.textContent || '').replace(/\s+/g, ' ').trim();
                        const href = a.href;
                        if (looseRe.test(text) && href && href.startsWith('http') && !seen.has(href)) {
                            seen.add(href);
                            items.push({ text, href });
                        }
                    }
                }

                items.sort((a, b) => {
                    const n = s => {
                        const m = s.text.match(/\d+/);
                        return m ? parseInt(m[0], 10) : 0;
                    };
                    return n(a) - n(b);
                });

                return items;
            });

            return results;
        } finally {
            await session.closePage(page);
        }
    }

    // Fallback: fast HTTP fetch
    const res = await fetch(pageUrl, { headers: DEFAULT_HEADERS });
    if (!res.ok) {
        throw new Error(`Failed to fetch series page: HTTP ${res.status}`);
    }

    const html = await res.text();
    const $ = cheerio.load(html);
    const seen = new Set();
    const results = [];
    const re = /^(?:episode|ep\.?)\s*(\d+)/i;

    $('a[href]').each((_, el) => {
        const $el = $(el);
        const text = ($el.text() || '').replace(/\s+/g, ' ').trim();
        let href = $el.attr('href') || '';
        if (!href || href.startsWith('javascript:') || href === '#') return;
        try { href = new URL(href, pageUrl).href; } catch { return; }

        if (re.test(text) && href.startsWith('http') && !seen.has(href)) {
            seen.add(href);
            results.push({ text, href });
        }
    });

    results.sort((a, b) => {
        const n = s => {
            const m = s.text.match(/\d+/);
            return m ? parseInt(m[0], 10) : 0;
        };
        return n(a) - n(b);
    });

    return results;
}

/**
 * Extracts the direct CDN download link from a loaded Chromium page
 */
async function extractDirectLink(page, capturedUrls = []) {
    if (!page || page.isClosed()) throw new Error('Page closed before extraction');

    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1200);

    // 1. Intercepted CDN URLs from network traffic (Highest accuracy)
    if (capturedUrls && capturedUrls.length > 0) {
        const googleDl = capturedUrls.find(u => u.includes('video-downloads.googleusercontent'));
        if (googleDl) return googleDl;
        const gv = capturedUrls.find(u => u.includes('googlevideo.com') || u.includes('drive.usercontent.google'));
        if (gv) return gv;
        const gd = capturedUrls.find(u => u.includes('drive.google.com/uc'));
        if (gd) return gd;
        const fileUrl = capturedUrls.find(u => /\.(mp4|mkv|avi|mov|m4v|webm|zip|rar)/i.test(u));
        if (fileUrl) return fileUrl;
        return capturedUrls[0];
    }

    // 2. DOM extraction
    const link = await page.evaluate(() => {
        function clean(href) {
            if (!href || typeof href !== 'string') return null;
            if (!href.startsWith('http')) return null;
            if (href === window.location.href) return null;
            return href;
        }

        const video = document.querySelector('video');
        if (video?.src) { const c = clean(video.src); if (c) return c; }
        for (const src of document.querySelectorAll('video source, source')) {
            const c = clean(src.src); if (c) return c;
        }

        const cdnHosts = ['googleusercontent', 'googlevideo', 'googleapis', 'drive.google', 'mediafire', 'mega.nz', 'pixeldrain'];
        for (const iframe of document.querySelectorAll('iframe[src]')) {
            if (cdnHosts.some(h => (iframe.src || '').includes(h))) {
                const c = clean(iframe.src); if (c) return c;
            }
        }

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

        for (const a of document.querySelectorAll('a[href]')) {
            const txt = (a.innerText || a.textContent || '').trim();
            const href = a.href || '';
            if (/download\s*(here|link|now|file|direct)/i.test(txt)) {
                const c = clean(href);
                if (c && !c.includes(window.location.hostname)) return c;
            }
        }

        for (const el of document.querySelectorAll('[data-url],[data-href],[data-src],[data-link],[data-download]')) {
            const u = el.dataset.url || el.dataset.href || el.dataset.src || el.dataset.link || el.dataset.download;
            if (u && u.startsWith('http')) return u;
        }

        for (const a of document.querySelectorAll('a[href]')) {
            if (/\.(mp4|mkv|avi|mov|m4v|webm|zip|rar)(\?|$)/i.test(a.href || '')) {
                const c = clean(a.href); if (c) return c;
            }
        }

        return null;
    });

    if (!link) throw new Error('No direct download link found');
    return link;
}

/**
 * Resolves GDFlix / HubCloud / FastDL page and extracts direct download link using Chromium
 */
async function resolveGDFlix(episodeHref, session) {
    if (!session || !session.newPage) {
        throw new Error('Browser session required for GDFlix Cloudflare bypass');
    }

    if (session.aborted) throw new Error('Aborted');

    const capturedUrls = [];
    const page = await session.newPage(capturedUrls);

    try {
        await page.goto(episodeHref, { waitUntil: 'domcontentloaded', timeout: 25000 });
        await page.waitForTimeout(2000);
        if (session.aborted) throw new Error('Aborted');

        // Check if page itself already resolved to CDN or direct file
        if (isCdnUrl(page.url())) {
            return page.url();
        }

        // Find INSTANT DL button / anchor
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

            // Fallback: search Fast Cloud / Direct Cloud buttons
            const cloudRe = /(fast\s*cloud|direct\s*cloud|hubcloud|direct\s*dl)/i;
            for (const el of document.querySelectorAll('a, button')) {
                if (cloudRe.test((el.innerText || el.textContent || '').trim())) {
                    if (el.tagName === 'A' && el.href && !el.href.endsWith('#') && el.href !== window.location.href) {
                        return { type: 'anchor', href: el.href };
                    }
                    return { type: 'button', href: null };
                }
            }

            return null;
        });

        if (!instantInfo) {
            // Attempt direct extraction in case download link is already present on page
            try {
                return await extractDirectLink(page, capturedUrls);
            } catch {
                throw new Error('INSTANT DL button not found on episode page');
            }
        }

        let finalPage = page;
        let popupOpened = false;

        if (instantInfo.type === 'anchor') {
            await page.goto(instantInfo.href, { waitUntil: 'domcontentloaded', timeout: 25000 });
            await page.waitForTimeout(2000);
        } else {
            const popupPromise = page.waitForEvent('popup', { timeout: 7000 }).catch(() => null);

            await page.evaluate(() => {
                const re = /(instant\s*d(own)?l(oad)?|fast\s*cloud|hubcloud)/i;
                for (const el of document.querySelectorAll('a, button')) {
                    if (re.test((el.innerText || el.textContent || '').trim())) {
                        el.click();
                        return;
                    }
                }
            });

            const [, popup] = await Promise.all([
                page.waitForNavigation({ timeout: 10000, waitUntil: 'domcontentloaded' }).catch(() => null),
                popupPromise,
            ]);

            if (popup && !popup.isClosed()) {
                await attachRoutes(popup, capturedUrls);
                popupOpened = true;
                popup.on('popup', async (p2) => { try { await p2.close(); } catch {} });
                await popup.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
                await popup.waitForTimeout(2000);
                finalPage = popup;
            } else {
                await page.waitForTimeout(2000);
                finalPage = page;
            }
        }

        if (session.aborted) throw new Error('Aborted');

        // Extract direct link from the destination page
        const link = await extractDirectLink(finalPage, capturedUrls);

        if (popupOpened && finalPage !== page) {
            await session.closePage(finalPage);
        }

        return link;
    } finally {
        await session.closePage(page);
    }
}

/**
 * Resolves Google Drive links and virus-scan warning bypasses
 */
async function resolveGoogleDrive(driveUrl, session) {
    let targetUrl = driveUrl.trim();

    // Normalise Google Drive share URLs → usercontent download URL
    const fileIdMatch = targetUrl.match(/\/d\/([a-zA-Z0-9_-]{20,})/);
    if (fileIdMatch) {
        targetUrl = `https://drive.usercontent.google.com/download?id=${fileIdMatch[1]}&export=download`;
    }

    const openIdMatch = targetUrl.match(/[?&]id=([a-zA-Z0-9_-]{20,})/);
    if (!fileIdMatch && openIdMatch) {
        targetUrl = `https://drive.usercontent.google.com/download?id=${openIdMatch[1]}&export=download`;
    }

    if (session && session.newPage) {
        const page = await session.newPage();
        try {
            await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
            await page.waitForTimeout(1500);

            const directUrl = await page.evaluate((original) => {
                const re = /download\s*any\s*way/i;
                for (const a of document.querySelectorAll('a[href]')) {
                    const txt = (a.innerText || a.textContent || '').trim();
                    if (re.test(txt) && a.href && a.href.startsWith('http')) {
                        return a.href;
                    }
                }

                for (const form of document.querySelectorAll('form')) {
                    if (re.test(form.innerText || '')) {
                        const action = form.action;
                        const params = new URLSearchParams();
                        for (const inp of form.querySelectorAll('input')) {
                            if (inp.name) params.set(inp.name, inp.value || '');
                        }
                        if (action) return action + (params.toString() ? '?' + params.toString() : '');
                    }
                }

                const uc = document.getElementById('uc-download-link');
                if (uc && uc.href) return uc.href;

                return null;
            }, targetUrl);

            return directUrl || targetUrl;
        } finally {
            await session.closePage(page);
        }
    }

    return targetUrl;
}

/**
 * Format bytes to human readable format
 */
function formatBytes(bytes) {
    if (!bytes || isNaN(bytes) || bytes <= 0) return 'Unknown size';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

/**
 * Probes a link with lightweight HEAD/GET request
 */
async function inspectUrl(url) {
    const startTime = Date.now();
    try {
        let res = await fetch(url, {
            method: 'HEAD',
            headers: DEFAULT_HEADERS,
            redirect: 'follow',
        });

        if (!res.ok && (res.status === 403 || res.status === 405 || res.status === 501)) {
            res = await fetch(url, {
                method: 'GET',
                headers: { ...DEFAULT_HEADERS, 'Range': 'bytes=0-0' },
                redirect: 'follow',
            });
        }

        const duration = Date.now() - startTime;
        const contentLength = parseInt(res.headers.get('content-length') || '0', 10);
        const contentType = res.headers.get('content-type') || 'unknown';
        const acceptRanges = res.headers.get('accept-ranges') === 'bytes';

        return {
            status: 'online',
            statusCode: res.status,
            contentType,
            contentLength,
            formattedSize: formatBytes(contentLength),
            acceptRanges,
            durationMs: duration,
            finalUrl: res.url,
            isDirectMedia: contentType.startsWith('video/') || contentType.startsWith('audio/') || contentType.includes('octet-stream'),
        };
    } catch (err) {
        return {
            status: 'error',
            error: err.message,
            durationMs: Date.now() - startTime,
        };
    }
}

module.exports = {
    BrowserSession,
    getEpisodes,
    resolveGDFlix,
    resolveGoogleDrive,
    extractDirectLink,
    inspectUrl,
    formatBytes,
};
