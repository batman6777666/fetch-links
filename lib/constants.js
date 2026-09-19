'use strict';

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

// Domains and patterns that are direct CDN / download sources
const CDN_PATTERNS = [
    'video-downloads.googleusercontent.com',
    'googlevideo.com',
    'drive.google.com/uc',
    'drive.usercontent.google.com',
    'lh3.googleusercontent.com',
    '.mp4', '.mkv', '.avi', '.mov', '.m4v', '.webm', '.zip', '.rar',
];

const DEFAULT_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1'
};

function isCdnUrl(url) {
    if (!url || typeof url !== 'string') return false;
    const lower = url.toLowerCase();
    return CDN_PATTERNS.some(p => lower.includes(p));
}

function isAdDomain(url) {
    try {
        const h = new URL(url).hostname.toLowerCase();
        return AD_DOMAINS.some(d => h === d || h.endsWith('.' + d));
    } catch {
        return false;
    }
}

module.exports = {
    AD_DOMAINS,
    CDN_PATTERNS,
    DEFAULT_HEADERS,
    isCdnUrl,
    isAdDomain,
};
