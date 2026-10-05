/* MediAssist — full analytics dashboard (staff only).
   Data: GET /api/analytics/summary (server-side aggregation of triage log + checkups).
   Advisory/operational metrics only — no diagnostic conclusions. */
'use strict';

var RISK_COLORS = { emergency: '#dc2626', urgent: '#ea580c', standard: '#eab308', routine: '#10b981' };
var STATUS_COLORS = { requested: '#60a5fa', triaged: '#38bdf8', scheduled: '#a78bfa', completed: '#34d399', cancelled: '#94a3b8' };
var BAR_COLORS = ['#14b8a6', '#60a5fa', '#a78bfa', '#f472b6', '#facc15', '#34d399', '#fb923c', '#94a3b8'];
var dashData = null;
var dashTimer = null;

function $(id) { return document.getElementById(id); }
/* Theme toggle (dashboard is standalone — triage.js not loaded here) */
function toggleTheme() {
  var cur = document.documentElement.getAttribute('data-theme');
  var nxt = cur === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', nxt);
  try { localStorage.setItem('theme', nxt); } catch (e) {}
  document.querySelectorAll('.theme-icon').forEach(function(el) { el.className = nxt === 'light' ? 'theme-icon fas fa-moon' : 'theme-icon fas fa-sun'; });
}
(function() { var t0 = document.documentElement.getAttribute('data-theme') || 'dark'; document.querySelectorAll('.theme-icon').forEach(function(el) { el.className = t0 === 'light' ? 'theme-icon fas fa-moon' : 'theme-icon fas fa-sun'; }); })();
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function loadSummary(showStamp) {
  return fetch('/api/analytics/summary', { credentials: 'include' })
    .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function(j) {
      dashData = j;
      renderAll(j);
      if (showStamp !== false) stamp();
      if (typeof applyI18n === 'function') applyI18n();
      return j;
    })
    .catch(function(e) {
      var el = $('dash-stamp'); if (el) el.textContent = 'Failed to load: ' + e.message;
    });
}

function stamp() {
  var el = $('dash-stamp');
  if (!el) return;
  var d = new Date();
  el.textContent = 'Updated ' + d.toLocaleTimeString();
}

function renderAll(d) {
  renderKpis(d.kpis || {});
  renderRisk(d.risk || {});
  renderBars('dash-status', d.status || {}, STATUS_COLORS, 'Status');
  renderBars('dash-scenario', d.scenario || {}, null, 'Scenario');
  renderBars('dash-facility', d.facility || {}, null, 'Facility');
  renderBars('dash-checkups', d.checkup_status || {}, STATUS_COLORS, 'Checkup');
  renderTrend(d.trend || { labels: [], series: [] });
  renderHours(d.hours || []);
  renderActivity(d.activity || []);
}

function renderKpis(k) {
  var el = $('dash-kpis'); if (!el) return;
  var cards = [
    { key: 'analytics.kpi.sessions', icon: 'fa-layer-group', v: k.sessions || 0 },
    { key: 'analytics.kpi.emergency', icon: 'fa-triangle-exclamation', v: k.emergency || 0, color: RISK_COLORS.emergency },
    { key: 'analytics.kpi.urgent', icon: 'fa-bolt', v: k.urgent || 0, color: RISK_COLORS.urgent },
    { key: 'analytics.kpi.completed', icon: 'fa-circle-check', v: k.completed || 0, color: RISK_COLORS.routine },
    { key: 'analytics.kpi.avgScore', icon: 'fa-gauge-high', v: k.avg_score || 0 },
    { key: 'analytics.kpi.today', icon: 'fa-calendar-day', v: k.today || 0 },
    { key: 'analytics.kpi.checkups', icon: 'fa-stethoscope', v: k.checkups || 0 },
    { key: 'analytics.kpi.instructions', icon: 'fa-file-medical', v: k.instructions || 0 }
  ];
  el.innerHTML = cards.map(function(c) {
    var isKey = c.key.indexOf('.') !== -1;
    return '<div class="triage-kpi"><div class="triage-kpi-label"' + (isKey ? ' data-i18n="' + c.key + '"' : '') + '>' +
      (isKey ? '' : esc(c.key)) + '</div><div class="triage-kpi-value"' + (c.color ? ' style="color:' + c.color + '"' : '') + '>' +
      esc(c.v) + '</div></div>';
  }).join('');
}

