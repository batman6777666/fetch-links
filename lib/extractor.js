'use strict';

const cheerio = require('cheerio');
const { DEFAULT_HEADERS, isCdnUrl, isAdDomain } = require('./constants');

/**
 * Cookie Jar & Header management for tracking redirects
 */
class RequestSession {
    constructor() {
        this.cookies = new Map();
    }

    setCookiesFromHeaders(headers) {
        if (!headers) return;
        const setCookie = headers.get ? headers.get('set-cookie') : headers['set-cookie'];
        if (!setCookie) return;

        const cookieList = Array.isArray(setCookie) ? setCookie : [setCookie];
        for (const str of cookieList) {
            const parts = str.split(';');
            const [name, val] = parts[0].split('=');
            if (name && val !== undefined) {
                this.cookies.set(name.trim(), val.trim());
            }
        }
    }

    getCookieString() {
        return Array.from(this.cookies.entries())
            .map(([k, v]) => `${k}=${v}`)
            .join('; ');
    }

    async fetch(url, options = {}) {
        const timeoutMs = options.timeout || 15000;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        const headers = {
            ...DEFAULT_HEADERS,
            ...(options.headers || {})
        };

        const cookieStr = this.getCookieString();
        if (cookieStr) {
            headers['Cookie'] = cookieStr;
        }

        try {
            const res = await fetch(url, {
                method: options.method || 'GET',
                headers,
                redirect: options.redirect || 'follow',
                signal: controller.signal,
                body: options.body,
            });

            this.setCookiesFromHeaders(res.headers);
            return res;
        } finally {
            clearTimeout(timer);
        }
    }
}

/**
 * Normalizes and extracts episode links from FXLinks / Series index page
 */
async function getEpisodes(pageUrl, session = new RequestSession()) {
    const res = await session.fetch(pageUrl);
    if (!res.ok) {
        throw new Error(`Failed to fetch page: HTTP ${res.status}`);
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

        try {
            href = new URL(href, pageUrl).href;
        } catch {
            return;
        }

        if (re.test(text) && href.startsWith('http') && !seen.has(href)) {
            seen.add(href);
            results.push({ text, href });
        }
    });

    // Fallback: If no strict "^episode \d+" found, search any link mentioning episode numbers
    if (results.length === 0) {
        const looseRe = /episode\s*(\d+)/i;
        $('a[href]').each((_, el) => {
            const $el = $(el);
            const text = ($el.text() || '').replace(/\s+/g, ' ').trim();
            let href = $el.attr('href') || '';
            if (!href || href.startsWith('javascript:') || href === '#') return;
            try {
                href = new URL(href, pageUrl).href;
            } catch {
                return;
            }

            if (looseRe.test(text) && href.startsWith('http') && !seen.has(href)) {
                seen.add(href);
                results.push({ text, href });
            }
        });
    }

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
 * Cleans candidate URL
 */
function cleanUrl(href, baseUrl) {
    if (!href || typeof href !== 'string') return null;
    href = href.trim();
    if (href.startsWith('javascript:') || href === '#' || href.length < 5) return null;
    try {
        const abs = baseUrl ? new URL(href, baseUrl).href : href;
        if (!abs.startsWith('http')) return null;
        if (isAdDomain(abs)) return null;
        return abs;
    } catch {
        return null;
    }
}

/**
 * Extracts direct CDN / file download link from HTML and metadata
 */
