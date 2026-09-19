'use strict';

const { RequestSession, getEpisodes, resolveGDFlix } = require('../lib/extractor');

// Concurrency runner helper
function makeQueue(concurrency = 4) {
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

    // Keepalive ping for Vercel proxy
    const pingInterval = setInterval(() => {
        if (!closed && !res.writableEnded) {
            res.write(':keepalive\n\n');
        }
    }, 15000);

    const session = new RequestSession();
    const enqueue = makeQueue(4);
    let total = 0;
    let done = 0;

    try {
        send({ type: 'connected' });
        send({ type: 'status', message: 'Scanning FXLinks series pages for episodes…' });

        const allEps = [];
        for (let i = 0; i < urls.length; i++) {
            if (closed) break;
            const targetUrl = urls[i];
            send({ type: 'status', message: `Scanning URL ${i + 1} of ${urls.length}…` });

            try {
                const eps = await getEpisodes(targetUrl, session);
                if (!eps.length) {
                    send({ type: 'warning', message: `No episodes detected in URL ${i + 1}` });
                }
                allEps.push(...eps);
            } catch (err) {
                send({ type: 'warning', message: `URL ${i + 1} scan failed: ${err.message}` });
            }
        }

        if (!allEps.length) {
            send({ type: 'done', total: 0 });
            clearInterval(pingInterval);
            return res.end();
        }

        total = allEps.length;
        send({ type: 'episodes_found', count: total, episodes: allEps.map(e => e.text) });

        await Promise.allSettled(allEps.map(ep => enqueue(async () => {
            if (closed) {
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
    }
};
