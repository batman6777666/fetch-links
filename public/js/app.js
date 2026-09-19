/**
 * FETCH LINKS 2.0 — FRONTEND APPLICATION CONTROLLER
 * Ultra-Fast Serverless Link Extraction & Stream Suite
 */

'use strict';

// ─── STATE & CONFIGURATION ────────────────────────────────────────────────
const state = {
    activeTab: 'series',
    apiBase: window.location.origin,
    isProcessing: false,
    eventSource: null,
    links: [],
    itemsMap: new Map(),
    totalCount: 0,
    doneCount: 0,
    soundEnabled: true,
};

// Auto-load custom API base if saved
const savedApi = localStorage.getItem('fetch_links_custom_api');
if (savedApi) state.apiBase = savedApi;

const savedSound = localStorage.getItem('fetch_links_sound');
if (savedSound !== null) state.soundEnabled = savedSound === 'true';

// ─── SYNTHESIZED SOUND EFFECTS (Web Audio API) ───────────────────────────
let audioCtx = null;
function playTone(type) {
    if (!state.soundEnabled) return;
    try {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') audioCtx.resume();

        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain);
        gain.connect(audioCtx.destination);

        const now = audioCtx.currentTime;
        if (type === 'click') {
            osc.frequency.setValueAtTime(600, now);
            osc.frequency.exponentialRampToValueAtTime(800, now + 0.05);
            gain.gain.setValueAtTime(0.04, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
            osc.start(now);
            osc.stop(now + 0.05);
        } else if (type === 'done') {
            osc.frequency.setValueAtTime(523.25, now); // C5
            osc.frequency.setValueAtTime(659.25, now + 0.08); // E5
            osc.frequency.setValueAtTime(783.99, now + 0.16); // G5
            gain.gain.setValueAtTime(0.05, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
            osc.start(now);
            osc.stop(now + 0.3);
        } else if (type === 'error') {
            osc.frequency.setValueAtTime(250, now);
            osc.frequency.linearRampToValueAtTime(150, now + 0.15);
            gain.gain.setValueAtTime(0.05, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
            osc.start(now);
            osc.stop(now + 0.15);
        }
    } catch {
        // AudioContext not allowed before gesture or unsupported
    }
}

// ─── TOAST SYSTEM ────────────────────────────────────────────────────────
function showToast(msg, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = msg;

    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(10px)';
        toast.style.transition = 'all 0.25s ease';
        setTimeout(() => toast.remove(), 250);
    }, 2800);
}

// ─── TAB SWITCHING ────────────────────────────────────────────────────────
function setupTabs() {
    const tabButtons = document.querySelectorAll('.tab-btn');
    tabButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const target = btn.dataset.tab;
            if (state.isProcessing) {
                showToast('Please wait or stop current task before switching', 'info');
                return;
            }
            playTone('click');
            tabButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            document.querySelectorAll('.tab-content').forEach(pane => {
                pane.classList.remove('active');
            });

            const activePane = document.getElementById(`tab-${target}`);
            if (activePane) activePane.classList.add('active');
            state.activeTab = target;
        });
    });
}

// ─── SERIES FETCHER (FXLinks) ─────────────────────────────────────────────
function startSeriesFetch() {
    if (state.isProcessing) return;

    const input = document.getElementById('seriesInput');
    const urls = input.value.trim().split('\n').map(u => u.trim()).filter(Boolean).slice(0, 10);

    if (!urls.length) {
        showToast('Please enter at least one FXLinks series URL', 'error');
        return;
    }

    playTone('click');
    resetResults();
    state.isProcessing = true;

    setButtonState('seriesBtn', true, 'Fetching Series…');
    showStatusTracker(true);
    setStatusText('Connecting to extraction engine…');

    const apiUrl = `${state.apiBase}/api/fetch?urls=${encodeURIComponent(urls.join(','))}`;
    connectEventSource(apiUrl, 'series');
}

// ─── CLOUD DIRECT RESOLVER (Google Drive) ─────────────────────────────────
function startCloudDirect() {
    if (state.isProcessing) return;

    const input = document.getElementById('cloudInput');
    const urls = input.value.trim().split('\n').map(u => u.trim()).filter(Boolean).slice(0, 30);

    if (!urls.length) {
        showToast('Please enter at least one Google Drive or Cloud URL', 'error');
        return;
    }

    playTone('click');
    resetResults();
    state.isProcessing = true;

    setButtonState('cloudBtn', true, 'Resolving Links…');
    showStatusTracker(true);
    setStatusText('Connecting to Google Drive bypass engine…');

    const apiUrl = `${state.apiBase}/api/gdirect?urls=${encodeURIComponent(urls.join(','))}`;
    connectEventSource(apiUrl, 'cloud');
}

