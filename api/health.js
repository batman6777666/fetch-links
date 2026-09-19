'use strict';

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'OPTIONS') {
        return res.status(204).end();
    }

    res.status(200).json({
        status: 'ok',
        engine: 'serverless-cheerio-v2',
        platform: process.env.VERCEL ? 'vercel-serverless' : 'node-runtime',
        nodeVersion: process.version,
        uptime: process.uptime(),
        timestamp: new Date().toISOString()
    });
};
