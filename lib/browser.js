'use strict';

const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { isCdnUrl, isAdDomain } = require('./constants');

let browserInstance = null;

async function getBrowser() {
    if (browserInstance && browserInstance.isConnected()) {
        return browserInstance;
    }

    const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);

    // 1. Remote browser WebSocket if provided (e.g. Browserless.io)
    if (process.env.BROWSER_WS_ENDPOINT) {
        try {
            console.log('[Browser] Connecting to BROWSER_WS_ENDPOINT…');
            const { chromium: playwrightCore } = require('playwright-core');
            browserInstance = await playwrightCore.connect(process.env.BROWSER_WS_ENDPOINT);
            browserInstance.on('disconnected', () => { browserInstance = null; });
            return browserInstance;
        } catch (err) {
            console.error('[Browser] Remote browser connection error:', err.message);
        }
    }

    // 2. Vercel Serverless / AWS Lambda environment
    if (isServerless) {
        try {
            console.log('[Browser] Initializing @sparticuz/chromium on Vercel via dynamic import…');
            // Use dynamic import() since @sparticuz/chromium is a pure ES Module
            const chromiumModule = await import('@sparticuz/chromium');
            const chromium = chromiumModule.default || chromiumModule;
            const { chromium: playwrightCore } = require('playwright-core');

            chromium.setGraphicsMode = false;
            const executablePath = await chromium.executablePath();
            console.log('[Browser] Resolved executablePath on Vercel:', executablePath);

            if (executablePath) {
                process.env.LD_LIBRARY_PATH = `${path.dirname(executablePath)}:${process.env.LD_LIBRARY_PATH || ''}`;
            }

            browserInstance = await playwrightCore.launch({
                args: [
                    ...chromium.args,
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    '--no-first-run',
                    '--no-zygote',
                    '--single-process',
                ],
                defaultViewport: chromium.defaultViewport,
                executablePath: executablePath,
                headless: chromium.headless,
            });

            console.log('[Browser] @sparticuz/chromium successfully launched on Vercel');
            browserInstance.on('disconnected', () => { browserInstance = null; });
            return browserInstance;
        } catch (err) {
            console.error('[Browser] Vercel @sparticuz/chromium launch error:', err);
            throw new Error(`Serverless Chromium failed: ${err.message}`);
        }
    }

    // 3. Local / VPS environment: use local playwright
    try {
        console.log('[Browser] Initializing local Playwright Chromium…');
        const { chromium } = require('playwright');
        browserInstance = await chromium.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--disable-background-networking',
                '--no-first-run',
            ],
        });
        console.log('[Browser] Local Playwright Chromium launched');
        browserInstance.on('disconnected', () => { browserInstance = null; });
        return browserInstance;
    } catch (err) {
        console.error('[Browser] Local Playwright launch error:', err.message);
        throw err;
    }
}

// Attach route interceptor to block ads/heavy assets and capture CDN URLs
async function attachRoutes(page, capturedUrls = []) {
    await page.route('**/*', async (route) => {
        if (page.isClosed()) {
            try { await route.abort().catch(() => {}); } catch {}
            return;
        }

        try {
            const req = route.request();
            const url = req.url();
            const rt = req.resourceType();

            // Intercept CDN/Video URLs and abort downloading the heavy payload
            if (isCdnUrl(url)) {
                if (capturedUrls && !capturedUrls.includes(url)) {
                    capturedUrls.push(url);
                    console.log('[Route] Captured direct CDN link:', url.substring(0, 90));
                }
                await route.abort('blockedbyclient').catch(() => {});
                return;
            }

            // Block heavy & useless resources (images, fonts, stylesheets, media)
            if (['image', 'font', 'media', 'stylesheet'].includes(rt)) {
                await route.abort('blockedbyclient').catch(() => {});
                return;
            }

            // Block ad network domains
            if (isAdDomain(url)) {
                await route.abort('blockedbyclient').catch(() => {});
                return;
            }

            await route.continue().catch(() => {});
        } catch {
            // Safe ignore if page closed mid-request
        }
    });
}

async function createPage(context, capturedUrls = []) {
    const page = await context.newPage();
    page.on('popup', async (p) => {
        try { await p.close(); } catch {}
    });
    await attachRoutes(page, capturedUrls);
    page.setDefaultTimeout(25000);
    page.setDefaultNavigationTimeout(25000);
    return page;
}

async function closePage(page) {
    if (!page || page.isClosed()) return;
    try { await page.close(); } catch {}
}

class BrowserSession {
    constructor() {
        this.id = uuidv4();
        this.context = null;
        this.pages = new Set();
        this.aborted = false;
    }

    async init() {
        const b = await getBrowser();
        this.context = await b.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            viewport: { width: 1280, height: 800 },
            javaScriptEnabled: true,
        });
        return this;
    }

    async newPage(capturedUrls = []) {
        if (!this.context) await this.init();
        const page = await createPage(this.context, capturedUrls);
        this.pages.add(page);
        return page;
    }

    async closePage(page) {
        if (!page) return;
        this.pages.delete(page);
        await closePage(page);
    }

    async destroy() {
        this.aborted = true;
        for (const p of this.pages) {
            await closePage(p);
        }
        this.pages.clear();
        if (this.context) {
            try { await this.context.close(); } catch {}
            this.context = null;
        }
    }
}

module.exports = {
    getBrowser,
    BrowserSession,
    attachRoutes,
    createPage,
    closePage,
};
