/**
 * FETCH LINKS — SERIES EXTRACTOR CONTROLLER
 * Dedicated automated direct download link extractor for series
 */

'use strict';

// ─── STATE ────────────────────────────────────────────────────────────────
const state = {
    apiBase: window.location.origin,
    isProcessing: false,
    eventSource: null,
    links: [],
    itemsMap: new Map(),
    totalCount: 0,
    doneCount: 0,
    soundEnabled: true,
};

// Restore settings from localStorage
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
        // Safe ignore
    }
}

// ─── TOAST NOTIFICATIONS ─────────────────────────────────────────────────
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

// ─── SERIES FETCHER ───────────────────────────────────────────────────────
function startSeriesFetch() {
    if (state.isProcessing) return;

    const input = document.getElementById('seriesInput');
    const urls = input.value.trim().split('\n').map(u => u.trim()).filter(Boolean).slice(0, 10);

    if (!urls.length) {
        showToast('Paste at least one FXLinks URL', 'error');
        return;
    }

    playTone('click');
    resetResults();
    state.isProcessing = true;

    setButtonState(true, 'Fetching…');
    showStatusTracker(true);
    setStatusText('Connecting to engine…');

    const apiUrl = `${state.apiBase}/api/fetch?urls=${encodeURIComponent(urls.join(','))}`;
    connectEventSource(apiUrl);
}

function connectEventSource(url) {
    if (state.eventSource) {
        state.eventSource.close();
        state.eventSource = null;
    }

    state.eventSource = new EventSource(url);

    state.eventSource.onopen = () => {
        setStatusText('Connected — Scanning series pages…');
    };

    state.eventSource.onmessage = e => {
        try {
            const data = JSON.parse(e.data);
            handleSseEvent(data);
        } catch {
            // Ping
        }
    };

    state.eventSource.onerror = () => {
        if (state.eventSource.readyState === EventSource.CLOSED) {
            if (state.isProcessing) {
                setStatusText('Session closed');
                stopProcessing();
            }
        }
    };
}

function handleSseEvent(d) {
    if (d.type === 'connected') {
        setStatusText('Connected — Scanning series pages…');
        return;
    }

    if (d.type === 'status') {
        setStatusText(d.message);
    }

    if (d.type === 'warning') {
        showToast(d.message, 'info');
    }

    if (d.type === 'episodes_found') {
        state.totalCount = d.count;
        setStatusText(`Found ${d.count} episode${d.count > 1 ? 's' : ''}. Extracting links…`);
        updateProgress(0, d.count);
        setStatusCounter(0, d.count);

        d.episodes.forEach((title, idx) => {
            addItemCard(title, 'waiting', null, null, idx);
        });
    }

    if (d.type === 'progress') {
        const id = d.episode;
        updateItemCard(id, 'fetching', null, null);
    }

    if (d.type === 'result') {
        const id = d.episode;
        state.doneCount = d.processed;
        updateProgress(d.processed, d.total);
        setStatusCounter(d.processed, d.total);

        if (d.status === 'done') {
            updateItemCard(id, 'done', d.link, null);
            state.links.push({ label: id, url: d.link });
            playTone('click');
        } else {
            updateItemCard(id, 'failed', null, d.error || 'Failed');
        }

        updateResultsHeader();
    }

    if (d.type === 'done') {
        playTone('done');
        setStatusText(`Done — ${state.links.length} link${state.links.length !== 1 ? 's' : ''} extracted`);
        updateProgress(state.totalCount, state.totalCount);
        showToast(`✓ Extracted ${state.links.length} link(s)`, 'success');
        saveToHistory(state.links.length);
        stopProcessing();
    }

    if (d.type === 'error') {
        playTone('error');
        setStatusText(`❌ ${d.message}`);
        showToast(d.message, 'error');
        stopProcessing();
    }
}

function stopProcessing() {
    state.isProcessing = false;
    setButtonState(false, 'Start Fetching');
    if (state.eventSource) {
        state.eventSource.close();
        state.eventSource = null;
    }
}

// ─── UI CARDS ─────────────────────────────────────────────────────────────
function addItemCard(id, status, link, error, index = 0) {
    const list = document.getElementById('resultsList');
    document.getElementById('resultsContainer').style.display = 'flex';

    if (state.itemsMap.has(id)) {
        updateItemCard(id, status, link, error);
        return;
    }

    const card = document.createElement('div');
    card.className = `item-card ${status}`;

    const badge = document.createElement('span');
    badge.className = 'card-badge';
    badge.textContent = id;

    const body = document.createElement('div');
    body.className = 'card-body';

    const pill = document.createElement('span');
    pill.className = `status-pill ${status}`;
    pill.textContent = formatStatus(status);

    const actions = document.createElement('div');
    actions.className = 'card-actions';

    card.append(badge, body, pill, actions);
    list.appendChild(card);

    state.itemsMap.set(id, { card, body, pill, actions });
    updateCardContents(state.itemsMap.get(id), status, link, error);
}