// ─── SSE CONNECTION HANDLER ───────────────────────────────────────────────
function connectEventSource(url, mode) {
    if (state.eventSource) {
        state.eventSource.close();
        state.eventSource = null;
    }

    state.eventSource = new EventSource(url);

    state.eventSource.onopen = () => {
        setStatusText('Connected — Analyzing pages…');
    };

    state.eventSource.onmessage = e => {
        try {
            const data = JSON.parse(e.data);
            handleSseEvent(data, mode);
        } catch {
            // Heartbeat or raw ping
        }
    };

    state.eventSource.onerror = () => {
        if (state.eventSource.readyState === EventSource.CLOSED) {
            if (state.isProcessing) {
                setStatusText('Extraction session finished');
                stopProcessing();
            }
        }
    };
}

function handleSseEvent(d, mode) {
    if (d.type === 'connected') {
        setStatusText('Connected — Scanning links…');
        return;
    }

    if (d.type === 'status') {
        setStatusText(d.message);
    }

    if (d.type === 'warning') {
        showToast(d.message, 'info');
    }

    if (d.type === 'total') {
        state.totalCount = d.count;
        updateProgress(0, state.totalCount);
        setStatusCounter(0, state.totalCount);
    }

    if (d.type === 'episodes_found') {
        state.totalCount = d.count;
        setStatusText(`Found ${d.count} episode(s). Resolving direct links…`);
        updateProgress(0, d.count);
        setStatusCounter(0, d.count);

        d.episodes.forEach((title, idx) => {
            addItemCard(title, 'waiting', null, null, idx);
        });
    }

    if (d.type === 'progress') {
        const id = d.episode || `item-${d.index}`;
        const label = d.episode || `Link #${d.index + 1}`;
        updateItemCard(id, 'fetching', null, null, label);
    }

    if (d.type === 'result') {
        const id = d.episode || `item-${d.index}`;
        const label = d.episode || `Link #${d.index + 1}`;
        state.doneCount = d.processed;
        updateProgress(d.processed, d.total);
        setStatusCounter(d.processed, d.total);

        if (d.status === 'done') {
            updateItemCard(id, 'done', d.link, null, label);
            state.links.push({ label, url: d.link });
            playTone('click');
        } else {
            updateItemCard(id, 'failed', null, d.error || 'Failed to extract', label);
        }

        updateResultsHeader();
    }

    if (d.type === 'done') {
        playTone('done');
        setStatusText(`Complete! Extracted ${state.links.length} direct link(s).`);
        updateProgress(state.totalCount, state.totalCount);
        showToast(`Extraction complete (${state.links.length} links)`, 'success');
        saveToHistory(mode, state.links.length);
        stopProcessing();
    }

    if (d.type === 'error') {
        playTone('error');
        setStatusText(`Error: ${d.message}`);
        showToast(d.message, 'error');
        stopProcessing();
    }
}

function stopProcessing() {
    state.isProcessing = false;
    setButtonState('seriesBtn', false, 'Start Fetching Series');
    setButtonState('cloudBtn', false, 'Resolve Direct Links');
    if (state.eventSource) {
        state.eventSource.close();
        state.eventSource = null;
    }
}

// ─── UI RENDERING & CARDS ────────────────────────────────────────────────
function addItemCard(id, status, link, error, index = 0) {
    const list = document.getElementById('resultsList');
    document.getElementById('resultsContainer').style.display = 'flex';

    if (state.itemsMap.has(id)) {
        updateItemCard(id, status, link, error);
        return;
    }

    const card = document.createElement('div');
    card.className = `item-card ${status}`;
    card.id = `card-${encodeURIComponent(id)}`;

    // Badge
    const badge = document.createElement('span');
    badge.className = 'card-badge';
    badge.textContent = id;

    // Body
    const body = document.createElement('div');
    body.className = 'card-body';

    // Status pill
    const pill = document.createElement('span');
    pill.className = `status-pill ${status}`;
    pill.textContent = formatStatus(status);

    // Actions
    const actions = document.createElement('div');
    actions.className = 'card-actions';

    card.append(badge, body, pill, actions);
    list.appendChild(card);

    state.itemsMap.set(id, { card, body, pill, actions });
    updateCardContents(state.itemsMap.get(id), status, link, error);
}