function extractDirectLinkFromHtml(html, pageUrl) {
    const $ = cheerio.load(html);

    // 1. Direct Google Usercontent / Google Video in anchors
    const cdnCandidates = [];
    $('a[href]').each((_, el) => {
        const href = cleanUrl($(el).attr('href'), pageUrl);
        if (href && isCdnUrl(href)) {
            cdnCandidates.push(href);
        }
    });

    if (cdnCandidates.length > 0) {
        const googleDl = cdnCandidates.find(u => u.includes('video-downloads.googleusercontent'));
        if (googleDl) return googleDl;
        const gv = cdnCandidates.find(u => u.includes('googlevideo.com') || u.includes('drive.usercontent.google'));
        if (gv) return gv;
        const gd = cdnCandidates.find(u => u.includes('drive.google.com/uc'));
        if (gd) return gd;
        const videoExt = cdnCandidates.find(u => /\.(mp4|mkv|avi|mov|m4v|webm|zip|rar)/i.test(u));
        if (videoExt) return videoExt;
        return cdnCandidates[0];
    }

    // 2. Video element source
    const videoSrc = $('video').attr('src');
    if (videoSrc) {
        const c = cleanUrl(videoSrc, pageUrl);
        if (c) return c;
    }

    let sourceSrc = null;
    $('video source, source').each((_, el) => {
        if (sourceSrc) return;
        const s = cleanUrl($(el).attr('src'), pageUrl);
        if (s) sourceSrc = s;
    });
    if (sourceSrc) return sourceSrc;

    // 3. Iframe CDN host
    const cdnHosts = ['googleusercontent', 'googlevideo', 'googleapis', 'drive.google', 'mediafire', 'mega.nz', 'pixeldrain'];
    let iframeSrc = null;
    $('iframe[src]').each((_, el) => {
        if (iframeSrc) return;
        const s = cleanUrl($(el).attr('src'), pageUrl);
        if (s && cdnHosts.some(h => s.includes(h))) {
            iframeSrc = s;
        }
    });
    if (iframeSrc) return iframeSrc;

    // 4. Download buttons / anchors by text
    let downloadAnchor = null;
    $('a[href]').each((_, el) => {
        if (downloadAnchor) return;
        const $a = $(el);
        const txt = ($a.text() || '').trim();
        const href = cleanUrl($a.attr('href'), pageUrl);
        if (href && /download\s*(here|link|now|file|direct)/i.test(txt)) {
            downloadAnchor = href;
        }
    });
    if (downloadAnchor) return downloadAnchor;

    // 5. Data attributes
    let dataUrl = null;
    $('[data-url],[data-href],[data-src],[data-link],[data-download]').each((_, el) => {
        if (dataUrl) return;
        const $el = $(el);
        const u = $el.attr('data-url') || $el.attr('data-href') || $el.attr('data-src') || $el.attr('data-link') || $el.attr('data-download');
        const c = cleanUrl(u, pageUrl);
        if (c) dataUrl = c;
    });
    if (dataUrl) return dataUrl;

    // 6. Direct file extension in anchors
    let extMatch = null;
    $('a[href]').each((_, el) => {
        if (extMatch) return;
        const href = cleanUrl($(el).attr('href'), pageUrl);
        if (href && /\.(mp4|mkv|avi|mov|m4v|webm|zip|rar)(\?|$)/i.test(href)) {
            extMatch = href;
        }
    });
    if (extMatch) return extMatch;

    // 7. Embedded script tags containing download URLs
    let scriptMatch = null;
    $('script').each((_, el) => {
        if (scriptMatch) return;
        const content = $(el).html() || '';
        const match = content.match(/https?:\/\/[^\s"'<>]+\.(?:mp4|mkv|zip|rar)[^\s"'<>]*/i)
            || content.match(/https?:\/\/(?:video-downloads\.googleusercontent|drive\.usercontent\.google)[^\s"'<>]*/i)
            || content.match(/(?:var|let|const)\s+(?:download_url|downloadUrl|directUrl|videoUrl)\s*=\s*['"](https?:\/\/[^'"]+)['"]/i);
        if (match) {
            const found = match[1] || match[0];
            const c = cleanUrl(found, pageUrl);
            if (c) scriptMatch = c;
        }
    });
    if (scriptMatch) return scriptMatch;

    return null;
}

/**
 * Resolves GDFlix / HubCloud / FastDL page and extracts direct download link
 */
async function resolveGDFlix(episodeHref, session = new RequestSession()) {
    const res = await session.fetch(episodeHref);
    if (!res.ok) {
        throw new Error(`Failed to fetch episode page: HTTP ${res.status}`);
    }

    const finalUrl = res.url;

    // Check if the initial response was already redirected to a direct CDN or file URL
    if (isCdnUrl(finalUrl)) {
        return finalUrl;
    }

    const html = await res.text();
    const $ = cheerio.load(html);

    // Look for INSTANT DL anchor or button
    const re = /instant\s*d(own)?l(oad)?/i;
    let instantHref = null;

    $('a[href], button').each((_, el) => {
        if (instantHref) return;
        const $el = $(el);
        const txt = ($el.text() || '').trim();
        if (re.test(txt)) {
            const href = $el.attr('href') || $el.attr('data-href') || $el.attr('data-url');
            if (href && !href.endsWith('#') && href !== finalUrl) {
                instantHref = cleanUrl(href, finalUrl);
            }
        }
    });

    // Fallback: look for "Fast Cloud" or "Direct Cloud" or "HubCloud" buttons
    if (!instantHref) {
        const cloudRe = /(fast\s*cloud|direct\s*cloud|hubcloud|direct\s*dl)/i;
        $('a[href]').each((_, el) => {
            if (instantHref) return;
            const $el = $(el);
            const txt = ($el.text() || '').trim();
            if (cloudRe.test(txt)) {
                const href = cleanUrl($el.attr('href'), finalUrl);
                if (href) instantHref = href;
            }
        });
    }

    let targetHtml = html;
    let targetUrl = finalUrl;

    if (instantHref) {
        // Navigate through the INSTANT DL link
        const targetRes = await session.fetch(instantHref);
        targetUrl = targetRes.url;
        if (isCdnUrl(targetUrl)) {
            return targetUrl;
        }
        targetHtml = await targetRes.text();
    }

    // Check if target page is a Google Drive page
    if (targetUrl.includes('drive.google.com') || targetUrl.includes('drive.usercontent.google')) {
        return await resolveGoogleDrive(targetUrl, session);
    }

    const directLink = extractDirectLinkFromHtml(targetHtml, targetUrl);
    if (directLink) {
        if (directLink.includes('drive.google.com') || directLink.includes('drive.usercontent.google')) {
            return await resolveGoogleDrive(directLink, session);
        }
        return directLink;
    }

    // If nothing found and instantHref was valid, return instantHref
    if (instantHref) return instantHref;

    throw new Error('No direct download link found on page');
}

/**
 * Resolves Google Drive links and virus-scan warning bypasses
 */
async function resolveGoogleDrive(driveUrl, session = new RequestSession()) {
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

    const res = await session.fetch(targetUrl);
    const finalUrl = res.url;

    // If redirected to CDN URL directly
    if (finalUrl !== targetUrl && (isCdnUrl(finalUrl) || finalUrl.includes('confirm='))) {
        return finalUrl;
    }

    const html = await res.text();
    const $ = cheerio.load(html);

    // Look for "Download anyway" link
    let directLink = null;
    const re = /download\s*any\s*way/i;

    $('a[href]').each((_, el) => {
        if (directLink) return;
        const $el = $(el);
        const txt = ($el.text() || '').trim();
        if (re.test(txt)) {
            const href = cleanUrl($el.attr('href'), targetUrl);
            if (href) directLink = href;
        }
    });

    if (directLink) return directLink;

    // Look for form with "Download anyway"
    $('form').each((_, el) => {
        if (directLink) return;
        const $form = $(el);
        const txt = ($form.text() || '').trim();
        if (re.test(txt)) {
            const action = cleanUrl($form.attr('action') || targetUrl, targetUrl);
            if (action) {
                const params = new URLSearchParams();
                $form.find('input').each((_, inp) => {
                    const name = $(inp).attr('name');
                    const val = $(inp).attr('value') || '';
                    if (name) params.set(name, val);
                });
                const qs = params.toString();
                directLink = qs ? `${action}?${qs}` : action;
            }
        }
    });

    if (directLink) return directLink;

    // Look for uc-download-link id
    const ucLink = $('#uc-download-link').attr('href');
    if (ucLink) {
        const c = cleanUrl(ucLink, targetUrl);
        if (c) return c;
    }

    // Default: targetUrl
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
    const session = new RequestSession();
    const startTime = Date.now();

    try {
        let res = await session.fetch(url, {
            method: 'HEAD',
            timeout: 8000,
        });

        // Some CDNs reject HEAD requests with 403 or 405; fallback to GET with Range 0-0
        if (!res.ok && (res.status === 403 || res.status === 405 || res.status === 501)) {
            res = await session.fetch(url, {
                method: 'GET',
                headers: { 'Range': 'bytes=0-0' },
                timeout: 8000,
            });
        }

        const duration = Date.now() - startTime;
        const contentLength = parseInt(res.headers.get('content-length') || '0', 10);
        const contentType = res.headers.get('content-type') || 'unknown';
        const acceptRanges = res.headers.get('accept-ranges') === 'bytes';
        const finalUrl = res.url;

        return {
            status: 'online',
            statusCode: res.status,
            contentType,
            contentLength,
            formattedSize: formatBytes(contentLength),
            acceptRanges,
            durationMs: duration,
            finalUrl,
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
    RequestSession,
    getEpisodes,
    resolveGDFlix,
    resolveGoogleDrive,
    extractDirectLinkFromHtml,
    inspectUrl,
    formatBytes,
};