function updateItemCard(id, status, link, error) {
    let item = state.itemsMap.get(id);
    if (!item) {
        addItemCard(id, status, link, error);
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

        // Copy button
        const copyBtn = createActionButton('copy', 'Copy direct link', () => copyToClipboard(link, copyBtn));
        // Stream Preview button
        const playBtn = createActionButton('play', 'Stream / Preview video', () => openPlayerModal(link));

        actions.append(copyBtn, playBtn);
    } else if (error) {
        const errSpan = document.createElement('span');
        errSpan.className = 'card-error';
        errSpan.textContent = error;
        body.appendChild(errSpan);
    } else {
        const ph = document.createElement('span');
        ph.className = 'card-placeholder';
        ph.textContent = status === 'fetching' ? 'Extracting direct link…' : 'Queued…';
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
        showToast('✓ Copied to clipboard!', 'success');
        if (btn) {
            btn.classList.add('copied');
            setTimeout(() => btn.classList.remove('copied'), 1800);
        }
    }).catch(() => {
        showToast('Copy failed', 'error');
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

function setButtonState(disabled, text) {
    const btn = document.getElementById('seriesBtn');
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
    fetch(`${state.apiBase}/api/clear`, { method: 'POST' }).catch(() => {});
    showToast('Cleared');
}

// ─── EXPORT SUITE ─────────────────────────────────────────────────────────
function copyAllLinks() {
    if (!state.links.length) {
        showToast('No links to copy', 'error');
        return;
    }
    const txt = state.links.map(l => l.url).join('\n');
    copyToClipboard(txt);
}

function exportAsTxt() {
    if (!state.links.length) return;
    const content = state.links.map(l => `${l.label}: ${l.url}`).join('\n');
    downloadFile(content, 'series-links.txt', 'text/plain');
}

function exportAsJson() {
    if (!state.links.length) return;
    const content = JSON.stringify({
        exportedAt: new Date().toISOString(),
        total: state.links.length,
        episodes: state.links
    }, null, 2);
    downloadFile(content, 'series-links.json', 'application/json');
}

function exportAsM3U() {
    if (!state.links.length) return;
    let m3u = '#EXTM3U\n';
    state.links.forEach(item => {
        m3u += `#EXTINF:-1,${item.label}\n${item.url}\n`;
    });
    downloadFile(m3u, 'series-playlist.m3u', 'audio/x-mpegurl');
    showToast('✓ Exported M3U playlist for VLC / PotPlayer', 'success');
}

function exportAsAria2() {
    if (!state.links.length) return;
    const commands = state.links.map(l => `aria2c -c -x 16 -s 16 "${l.url}"`).join('\n');
    copyToClipboard(commands);
    showToast('✓ Copied Aria2 commands to clipboard', 'success');
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

// ─── FILTER ───────────────────────────────────────────────────────────────
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

// ─── HISTORY DRAWER ───────────────────────────────────────────────────────
function saveToHistory(count) {
    try {
        const history = JSON.parse(localStorage.getItem('fetch_links_history') || '[]');
        history.unshift({
            date: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            fullDate: new Date().toLocaleDateString(),
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
        list.innerHTML = '<div style="color:var(--text-dim); text-align:center; padding:2rem 0; font-size:0.8rem;">No recent sessions</div>';
        return;
    }

    items.forEach(h => {
        const card = document.createElement('div');
        card.className = 'history-card';
        card.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <span style="font-weight:700; font-size:0.8rem; color:var(--primary-light);">Series Extraction</span>
                <span style="font-size:0.7rem; color:var(--text-dim);">${h.date}</span>
            </div>
            <div style="font-size:0.75rem; color:var(--text-muted);">${h.count} episode link(s)</div>
        `;
        card.onclick = () => {
            resetResults();
            h.links.forEach((l, idx) => {
                addItemCard(l.label, 'done', l.url, null, idx);
                state.links.push(l);
            });
            updateResultsHeader();
            closeHistory();
            showToast(`Restored ${h.links.length} episode links`, 'success');
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
    showToast('Settings saved', 'success');
}

// ─── INITIALIZATION ───────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
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
            startSeriesFetch();
        } else if (e.key === 'Escape') {
            closePlayerModal();
            closeHistory();
            closeSettings();
        }
    });
});
