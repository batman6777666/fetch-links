'use strict';

const { inspectUrl } = require('../lib/extractor');

module.exports = async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }

    const targetUrl = req.query.url || (req.body && req.body.url);
    if (!targetUrl || typeof targetUrl !== 'string') {
        return res.status(400).json({ error: 'Valid URL is required' });
    }

    try {
        const details = await inspectUrl(targetUrl.trim());
        return res.status(200).json(details);
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};
