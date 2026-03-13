const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// =====================
// ADDON DEFINITIONS
// =====================
const ADDONS = [
  {
    id: 'meteor',
    name: 'Meteor',
    emoji: '☄️',
    manifestUrl: 'https://meteorfortheweebs.midnightignite.me/manifest.json',
    statusPageUrl: 'https://stremio-addons.net/addons/meteor-midnightignite',
  },
  {
    id: 'aio-streams',
    name: 'Duck Streams',
    emoji: '🦆',
    manifestUrl: 'https://aiostreams.elfhosted.com/manifest.json',
    statusPageUrl: 'https://stremio-addons.net/addons/aiostreams',
  },
  {
    id: 'comet',
    name: 'Comet',
    emoji: '💫',
    manifestUrl: 'https://comet.elfhosted.com/manifest.json',
    statusPageUrl: 'https://stremio-addons.net/addons/comet',
  },
  {
    id: 'jackettio',
    name: 'Jackettio',
    emoji: '🎯',
    manifestUrl: 'https://jackettio.elfhosted.com/manifest.json',
    statusPageUrl: 'https://stremio-addons.net/addons/jackettio',
  },
  {
    id: 'torrentio',
    name: 'Torrentio',
    emoji: '🌊',
    manifestUrl: 'https://torrentio.strem.fun/manifest.json',
    statusPageUrl: 'https://stremio-addons.net/addons/torrentio',
  },
];

// =====================
// IN-MEMORY HISTORY STORE
// hourlyData[addonId][hourKey] = { up: n, total: n }
// recentChecks[addonId] = [...] last 120 results
// =====================
const store = {};
ADDONS.forEach(a => {
  store[a.id] = {
    status: 'checking',
    latency: null,
    version: null,
    lastUp: null,
    error: null,
    hourlyData: {},   // hourKey (floor of timestamp/3600000) -> { up, total }
    recentChecks: [], // 'up' | 'down' — last 120
    lastChecked: null,
  };
});

function getCurrentHourKey() {
  return Math.floor(Date.now() / 3600000);
}

function recordCheck(addonId, isUp, latency, version, error) {
  const s = store[addonId];
  const hourKey = getCurrentHourKey();

  s.status = isUp ? 'online' : 'offline';
  s.latency = latency;
  s.error = error || null;
  s.lastChecked = new Date().toISOString();
  if (isUp) {
    s.lastUp = new Date().toISOString();
    if (version) s.version = version;
  }

  // Hourly bucket
  if (!s.hourlyData[hourKey]) s.hourlyData[hourKey] = { up: 0, total: 0 };
  s.hourlyData[hourKey].total++;
  if (isUp) s.hourlyData[hourKey].up++;

  // Recent checks (cap at 120)
  s.recentChecks.push(isUp ? 'up' : 'down');
  if (s.recentChecks.length > 120) s.recentChecks.shift();

  // Prune hourly data older than 48h
  const cutoff = getCurrentHourKey() - 48;
  Object.keys(s.hourlyData).forEach(k => {
    if (Number(k) < cutoff) delete s.hourlyData[k];
  });
}

// =====================
// CHECKER
// =====================
async function checkAddon(addon) {
  const startTime = Date.now();
  let isUp = false;
  let latency = null;
  let version = null;
  let error = null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const response = await fetch(addon.manifestUrl, {
      method: 'GET',
      headers: { 'Accept': 'application/json', 'User-Agent': 'StremioUptimeMonitor/1.0' },
      signal: controller.signal,
    });

    clearTimeout(timeout);
    latency = Date.now() - startTime;

    if (response.ok) {
      try {
        const data = await response.json();
        version = data.version || null;
      } catch (_) {}
      isUp = true;
    } else {
      error = `HTTP ${response.status}`;
      isUp = false;
    }
  } catch (err) {
    latency = Date.now() - startTime;
    if (err.name === 'AbortError') {
      error = 'Timeout after 8s';
    } else {
      error = err.message || 'Connection failed';
    }
    isUp = false;
  }

  recordCheck(addon.id, isUp, latency, version, error);
  console.log(`[${new Date().toISOString()}] ${addon.name}: ${isUp ? 'UP' : 'DOWN'} (${latency}ms)`);
}

async function checkAll() {
  await Promise.allSettled(ADDONS.map(a => checkAddon(a)));
}

// =====================
// API ROUTES
// =====================

// GET /api/status — full status for all addons
app.get('/api/status', (req, res) => {
  const currentHour = getCurrentHourKey();
  const HOURS = 48;

  const result = ADDONS.map(addon => {
    const s = store[addon.id];

    // Build 48-slot hourly display
    const hourlySlots = [];
    for (let i = 0; i < HOURS; i++) {
      const hourKey = currentHour - (HOURS - 1 - i);
      const data = s.hourlyData[hourKey];
      const slotDate = new Date(hourKey * 3600000);
      const hoursAgo = HOURS - 1 - i;

      const label = hoursAgo === 0
        ? 'Current hour'
        : `${hoursAgo}h ago (${slotDate.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', hour12: true })})`;

      let status = 'none';
      let pct = null;
      if (data && data.total > 0) {
        pct = Math.round((data.up / data.total) * 100);
        status = pct === 100 ? 'up' : pct === 0 ? 'down' : 'partial';
      }
      hourlySlots.push({ hourKey, label, status, pct });
    }

    // Uptime % from recent checks
    const known = s.recentChecks.filter(r => r !== 'none');
    const uptimePct = known.length === 0 ? null
      : Math.round((known.filter(r => r === 'up').length / known.length) * 100);

    // 48h overall pct
    const knownSlots = hourlySlots.filter(sl => sl.status !== 'none');
    const pct48h = knownSlots.length === 0 ? null
      : Math.round(knownSlots.reduce((sum, sl) => sum + (sl.pct || 0), 0) / knownSlots.length);

    // Checks today
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startHour = Math.floor(startOfDay.getTime() / 3600000);
    let checksToday = 0;
    for (let h = startHour; h <= currentHour; h++) {
      if (s.hourlyData[h]) checksToday += s.hourlyData[h].total;
    }

    return {
      id: addon.id,
      name: addon.name,
      emoji: addon.emoji,
      statusPageUrl: addon.statusPageUrl,
      manifestUrl: addon.manifestUrl,
      status: s.status,
      latency: s.latency,
      version: s.version,
      lastUp: s.lastUp,
      lastChecked: s.lastChecked,
      error: s.error,
      uptimePct,
      pct48h,
      checksToday,
      hourlySlots,
    };
  });

  res.json({ addons: result, serverTime: new Date().toISOString() });
});

// GET /api/health — simple health check
app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime(), time: new Date().toISOString() });
});

// =====================
// START SERVER + SCHEDULER
// =====================
app.listen(PORT, () => {
  console.log(`Stremio Uptime Monitor backend running on port ${PORT}`);

  // Initial check immediately
  checkAll();

  // Then check every 30 seconds
  setInterval(checkAll, 30000);
});
