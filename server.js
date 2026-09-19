'use strict';

const express = require('express');
const cors = require('cors');
const path = require('path');
const { execSync } = require('child_process');

const fetchHandler = require('./api/fetch');
const gdirectHandler = require('./api/gdirect');
const inspectHandler = require('./api/inspect');
const healthHandler = require('./api/health');
const clearHandler = require('./api/clear');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend files from /public and root
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname)));

// Wire API routes to serverless handlers for 100% environment parity
app.all('/api/fetch', (req, res) => fetchHandler(req, res));
app.all('/api/gdirect', (req, res) => gdirectHandler(req, res));
app.all('/api/inspect', (req, res) => inspectHandler(req, res));
app.all('/api/health', (req, res) => healthHandler(req, res));
app.all('/api/clear', (req, res) => clearHandler(req, res));

// Fallback for SPA routing
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Helper to kill any process hogging the port on Windows/Linux
async function freePort(port) {
    try {
        if (process.platform === 'win32') {
            const out = execSync(
                `netstat -ano | findstr :${port} | findstr LISTENING`,
                { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
            );
            const pid = out.trim().split(/\s+/).pop();
            if (pid && !isNaN(pid)) {
                execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
                console.log(`[Port] Freed port ${port} (killed PID ${pid})`);
                await new Promise(r => setTimeout(r, 600));
            }
        }
    } catch {
        // Port was already free
    }
}

async function start() {
    await freePort(PORT);
    const server = app.listen(PORT, () => {
        console.log(`\n======================================================`);
        console.log(`  ⚡ FETCH LINKS v2.0 (Vercel-Optimized Serverless Engine)`);
        console.log(`  🔗 Running at: http://localhost:${PORT}`);
        console.log(`======================================================\n`);
    });

    server.on('error', async (err) => {
        if (err.code === 'EADDRINUSE') {
            console.log(`[Port] ${PORT} in use, retrying after free...`);
            await freePort(PORT);
            setTimeout(() => server.listen(PORT), 1000);
        } else {
            console.error(err);
            process.exit(1);
        }
    });
}

if (require.main === module) {
    start().catch(err => {
        console.error('Fatal startup error:', err);
        process.exit(1);
    });
}

module.exports = app;
