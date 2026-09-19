'use strict';

const { BrowserSession, getEpisodes, resolveGDFlix } = require('../lib/extractor');

function makeQueue(concurrency = 3) {
    let active = 0;
    const queue = [];
    const next = () => {
        while (active < concurrency && queue.length) {
            active++;
            const { fn, resolve, reject } = queue.shift();
            Promise.resolve().then(fn).then(resolve).catch(reject).finally(() => {
                active--;
                next();
            });
        }
    };
    return fn => new Promise((resolve, reject) => {
        queue.push({ fn, resolve, reject });
        next();
    });
}

module.exports = async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }

    const rawUrls = req.query.urls || (req.body && req.body.urls) || '';
    const urls = (typeof rawUrls === 'string' ? rawUrls.split(',') : (Array.isArray(rawUrls) ? rawUrls : []))
        .map(u => u.trim())
        .filter(Boolean)
        .slice(0, 10);

    if (!urls.length) {
        return res.status(400).json({ error: 'No URLs provided' });
    }

    // SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (res.flushHeaders) res.flushHeaders();

    let closed = false;
    req.on('close', () => { closed = true; });

    const send = obj => {
        if (!closed && !res.writableEnded) {
            res.write(`data: ${JSON.stringify(obj)}\n\n`);
        }
    };

    const pingInterval = setInterval(() => {
        if (!closed && !res.writableEnded) {
            res.write(':keepalive\n\n');
        }
    }, 15000);

    let session = null;
    try {
        session = new BrowserSession();
        await session.init();
    } catch (err) {
        console.error('[Fetch] Browser start failed:', err);
        send({ type: 'error', message: 'Browser engine start failed: ' + err.message });
        clearInterval(pingInterval);
        return res.end();
    }

    req.on('close', () => {
        if (session) session.destroy().catch(() => {});
    });

    const enqueue = makeQueue(3);
    let total = 0;
    let done = 0;

    try {
        send({ type: 'connected' });
        send({ type: 'status', message: 'Scanning FXLinks series pages with Chromium…' });

        const allEps = [];
        for (let i = 0; i < urls.length; i++) {
            if (closed || session.aborted) break;
            const targetUrl = urls[i];
            send({ type: 'status', message: `Scanning URL ${i + 1} of ${urls.length}…` });

            try {
                const eps = await getEpisodes(targetUrl, session);
                if (!eps.length) {
                    send({ type: 'warning', message: `No episodes found in URL ${i + 1}` });
                }
                allEps.push(...eps);
            } catch (err) {
                send({ type: 'warning', message: `URL ${i + 1} scan failed: ${err.message}` });
            }
        }

        if (!allEps.length) {
            send({ type: 'done', total: 0 });
            clearInterval(pingInterval);
            if (session) await session.destroy().catch(() => {});
            return res.end();
        }

        total = allEps.length;
        send({ type: 'episodes_found', count: total, episodes: allEps.map(e => e.text) });

        await Promise.allSettled(allEps.map(ep => enqueue(async () => {
            if (closed || session.aborted) {
                done++;
                send({ type: 'result', episode: ep.text, status: 'failed', error: 'Aborted', processed: done, total });
                return;
            }

            send({ type: 'progress', episode: ep.text, status: 'fetching', processed: done, total });
            try {
                const link = await resolveGDFlix(ep.href, session);
                done++;
                send({ type: 'result', episode: ep.text, status: 'done', link, processed: done, total });
            } catch (err) {
                done++;
                send({ type: 'result', episode: ep.text, status: 'failed', error: err.message, processed: done, total });
            }
        })));
    } catch (err) {
        send({ type: 'error', message: err.message });
    } finally {
        clearInterval(pingInterval);
        if (!closed && !res.writableEnded) {
            send({ type: 'done', total });
            res.end();
        }
        if (session) await session.destroy().catch(() => {});
    }
};