function renderRisk(risk) {
  var el = $('dash-risk'); if (!el) return;
  var order = ['emergency', 'urgent', 'standard', 'routine'];
  var total = 0, entries = [];
  order.forEach(function(k) {
    var v = risk[k] || 0;
    if (v) { entries.push({ k: k, v: v }); total += v; }
  });
  Object.keys(risk).forEach(function(k) {
    if (order.indexOf(k) === -1 && risk[k]) { entries.push({ k: k, v: risk[k] }); total += risk[k]; }
  });
  if (!total) { el.innerHTML = '<div class="triage-empty"><p>No triage sessions yet.</p></div>'; return; }

  // Donut (SVG arcs)
  var r = 54, cx = 70, cy = 70, circ = 2 * Math.PI * r, offset = 0, segs = '';
  entries.forEach(function(e) {
    var frac = e.v / total, len = frac * circ;
    segs += '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="' +
      (RISK_COLORS[e.k] || '#60a5fa') + '" stroke-width="18" stroke-dasharray="' + len.toFixed(2) + ' ' + (circ - len).toFixed(2) +
      '" stroke-dashoffset="' + (-offset).toFixed(2) + '"></circle>';
    offset += len;
  });
  var legend = entries.map(function(e) {
    var pct = Math.round((e.v / total) * 100);
    return '<div class="dash-legend-row"><span class="dash-legend-dot" style="background:' + (RISK_COLORS[e.k] || '#60a5fa') + '"></span>' +
      '<span class="dash-legend-label">' + esc(e.k.charAt(0).toUpperCase() + e.k.slice(1)) + '</span><span class="dash-legend-val">' + e.v + ' · ' + pct + '%</span></div>';
  }).join('');
  el.innerHTML = '<div class="triage-donut-wrap"><div class="triage-donut"><svg viewBox="0 0 140 140">' + segs +
    '</svg><div class="triage-donut-center"><b>' + total + '</b><span>sessions</span></div></div>' +
    '<div class="dash-legend">' + legend + '</div></div>';
}

function renderBars(id, data, colorMap, label) {
  var el = $(id); if (!el) return;
  var keys = Object.keys(data);
  if (!keys.length) { el.innerHTML = '<div class="triage-empty"><p>No data yet.</p></div>'; return; }
  keys.sort(function(a, b) { return data[b] - data[a]; });
  var max = data[keys[0]] || 1;
  el.innerHTML = keys.map(function(k, i) {
    var color = (colorMap && colorMap[k]) || BAR_COLORS[i % BAR_COLORS.length];
    var pct = Math.max(2, Math.round((data[k] / max) * 100));
    return '<div class="triage-bar-row"><span class="triage-bar-label" title="' + esc(label || '') + ' ' + esc(k) + '">' + esc(k) +
      '</span><div class="triage-bar-track"><div class="triage-bar-fill" style="width:' + pct + '%;background:' + color + '"></div></div>' +
      '<span class="triage-bar-val">' + data[k] + '</span></div>';
  }).join('');
}