function updateItemCard(id, status, link, error, fallbackLabel = '') {
    let item = state.itemsMap.get(id);
    if (!item) {
        addItemCard(id || fallbackLabel, status, link, error);
        item = state.itemsMap.get(id);
    }
    updateCardContents(item, status, link, error);
}

function updateCardContents(item, status, link, error) {
    const { card, body, pill, actions } = item;
    card.className = `item-card ${status}`;
    pill.className = `status-pill ${status}`;
    pill.textContent = formatStatus(status);

    body.innerHTML = '';
    actions.innerHTML = '';

    if (link) {
        const a = document.createElement('a');
        a.className = 'card-link';
        a.href = link;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.title = link;
        a.textContent = link;
        body.appendChild(a);

        // Copy Button
        const copyBtn = createActionButton('copy', 'Copy link', () => copyToClipboard(link, copyBtn));
        // Stream Preview Button
        const playBtn = createActionButton('play', 'Stream / Watch', () => openPlayerModal(link));
        // Test / Probe Button
        const probeBtn = createActionButton('info', 'Inspect headers & size', () => quickInspect(link));

        actions.append(copyBtn, playBtn, probeBtn);
    } else if (error) {
        const errSpan = document.createElement('span');
        errSpan.className = 'card-error';
        errSpan.textContent = error;
        body.appendChild(errSpan);
    } else {
        const ph = document.createElement('span');
        ph.className = 'card-placeholder';
        ph.textContent = status === 'fetching' ? 'Extracting direct link…' : 'Queued in processing pool…';
        body.appendChild(ph);
    }
}

function createActionButton(iconType, title, onClick) {
    const btn = document.createElement('button');
    btn.className = 'action-btn';
    btn.title = title;
    btn.onclick = onClick;

    let svg = '';
    if (iconType === 'copy') {
        svg = `<svg viewBox="0 0 24 24"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`;
    } else if (iconType === 'play') {
        svg = `<svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>`;
    } else if (iconType === 'info') {
        svg = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>`;
    }

    btn.innerHTML = svg;
    return btn;
}

function formatStatus(s) {
    switch (s) {
        case 'done': return '✓ Ready';
        case 'failed': return '✕ Failed';
        case 'fetching': return '⚡ Extracting';
        case 'waiting': return '⏳ Queued';
        default: return s;
    }
}

function copyToClipboard(text, btn) {
    navigator.clipboard.writeText(text).then(() => {
        playTone('click');
        showToast('Link copied to clipboard!', 'success');
        if (btn) {
            btn.classList.add('copied');
            setTimeout(() => btn.classList.remove('copied'), 1800);
        }
    }).catch(() => {
        showToast('Clipboard access denied', 'error');
    });
}

// ─── STATUS & PROGRESS ────────────────────────────────────────────────────
function showStatusTracker(show) {
    const el = document.getElementById('statusTracker');
    if (show) el.classList.add('visible');
    else el.classList.remove('visible');
}

function setStatusText(msg) {
    document.getElementById('statusMessageText').textContent = msg;
}

function setStatusCounter(done, total) {
    document.getElementById('statusCounter').textContent = `${done} / ${total}`;
}

function updateProgress(done, total) {
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    document.getElementById('progressBar').style.width = `${pct}%`;
}

function setButtonState(btnId, disabled, text) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.disabled = disabled;
    if (disabled) btn.classList.add('loading');
    else btn.classList.remove('loading');
    const span = btn.querySelector('.btn-label');
    if (span) span.textContent = text;
}

function updateResultsHeader() {
    const badge = document.getElementById('resultsCount');
    badge.textContent = `${state.links.length} link${state.links.length !== 1 ? 's' : ''}`;
}

function resetResults() {
    state.links = [];
    state.itemsMap.clear();
    state.totalCount = 0;
    state.doneCount = 0;
    document.getElementById('resultsList').innerHTML = '';
    document.getElementById('resultsContainer').style.display = 'none';
    updateProgress(0, 1);
    updateResultsHeader();
}

function clearAll() {
    stopProcessing();
    resetResults();
    showStatusTracker(false);
    document.getElementById('seriesInput').value = '';
    document.getElementById('cloudInput').value = '';
    fetch(`${state.apiBase}/api/clear`, { method: 'POST' }).catch(() => {});
    showToast('Cleared workspace', 'info');
}

// ─── EXPORT SUITE ─────────────────────────────────────────────────────────
function copyAllLinks() {
    if (!state.links.length) {
        showToast('No links available to copy', 'error');
        return;
    }
    const txt = state.links.map(l => l.url).join('\n');
    copyToClipboard(txt);
}

function exportAsTxt() {
    if (!state.links.length) return;
    const content = state.links.map(l => `${l.label}: ${l.url}`).join('\n');
    downloadFile(content, 'fetch-links-export.txt', 'text/plain');
}

function exportAsJson() {
    if (!state.links.length) return;
    const content = JSON.stringify({
        exportedAt: new Date().toISOString(),
        total: state.links.length,
        items: state.links
    }, null, 2);
    downloadFile(content, 'fetch-links-export.json', 'application/json');
}

function exportAsM3U() {
    if (!state.links.length) return;
    let m3u = '#EXTM3U\n';
    state.links.forEach(item => {
        m3u += `#EXTINF:-1,${item.label}\n${item.url}\n`;
    });
    downloadFile(m3u, 'playlist.m3u', 'audio/x-mpegurl');
    showToast('M3U playlist exported for VLC / PotPlayer!', 'success');
}

