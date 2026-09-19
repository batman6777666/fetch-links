'use strict';

const { BrowserSession, resolveGoogleDrive } = require('../lib/extractor');

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
        .slice(0, 30);

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
        console.error('[GDirect] Browser start failed:', err);
        send({ type: 'error', message: 'Browser engine start failed: ' + err.message });
        clearInterval(pingInterval);
        return res.end();
    }

    req.on('close', () => {
        if (session) session.destroy().catch(() => {});
    });

    const enqueue = makeQueue(3);
    const total = urls.length;
    let done = 0;

    send({ type: 'connected' });
    send({ type: 'total', count: total });

    try {
        await Promise.allSettled(urls.map((url, i) => enqueue(async () => {
            if (closed || session.aborted) {
                done++;
                send({ type: 'result', index: i, originalUrl: url, status: 'failed', error: 'Aborted', processed: done, total });
                return;
            }

            send({ type: 'progress', index: i, originalUrl: url, status: 'resolving', processed: done, total });
            try {
                const link = await resolveGoogleDrive(url, session);
                done++;
                send({ type: 'result', index: i, originalUrl: url, status: 'done', link, processed: done, total });
            } catch (err) {
                done++;
                send({ type: 'result', index: i, originalUrl: url, status: 'failed', error: err.message, processed: done, total });
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