function renderTrend(t) {
  var el = $('dash-trend'); if (!el) return;
  var labels = t.labels || [], series = t.series || [];
  if (!labels.length) { el.innerHTML = '<div class="triage-empty"><p>No trend data.</p></div>'; return; }
  var w = 800, h = 130, pad = 6;
  var max = Math.max.apply(null, series.concat([1]));
  var step = (w - pad * 2) / Math.max(1, labels.length - 1);
  var pts = series.map(function(v, i) {
    return [pad + i * step, h - pad - (v / max) * (h - pad * 2)];
  });
  var line = pts.map(function(p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' ');
  var area = line + ' L' + (pad + (labels.length - 1) * step).toFixed(1) + ',' + (h - pad) + ' L' + pad + ',' + (h - pad) + ' Z';
  var dots = pts.map(function(p, i) {
    if (!series[i]) return '';
    return '<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="2.5" fill="#14b8a6"><title>' +
      esc(labels[i]) + ': ' + series[i] + ' sessions</title></circle>';
  }).join('');
  var ticks = [0, Math.floor(labels.length / 2), labels.length - 1].map(function(i) {
    return '<span class="dash-trend-tick">' + esc((labels[i] || '').slice(5)) + '</span>';
  }).join('');
  el.innerHTML = '<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none">' +
    '<path d="' + area + '" fill="rgba(20,184,166,.14)"></path>' +
    '<path d="' + line + '" fill="none" stroke="#14b8a6" stroke-width="2"></path>' + dots + '</svg>' +
    '<div class="dash-trend-axis">' + ticks + '</div>';
}

function renderHours(hours) {
  var el = $('dash-hours'); if (!el) return;
  if (!hours.length) { el.innerHTML = '<div class="triage-empty"><p>No data.</p></div>'; return; }
  var max = Math.max.apply(null, hours.map(function(h) { return h.count; }).concat([1]));
  el.innerHTML = '<div class="dash-hours-grid">' + hours.map(function(h) {
    var frac = h.count / max;
    var alpha = h.count ? (0.25 + frac * 0.75).toFixed(2) : 0;
    var bg = h.count ? 'rgba(20,184,166,' + alpha + ')' : 'var(--bg-raise2)';
    return '<div class="dash-hour-cell" style="background:' + bg + '" title="' + String(h.hour).padStart(2, '0') + ':00 — ' + h.count + ' sessions">' +
      '<span class="dash-hour-n">' + (h.count || '') + '</span><span class="dash-hour-h">' + String(h.hour).padStart(2, '0') + '</span></div>';
  }).join('') + '</div>';
}

function renderActivity(items) {
  var el = $('dash-activity'); if (!el) return;
  if (!items.length) { el.innerHTML = '<div class="triage-empty"><p>No recent activity.</p></div>'; return; }
  el.innerHTML = items.map(function(a) {
    var cls = 'triage-badge triage-badge-risk-' + (RISK_COLORS[a.risk] ? a.risk : 'standard');
    return '<div class="dash-act-row"><span class="' + cls + '">' + esc(a.risk) + '</span>' +
      '<div class="dash-act-main"><div class="dash-act-title">' + esc(a.title) + '</div>' +
      '<div class="dash-act-detail">' + esc(a.detail || '') + '</div></div>' +
      '<span class="dash-act-time">' + esc((a.at || '').replace('T', ' ').slice(0, 16)) + '</span></div>';
  }).join('');
}

function exportCsv() {
  if (!dashData) return;
  var d = dashData, rows = [['metric', 'key', 'value']];
  Object.keys(d.kpis || {}).forEach(function(k) { rows.push(['kpi', k, d.kpis[k]]); });
  ['risk', 'status', 'scenario', 'facility', 'checkup_status'].forEach(function(g) {
    Object.keys(d[g] || {}).forEach(function(k) { rows.push([g, k, d[g][k]]); });
  });
  (d.trend.labels || []).forEach(function(l, i) { rows.push(['daily', l, d.trend.series[i]]); });
  (d.hours || []).forEach(function(h) { rows.push(['hour', h.hour, h.count]); });
  var csv = rows.map(function(r) {
    return r.map(function(c) { return '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"'; }).join(',');
  }).join('\n');
  var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'mediassist-analytics-' + new Date().toISOString().slice(0, 10) + '.csv';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

function setupAutoRefresh() {
  var box = $('dash-auto');
  function sync() {
    if (dashTimer) { clearInterval(dashTimer); dashTimer = null; }
    if (box && box.checked) dashTimer = setInterval(function() { loadSummary(true); }, 30000);
  }
  if (box) box.addEventListener('change', sync);
  sync();
}

document.addEventListener('DOMContentLoaded', function() {
  loadSummary(true);
  setupAutoRefresh();
});