function exportAsAria2() {
    if (!state.links.length) return;
    const commands = state.links.map(l => `aria2c -c -x 16 -s 16 "${l.url}"`).join('\n');
    copyToClipboard(commands);
    showToast('Copied batch Aria2 download commands to clipboard!', 'success');
}

function downloadFile(content, filename, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// ─── LINK FILTER ──────────────────────────────────────────────────────────
function filterResults(query) {
    const q = query.toLowerCase().trim();
    state.itemsMap.forEach((item, id) => {
        const text = `${id} ${item.card.querySelector('.card-link')?.textContent || ''}`.toLowerCase();
        if (!q || text.includes(q)) {
            item.card.style.display = 'grid';
        } else {
            item.card.style.display = 'none';
        }
    });
}

// ─── STREAM STUDIO (In-Browser Player) ────────────────────────────────────
function openPlayerModal(url) {
    const modal = document.getElementById('playerModal');
    const player = document.getElementById('studioVideoPlayer');
    const urlDisplay = document.getElementById('playerStreamUrl');

    urlDisplay.textContent = url;
    player.src = url;
    modal.classList.add('open');
    player.play().catch(() => {});
}

function closePlayerModal() {
    const modal = document.getElementById('playerModal');
    const player = document.getElementById('studioVideoPlayer');
    player.pause();
    player.src = '';
    modal.classList.remove('open');
}

// ─── LINK INSPECTOR & VALIDATOR ───────────────────────────────────────────
async function runInspector() {
    const input = document.getElementById('inspectInput');
    const url = input.value.trim();
    if (!url) {
        showToast('Please enter a valid URL to inspect', 'error');
        return;
    }

    const box = document.getElementById('inspectResultBox');
    box.style.display = 'none';
    setButtonState('inspectBtn', true, 'Inspecting Headers…');

    try {
        const res = await fetch(`${state.apiBase}/api/inspect?url=${encodeURIComponent(url)}`);
        const data = await res.json();

        box.style.display = 'flex';
        document.getElementById('statStatus').textContent = `${data.statusCode || data.status}`;
        document.getElementById('statSize').textContent = data.formattedSize || 'Unknown';
        document.getElementById('statType').textContent = data.contentType || 'N/A';
        document.getElementById('statLatency').textContent = `${data.durationMs} ms`;
        document.getElementById('statResume').textContent = data.acceptRanges ? '✓ Resumable' : 'No';

        if (data.isDirectMedia) {
            document.getElementById('inspectStreamBtn').style.display = 'inline-flex';
            document.getElementById('inspectStreamBtn').onclick = () => openPlayerModal(url);
        } else {
            document.getElementById('inspectStreamBtn').style.display = 'none';
        }

        showToast('URL inspection complete', 'success');
    } catch (err) {
        showToast(`Inspection failed: ${err.message}`, 'error');
    } finally {
        setButtonState('inspectBtn', false, 'Inspect Link');
    }
}

function quickInspect(url) {
    const tabs = document.querySelectorAll('.tab-btn');
    tabs.forEach(t => t.classList.remove('active'));
    document.querySelector('[data-tab="inspect"]')?.classList.add('active');

    document.querySelectorAll('.tab-content').forEach(p => p.classList.remove('active'));
    document.getElementById('tab-inspect')?.classList.add('active');

    document.getElementById('inspectInput').value = url;
    runInspector();
}

// ─── HISTORY DRAWER ───────────────────────────────────────────────────────
function saveToHistory(mode, count) {
    try {
        const history = JSON.parse(localStorage.getItem('fetch_links_history') || '[]');
        history.unshift({
            date: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            fullDate: new Date().toLocaleDateString(),
            mode: mode === 'series' ? 'Series Extractor' : 'Cloud Direct',
            count,
            links: state.links.slice(0, 100)
        });
        localStorage.setItem('fetch_links_history', JSON.stringify(history.slice(0, 15)));
    } catch {}
}

function openHistory() {
    renderHistory();
    document.getElementById('historyDrawer').classList.add('open');
    document.getElementById('drawerBackdrop').classList.add('open');
}

function closeHistory() {
    document.getElementById('historyDrawer').classList.remove('open');
    document.getElementById('drawerBackdrop').classList.remove('open');
}

function renderHistory() {
    const list = document.getElementById('historyList');
    list.innerHTML = '';
    const items = JSON.parse(localStorage.getItem('fetch_links_history') || '[]');

    if (!items.length) {
        list.innerHTML = '<div style="color:var(--text-dim); text-align:center; padding:2rem 0; font-size:0.8rem;">No recent sessions found</div>';
        return;
    }

    items.forEach(h => {
        const card = document.createElement('div');
        card.className = 'history-card';
        card.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <span style="font-weight:700; font-size:0.8rem; color:var(--primary-light);">${h.mode}</span>
                <span style="font-size:0.7rem; color:var(--text-dim);">${h.date}</span>
            </div>
            <div style="font-size:0.75rem; color:var(--text-muted);">${h.count} link(s) extracted</div>
        `;
        card.onclick = () => {
            resetResults();
            h.links.forEach((l, idx) => {
                addItemCard(l.label, 'done', l.url, null, idx);
                state.links.push(l);
            });
            updateResultsHeader();
            closeHistory();
            showToast(`Restored ${h.links.length} links from session`, 'success');
        };
        list.appendChild(card);
    });
}

// ─── SETTINGS MODAL ───────────────────────────────────────────────────────
function openSettings() {
    document.getElementById('settingsModal').classList.add('open');
    document.getElementById('customApiInput').value = localStorage.getItem('fetch_links_custom_api') || '';
    document.getElementById('soundToggle').checked = state.soundEnabled;
}

function closeSettings() {
    document.getElementById('settingsModal').classList.remove('open');
}

function saveSettings() {
    const custom = document.getElementById('customApiInput').value.trim();
    if (custom) {
        localStorage.setItem('fetch_links_custom_api', custom);
        state.apiBase = custom;
    } else {
        localStorage.removeItem('fetch_links_custom_api');
        state.apiBase = window.location.origin;
    }

    const sound = document.getElementById('soundToggle').checked;
    state.soundEnabled = sound;
    localStorage.setItem('fetch_links_sound', String(sound));

    closeSettings();
    showToast('Settings saved successfully', 'success');
}

// ─── INITIALIZATION ───────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    setupTabs();

    // Export dropdown toggle
    const exportBtn = document.getElementById('exportMenuBtn');
    const dropdown = document.getElementById('exportDropdown');
    exportBtn?.addEventListener('click', e => {
        e.stopPropagation();
        dropdown.classList.toggle('show');
    });

    document.addEventListener('click', () => {
        dropdown?.classList.remove('show');
    });

    // Filter input
    document.getElementById('filterInput')?.addEventListener('input', e => {
        filterResults(e.target.value);
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', e => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            if (state.activeTab === 'series') startSeriesFetch();
            else if (state.activeTab === 'cloud') startCloudDirect();
            else if (state.activeTab === 'inspect') runInspector();
        } else if (e.key === 'Escape') {
            closePlayerModal();
            closeHistory();
            closeSettings();
        }
    });
});
