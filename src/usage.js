// Counts Gemini requests per model per day, so Assistant can say how much of
// the free tier is used. Google doesn't report the remaining quota, so the
// daily limit is learned: when a model hits its per-day limit, the count at
// that moment is remembered and used for warnings on later days.
// Free-tier days reset at midnight Pacific time.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const file = () => path.join(app.getPath('userData'), 'usage.json');
const PACIFIC = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' });
const pacificDay = (d = new Date()) => PACIFIC.format(d);

let data = null;

function load() {
  if (!data) {
    try {
      data = JSON.parse(fs.readFileSync(file(), 'utf8'));
    } catch {
      data = {};
    }
    data.counts ||= {};
    data.limits ||= {};
  }
  const today = pacificDay();
  if (data.day !== today) {
    data.day = today;
    data.counts = {};
  }
  return data;
}

function save() {
  try {
    fs.writeFileSync(file(), JSON.stringify(data));
  } catch {
    // usage counts are a convenience; never fail a request over them
  }
}

function count(model) {
  const d = load();
  d.counts[model] = (d.counts[model] || 0) + 1;
  save();
}

function hitDailyLimit(model) {
  const d = load();
  if (d.counts[model]) d.limits[model] = d.counts[model];
  save();
}

// When the free day ends, in the user's own time: binary-search the moment the
// Pacific date changes within the next 25 hours.
function resetTime() {
  const now = Date.now();
  const today = pacificDay(new Date(now));
  let lo = now;
  let hi = now + 25 * 3600 * 1000;
  while (hi - lo > 30 * 1000) {
    const mid = Math.floor((lo + hi) / 2);
    if (pacificDay(new Date(mid)) === today) lo = mid; else hi = mid;
  }
  return new Date(hi).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function forModel(model) {
  const d = load();
  const used = d.counts[model] || 0;
  const limit = d.limits[model] || null;
  return { used, limit, near: Boolean(limit && used >= limit * 0.8), resetsAt: resetTime() };
}

function all() {
  const d = load();
  const out = {};
  for (const m of new Set([...Object.keys(d.counts), ...Object.keys(d.limits)])) out[m] = forModel(m);
  return out;
}

module.exports = { count, hitDailyLimit, forModel, all, resetTime };
