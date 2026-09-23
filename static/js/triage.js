/* MediAssist — Triage client logic (port). Wires intake, OCR, AI note, queue, referral, analytics, audit, timeline to existing backend endpoints. */
'use strict';

/* ---------- DOM helpers ---------- */
function $(s) { return document.querySelector(s); }
function $$(s) { return Array.from(document.querySelectorAll(s)); }
function esc(s) { var d = document.createElement('div'); d.textContent = String(s == null ? '' : s); return d.innerHTML; }
function showEl(id) { var e = document.getElementById(id); if (e) e.style.display = ''; }
function hideEl(id) { var e = document.getElementById(id); if (e) e.style.display = 'none'; }
function fmtDate(iso) { if (!iso) return '—'; var d = new Date(iso); return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }); }
function timeAgo(iso) { if (!iso) return ''; var s = Math.max(0, Date.now() - new Date(iso).getTime()); var m = Math.floor(s / 60000); if (m < 1) return 'just now'; if (m < 60) return m + 'm ago'; var h = Math.floor(m / 60); if (h < 24) return h + 'h ago'; var dd = Math.floor(h / 24); return dd + 'd ago'; }
function uuid() { return 'xxxx-xxxx-xxxx'.replace(/x/g, function() { return (Math.random() * 16 | 0).toString(16); }); }

/* ---------- LocalStorage helpers ---------- */
function SK() { return 'triage.sessions.' + (state.role || 'patient'); }
function AK() { return 'triage.audit.' + (state.role || 'patient'); }
function lsGet(k, def) { try { var v = localStorage.getItem(k); return v == null ? def : JSON.parse(v); } catch (e) { return def; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* quota */ } }

/* ---------- Constants ---------- */
var RISK_META = {
  emergency: { label: 'Emergency', color: '#dc2626', weight: 4, order: 0 },
  urgent:    { label: 'Urgent',    color: '#ea580c', weight: 3, order: 1 },
  standard:  { label: 'Standard',  color: '#eab308', weight: 2, order: 2 },
  routine:   { label: 'Routine',   color: '#10b981', weight: 1, order: 3 }
};
var STATUS_META = {
  requested:  { label: 'Requested',  next: 'scheduled', action: 'Schedule',  badgeCls: '' },
  scheduled:  { label: 'Scheduled',  next: 'completed', action: 'Mark completed', badgeCls: '' },
  completed:  { label: 'Completed',  next: null, action: null, badgeCls: ' is-live' }
};
var FACILITY_LABELS = {
  public_govt: { label: 'Public — Government Hospital', icon: 'fa-hospital', scenarios: ['opd','fever','maternal','chronic'] },
  phc:         { label: 'Primary Health Centre (PHC)',   icon: 'fa-house-medical', scenarios: ['routine','immunization','referral'] },
  company:     { label: 'Company / Occupational Health', icon: 'fa-factory', scenarios: ['hearing','mobility','roster'] },
  industrial:  { label: 'Industrial Estate Health Unit', icon: 'fa-industry', scenarios: ['hearing','mobility','roster'] },
  campus:      { label: 'Campus Health Centre',          icon: 'fa-graduation-cap', scenarios: ['fever','hostel','mental'] },
  private_clinic: { label: 'Private Clinic',            icon: 'fa-user-doctor', scenarios: ['opd','followup','referral'] },
  community:   { label: 'Community / NGO Health Camp',   icon: 'fa-campground', scenarios: ['screening','fever_camp','eye'] }
};
var FACILITY_OPTIONS = Object.keys(FACILITY_LABELS).map(function(k) { return { value: k, label: FACILITY_LABELS[k].label, icon: FACILITY_LABELS[k].icon }; });
var SCENARIO_LABELS = {
  public_govt: [['opd','Emergency — OPD queue triage'],['fever','Fever — seasonal / dengue camps'],['maternal','Maternal & child health (MCH)'],['chronic','Chronic / NCD check-in']],
  phc: [['routine','Routine OPD / minor illness'],['immunization','Immunization day surge'],['referral','Referral port to higher centre']],
  company: [['hearing','Occupational-health screening'],['mobility','Workplace injury / strain'],['roster','Night-shift roster triage']],
  industrial: [['hearing','Occupational-health screening'],['mobility','Workplace injury / strain'],['roster','Night-shift roster triage']],
  campus: [['fever','Campus fever triage'],['hostel','Hostel / dorm screening'],['mental','Stress / mental-health screen']],
  private_clinic: [['opd','OPD / consultation'],['followup','Chronic follow-up'],['referral','Referral preparation']],
  community: [['screening','General health screening'],['fever_camp','Fever / camp triage'],['eye','Vision / eye screening']]
};
var LANG_OPTIONS = [
  { label: 'English', lang: 'en-US' }, { label: 'Hindi (हिन्दी)', lang: 'hi-IN' },
  { label: 'Bengali (বাংলা)', lang: 'bn-IN' }, { label: 'Tamil (தமிழ்)', lang: 'ta-IN' },
  { label: 'Telugu (తెలుగు)', lang: 'te-IN' }, { label: 'Kannada (ಕನ್ನಡ)', lang: 'kn-IN' },
  { label: 'Malayalam (മലയാളം)', lang: 'ml-IN' }, { label: 'Marathi (मराठी)', lang: 'mr-IN' },
  { label: 'Gujarati (ગુજરાતી)', lang: 'gu-IN' }, { label: 'Punjabi (ਪੰਜਾਬੀ)', lang: 'pa-IN' },
  { label: 'Odia (ଓଡ଼ିଆ)', lang: 'or-IN' }, { label: 'Assamese (অসমীয়া)', lang: 'as-IN' }
];
var SIGNALS = {
  emergency: [
    ['chest pain|pressure|squeeze', 2, 'Acute chest pain'], ['shortness of breath|difficulty breathing|cannot breathe', 2, 'Respiratory distress'],
    ['fainting|lost consciousness|passed out|unconscious', 2, 'Loss of consciousness'], ['seizure|convulsion|fits', 2, 'Seizure'],
    ['active bleeding|profuse bleed', 2, 'Active bleeding'], ['stroke|sudden weakness|face droop|slurred speech', 2, 'Stroke signs'],
    ['severe allergic|anaphylaxis|throat tight', 2, 'Anaphylaxis'], ['poisoning|overdose|ingested', 2, 'Suspected poisoning'],
    ['major trauma|open fracture|penetrating', 2, 'Major trauma'], ['confusion|altered sensorium|delirium', 2, 'Altered sensorium'],
    ['high fever >39|fever above 39|temp 39', 1, 'High fever (>39°C)']
  ],
  urgent: [
    ['severe headache|worst headache of', 1, 'Severe headache'], ['vomiting blood|blood in vomit|hematemesis', 1, 'Haematemesis'],
    ['blood in urine|hematuria|blood in stool|hematochezia', 1, 'Blood in urine/stool'], ['high fever|persistent fever|prolonged fever|fever 3 days|fever 4 days|fever 5 days', 1, 'Persistent high fever'],
    ['difficulty swallowing|unable to swallow', 1, 'Dysphagia'], ['jaundice|yellow eyes|yellow skin', 1, 'Jaundice'],
    ['rapid heart rate|palpitations|racing heart', 1, 'Tachycardia'], ['severe abdominal pain|acute abdomen', 1, 'Severe abdominal pain'],
    ['breathlessness|breathing trouble|gasping', 1, 'Breathlessness'], ['uncontrolled diabetes|blood sugar very high', 1, 'Uncontrolled diabetes'],
    ['dangerous|not improving|getting worse|worsening', 1, 'Condition worsening']
  ],
  standard: [
    ['moderate pain|moderate fever|mild fever|low grade fever', 0, 'Moderate symptoms'], ['cough|cold|runny nose|sneezing', 0, 'Respiratory symptoms'],
    ['diarrhea|loose stools|vomiting', 0, 'Gastroenteritis'], ['rash|skin lesions|itching', 0, 'Dermatological issue'],
    ['headache|dizziness|vertigo', 0, 'Headache / dizziness'], ['fatigue|weakness|body ache|joint pain', 0, 'Fatigue / musculoskeletal pain'],
    ['urinary tract|burning micturition|UTI', 0, 'Urinary complaint'], ['eye redness|conjunctivitis|eye discharge', 0, 'Eye complaint'],
    ['ear pain|ear discharge|hearing loss', 0, 'Ear complaint'], ['back pain|neck pain|sprain', 0, 'Musculoskeletal pain']
  ],
  routine: [
    ['general checkup|health checkup|routine checkup', 0, 'General checkup'], ['annual checkup|periodic health', 0, 'Periodic health'],
    ['followup|follow-up|review visit|regular checkup', 0, 'Follow-up'], ['medication review|drug review', 0, 'Medication review'],
    ['vaccination|immunization|vaccine', 0, 'Vaccination'], ['counselling|health education|lifestyle', 0, 'Health counselling']
  ]
};

/* ---------- Application state ---------- */
var state = {
  role: (document.body.getAttribute('data-role') || 'patient'),
  isStaff: ['doctor', 'nurse'].indexOf(document.body.getAttribute('data-role') || '') >= 0,
  facility: 'public_govt',
  scenario: 'opd',
  facilityName: '',
  note: null,
  session: null,
  extractedTests: [],
  queueServer: [],
  queueSessions: [],
  queueLoaded: false,
  seedLoaded: false,
  batchBar: false,
  batchSelected: {},
  speechConfig: null
};

/* ---------- Init ---------- */
function init() {
  state.role = document.body.getAttribute('data-role') || 'patient';
  state.isStaff = ['doctor', 'nurse'].indexOf(state.role) >= 0;
  populateFacilitySelect();
  populateLangSelect();
  fetch('/api/speech-config', { credentials: 'include' })
    .then(function(r) { return r.ok ? r.json() : null; })
    .catch(function() { return null; })
    .then(function(cfg) { state.speechConfig = cfg; bindMic(); });
  bindDropzone();
  bindGenerate();
  bindActions();
  bindBookCall();
  bindThemeLogout();
  updateBadge();
  renderHeroStats();
  // seed if returning
  if (lsGet('triage.demoLoaded.' + state.role, false)) { state.seedLoaded = true; }
}

function populateFacilitySelect() {
  var sel = $('#facility-type'); if (!sel) return;
  sel.innerHTML = '';
  FACILITY_OPTIONS.forEach(function(o) {
    var opt = document.createElement('option'); opt.value = o.value; opt.textContent = o.label; sel.appendChild(opt);
  });
  sel.value = state.facility;
  populateScenarioSelect();
}

function populateScenarioSelect() {
  var sel = $('#scenario'); if (!sel) return;
  var key = $('#facility-type').value || state.facility;
  var list = SCENARIO_LABELS[key] || SCENARIO_LABELS.public_govt;
  state.facility = key;
  sel.innerHTML = '';
  list.forEach(function(p) { var o = document.createElement('option'); o.value = p[0]; o.textContent = p[1]; sel.appendChild(o); });
  sel.value = state.scenario || list[0][0];
  state.scenario = sel.value;
}

function populateLangSelect() {
  var sel = $('#input-lang'); if (!sel) return;
  sel.innerHTML = '';
  LANG_OPTIONS.forEach(function(o) { var opt = document.createElement('option'); opt.value = o.lang; opt.textContent = o.label; sel.appendChild(opt); });
  sel.value = 'en-US';
  var hint = document.createElement('small'); hint.className = 'triage-hint'; hint.id = 'lang-hint'; hint.textContent = 'Voice and summarization use the language selected above.';
  sel.parentNode.appendChild(hint);
}

/* ---------- Theme / logout ---------- */
function toggleTheme() {
  var cur = document.documentElement.getAttribute('data-theme');
  var nxt = cur === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', nxt);
  try { localStorage.setItem('theme', nxt); } catch (e) {}
  updateThemeIcon(nxt);
}
function updateThemeIcon(t) { document.querySelectorAll('.theme-icon').forEach(function(el) { el.className = t === 'light' ? 'theme-icon fas fa-moon' : 'theme-icon fas fa-sun'; }); }
updateThemeIcon(document.documentElement.getAttribute('data-theme') || 'dark');

async function doLogout() {
  try { await fetch('/logout', { method: 'POST', credentials: 'include' }); } catch (e) {}
  window.location.href = '/login';
}

/* ---------- Mic ---------- */
var recognition = null, isRecording = false;
var REC_WATCHDOG_MS = 8000;
var REC_base = '', REC_finals = '', REC_interim = '', REC_WATCHDOG = null;
function micLang() { return ($('#input-lang') && $('#input-lang').value) ? $('#input-lang').value : 'en-US'; }
function micSetLive(on) {
  var pill = $('#listening-pill'); if (pill) pill.style.display = on ? '' : 'none';
  var btn = $('#mic-btn'); if (btn) btn.classList.toggle('recording', on);
  var lbl = $('#mic-label'); if (lbl) lbl.textContent = on ? 'Stop (recording…)' : 'Speak (live)';
}
function micShowErr(msg) { var el = $('#mic-error'); if (el) { el.textContent = msg; el.style.display = ''; } }
function micClearErr() { var el = $('#mic-error'); if (el) el.style.display = 'none'; }
function stopMicWatchdog() { if (REC_WATCHDOG) { clearTimeout(REC_WATCHDOG); REC_WATCHDOG = null; } }
function armMicWatchdog() {
  stopMicWatchdog();
  REC_WATCHDOG = setTimeout(function() {
    REC_WATCHDOG = null;
    isRecording = false; micSetLive(false);
    if (recognition) { try { recognition.abort(); } catch (e) {} }
    micShowErr('No audio detected — check your microphone/input device, then tap Speak and try again.');
  }, REC_WATCHDOG_MS);
}
function renderMicTranscript() {
  var ta = $('#symptoms'); if (!ta) return;
  ta.value = (REC_base + ' ' + REC_finals + ' ' + REC_interim).replace(/\s+/g, ' ').trim();
}
function startMic() {
  if (isRecording) return;
  micClearErr();
  REC_base = ($('#symptoms') ? $('#symptoms').value : ''); REC_finals = ''; REC_interim = '';
  if (recognition) { try { recognition.abort(); } catch (e) {} }
  var SR = window.webkitSpeechRecognition || window.SpeechRecognition;
  if (!SR) { micShowErr('Voice input is not supported in this browser — use Chrome or Edge for live dictation.'); return; }
  var r;
  try {
    r = new SR();
    recognition = r;
    r.continuous = false; r.interimResults = true; r.lang = micLang();
    r.onstart = function() { isRecording = true; micSetLive(true); armMicWatchdog(); };
    r.onresult = function(e) {
      var finals = '', interim = '';
      for (var i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) finals += e.results[i][0].transcript;
        else interim += e.results[i][0].transcript;
      }
      if (finals) { REC_finals += finals; REC_interim = ''; }
      else if (interim) { REC_interim = interim; }
      renderMicTranscript();
      micClearErr();
    };
    r.onend = function() {
      stopMicWatchdog();
      isRecording = false; micSetLive(false);
      REC_finals += REC_interim; REC_interim = ''; renderMicTranscript();
    };
    r.onerror = function(e) {
      stopMicWatchdog();
      isRecording = false; micSetLive(false);
      REC_finals += REC_interim; REC_interim = ''; renderMicTranscript();
      var code = (e && e.error) || 'unknown';
      var msg = 'Voice error: ' + code.replace(/_/g, ' ') + ' — try again.';
      if (code === 'no-speech') msg = "Didn't catch any speech — tap Speak and try again.";
      else if (code === 'not-allowed' || code === 'service-not-allowed') msg = 'Microphone access was blocked. Allow mic permission for this site, then tap Speak again.';
      else if (code === 'audio-capture') msg = 'No microphone found — check your input device.';
      else if (code === 'network') msg = 'Voice service is offline right now — check your connection and retry.';
      else if (code === 'aborted') msg = 'Recording stopped.';
      micShowErr(msg);
    };
    r.start();
  } catch (e) {
    recognition = null; isRecording = false; micSetLive(false);
    micShowErr('Could not start voice: ' + e.message);
  }
}
function stopMic() { stopMicWatchdog(); if (recognition) { try { recognition.stop(); } catch (e) {} } }
function bindMic() {
  var btn = $('#mic-btn'); if (!btn) return;
  var supported = typeof window.webkitSpeechRecognition === 'function' || typeof window.SpeechRecognition === 'function';
  if (!supported) {
    var cfg = state.speechConfig;
    if (cfg && cfg.available && typeof window.MediaRecorder === 'function' && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      bindMediaRecorder();
      return;
    }
    btn.style.display = 'none';
    micShowErr('Voice input is not available — this browser lacks live dictation and the server voice fallback is off. Type manually.');
    return;
  }
  if (window.isSecureContext !== true) {
    micShowErr('Voice needs a secure connection (HTTPS or localhost). You are on a plain http:// address — open the https:// link, or use localhost.');
  }
  btn.style.display = '';
  micClearErr();
  var langSel = $('#input-lang');
  if (langSel) langSel.addEventListener('change', function() { if (recognition) { try { recognition.lang = micLang(); } catch (e) {} } });
  btn.addEventListener('click', function() { if (isRecording) stopMic(); else startMic(); });
}

/* ---------- Mic: server-side fallback (MediaRecorder -> /transcribe) ---------- */
var mediaRecorder = null, mediaChunks = [], mrBusy = false;
function mrLabel() { var l = $('#mic-label'); if (l) l.textContent = 'Speak (server)'; }
function bindMediaRecorder() {
  var btn = $('#mic-btn'); if (!btn) return;
  if (window.isSecureContext !== true) {
    micShowErr('Voice needs a secure connection (HTTPS or localhost). You are on a plain http:// address — open the https:// link, or use localhost.');
  }
  btn.style.display = '';
  micClearErr();
  mrLabel();
  btn.addEventListener('click', function() { if (isRecording) stopMediaMic(); else startMediaMic(); });
}
function startMediaMic() {
  if (isRecording || mrBusy) return;
  micClearErr();
  navigator.mediaDevices.getUserMedia({ audio: true }).then(function(stream) {
    mediaChunks = [];
    mediaRecorder = new MediaRecorder(stream);
    isRecording = true; micSetLive(true);
    mediaRecorder.ondataavailable = function(e) { if (e.data && e.data.size) mediaChunks.push(e.data); };
    mediaRecorder.onstop = function() {
      stream.getTracks().forEach(function(t) { try { t.stop(); } catch (e) {} });
      isRecording = false; micSetLive(false); mrLabel();
      stopMicWatchdog();
      var blob = new Blob(mediaChunks, { type: 'audio/webm' });
      mediaChunks = [];
      if (!blob.size) { micShowErr('No audio captured — check your microphone, then tap Speak and try again.'); return; }
      uploadMediaAudio(blob);
    };
    mediaRecorder.start();
  }).catch(function(e) {
    isRecording = false; micSetLive(false); mrLabel();
    micShowErr('Could not start microphone: ' + (e && e.message ? e.message : e) + ' — allow mic permission for this site and retry.');
  });
}
function stopMediaMic() {
  stopMicWatchdog();
  if (mediaRecorder && mediaRecorder.state !== 'inactive') { try { mediaRecorder.stop(); } catch (e) {} }
}
function uploadMediaAudio(blob) {
  var fd = new FormData(); fd.append('audio', blob, 'speech.webm');
  var lbl = $('#mic-label'); if (lbl) lbl.textContent = 'Transcribing…';
  mrBusy = true;
  fetch('/transcribe', { method: 'POST', body: fd, credentials: 'include' })
    .then(function(r) {
      return r.json().then(function(j) {
        if (!r.ok) throw new Error((j && (j.error || j.detail)) || ('HTTP ' + r.status));
        return j;
      });
    })
    .then(function(j) {
      mrBusy = false; mrLabel();
      var t = ((j && j.transcript) || '').trim();
      var ta = $('#symptoms');
      if (ta && t) ta.value = (ta.value.trim() ? ta.value.trim() + ' ' : '') + t;
      if (!t) micShowErr('No speech recognized — tap Speak and try again.');
      else micClearErr();
    })
    .catch(function(e) {
      mrBusy = false; mrLabel();
      micShowErr('Voice transcription failed: ' + e.message);
    });
}

/* ---------- Dropzone / OCR ---------- */
function bindDropzone() {
  var dz = $('#dropzone'); if (!dz) return;
  var fi = $('#report-file'); if (!fi) return;
  dz.addEventListener('click', function() { fi.click(); });
  dz.addEventListener('dragover', function(e) { e.preventDefault(); dz.classList.add('is-dragover'); });
  dz.addEventListener('dragleave', function() { dz.classList.remove('is-dragover'); });
  dz.addEventListener('drop', function(e) { e.preventDefault(); dz.classList.remove('is-dragover'); handleFile(e.dataTransfer.files[0]); });
  fi.addEventListener('change', function() { handleFile(fi.files[0]); fi.value = ''; });
}
function handleFile(file) {
  if (!file) return;
  var ext = file.name.split('.').pop().toLowerCase();
  var errEl = $('#upload-error');
  if (['png','jpg','jpeg','pdf'].indexOf(ext) === -1) {
    if (errEl) { errEl.textContent = 'Unsupported file type. Allowed: PNG, JPG, JPEG, PDF.'; errEl.style.display = ''; }
    return;
  }
  if (errEl) errEl.style.display = 'none';
  $('#dropzone-title').textContent = file.name;
  var dz = $('#dropzone'); if (dz) { dz.innerHTML = '<div class="triage-spinner" style="margin:0 auto 10px;"></div><p class="triage-note-loading" style="text-align:center;">Processing report…</p>'; }
  var fd = new FormData(); fd.append('file', file); fd.append('query', '');
  fetch('/chat', { method: 'POST', body: fd, credentials: 'include' })
    .then(function(r) { if (!r.ok) throw new Error('Upload failed: HTTP ' + r.status); return r.json(); })
    .then(function(d) {
      var text = (d && d.response) || '';
      var tests = null;
      var ocrMeta = null;
      // The server may answer with status:"validation_required" (Human-Validation gate) and
      // the structured OCR block fenced in message (```json ... ```) instead of response_json.
      // Recover it so the response tab still renders the structured findings.
      var haveStructured = d && d.response_json;
      if (!haveStructured && d && (d.status === 'validation_required') && d.message) {
        var blocked = d.message.match(/```(?:json)?\s*([\s\S]*?)```/);
        var rawJson = blocked ? blocked[1] : d.message;
        var firstBrace = rawJson.indexOf('{');
        if (firstBrace >= 0) {
          try { d.response_json = JSON.parse(rawJson.substring(firstBrace)); } catch (e) { d.response_json = null; }
          haveStructured = !!d.response_json;
        }
      }
      var parsed = haveStructured ? applyStructuredOCR(d.response_json) : null;
      if (parsed) { tests = parsed.tests; ocrMeta = parsed.meta; }
      if (parsed) { state.extractedOCRMeta = parsed.meta; }
      state.pendingFollowUpDate = (ocrMeta && ocrMeta.followUpDate) || null;
      if (state.pendingFollowUpDate) addAudit('followup_scheduled', 'Follow-up scheduled for ' + state.pendingFollowUpDate + ' from OCR follow-up line.');
      if (!tests) tests = parseTestsFromText(text);
      tests.forEach(function(t) { if (!state.extractedTests.find(function(e) { return e.name === t.name && e.value === t.value; })) state.extractedTests.push(t); });
      var docTypeLabel = (ocrMeta && ocrMeta.documentType) || 'Lab / Report';
      var html = '';
      html += '<div class="triage-finding-card"><div class="triage-finding-test">' + esc(docTypeLabel) + '</div></div>';
      if (ocrMeta && ocrMeta.abnormalFlags && ocrMeta.abnormalFlags.length) html += '<div class="triage-finding-card"><div class="triage-finding-test">Abnormal Flags</div><div class="triage-finding-value">' + ocrMeta.abnormalFlags.map(function(f) { return '<span class="triage-flag-pill triage-flag-critical">' + esc(f) + '</span>'; }).join(' ') + '</div></div>';
      (tests || []).forEach(function(t) { html += '<div class="triage-finding-card"><div class="triage-finding-test">' + esc(t.name) + '</div><div class="triage-finding-value">' + esc(String(t.value)) + ' ' + esc(t.unit) + ' <span class="triage-flag-pill triage-flag-' + esc(t.flag) + '">' + esc(t.flag) + '</span></div></div>'; });
      if (ocrMeta && ocrMeta.summary) html += '<div class="triage-finding-card"><div class="triage-finding-test">AI Summary</div><div class="triage-finding-value" style="white-space:pre-wrap;">' + esc(ocrMeta.summary) + '</div></div>';
      if (ocrMeta && ocrMeta.clinicalInsight) html += '<div class="triage-finding-card"><div class="triage-finding-test">Clinical Insight</div><div class="triage-finding-value" style="white-space:pre-wrap;">' + esc(ocrMeta.clinicalInsight) + '</div></div>';
      if (html.replace(/<[^>]+>/g, '').trim() === docTypeLabel) html += '<div class="triage-finding-card"><div class="triage-finding-test">No structured fields extracted</div><div class="triage-finding-value">' + esc(text.slice(0, 200)) + '</div></div>';
      $('#extracts').innerHTML = html;
      $('#upload-area').style.display = '';
      toggleGenerate();
      addAudit('ocr', 'OCR processed ' + file.name + ' — ' + tests.length + ' findings extracted.');
    })
    .catch(function(e) {
      if (errEl) { errEl.textContent = 'Upload failed: ' + (e.message || e); errEl.style.display = ''; }
      var dz = $('#dropzone'); if (dz) dz.innerHTML = '<i class="fas fa-cloud-arrow-up triage-dropzone-icon"></i><p class="triage-dropzone-title" id="dropzone-title">Click to upload a lab/report image</p><p class="triage-dropzone-sub">PNG / JPG / JPEG / PDF · AI-based analysis</p>';
    });
}

/* ---------- Generate triage note ---------- */
function bindGenerate() {
  var btn = $('#generate-btn'); if (!btn) return;
  btn.addEventListener('click', function() { generate(); });
  // enable/disable on input
  ['symptoms', 'anon-code', 'age-band', 'sex', 'input-lang'].forEach(function(id) {
    var el = document.getElementById(id); if (!el) return;
    el.addEventListener('input', toggleGenerate); el.addEventListener('change', toggleGenerate);
  });
}
function toggleGenerate() {
  var txt = ($('#symptoms') ? $('#symptoms').value.trim() : '');
  var consent = ($('#consent') ? $('#consent').checked : false);
  var hasFile = ($('#extracts') && $('#extracts').children.length > 0);
  $('#generate-btn').disabled = !(txt || hasFile) || !consent;
}

function aiBusyUntil() { return Number(localStorage.getItem('triage.ai.busyUntil') || 0); }
function aiRemaining() { var s = aiBusyUntil() - Date.now(); return s > 0 ? Math.ceil(s / 1000) : 0; }
function aiMarkBusy(secs) { localStorage.setItem('triage.ai.busyUntil', String(Date.now() + secs * 1000)); }
function rateSecs(e, dflt) {
  var s = String((e && (e.detail || e.message)) || '');
  var m = s.match(/(\d+)\s*seconds?/); if (m) return parseInt(m[1], 10);
  return dflt || 60;
}
function aiNoteBlocked() {
  if (state.aiInFlight) { var e2 = new Error('AI request is already in progress.'); e2.aiCooldown = true; e2.retrySeconds = 5; throw e2; }
  var r = aiRemaining();
  if (r > 0) { var e = new Error('AI is cooling down (' + r + 's). Please wait.'); e.aiCooldown = true; e.retrySeconds = r; throw e; }
}

async function generate() {
  var ta = $('#symptoms'), consent = $('#consent');
  var text = ta ? ta.value.trim() : '';
  if (!text && !($('#extracts') && $('#extracts').children.length > 0)) { setIntakeError('Add a symptom narrative or upload a report first.'); return; }
  if (!consent || !consent.checked) { setIntakeError('Please confirm the patient consent before generating a triage note.'); return; }
  if (consent && !localStorage.getItem('triage.consent.' + state.role)) { addAudit('consent_recorded', 'Patient/guardian informed consent recorded via the consent checkbox.'); try { localStorage.setItem('triage.consent.' + state.role, '1'); } catch(e){} }
  var anon = ($('#anon-code') ? $('#anon-code').value.trim() : '') || ('PT-' + new Date().getFullYear() + '-' + String(Math.floor(Math.random() * 9000) + 1000));
  if (anon) { var el = $('#anon-code'); el.value = anon; }
  var pkg = {
    narrative: text,
    ageBand: ($('#age-band') ? $('#age-band').value : ''),
    sex: ($('#sex') ? $('#sex').value : ''),
    lang: ($('#input-lang') ? $('#input-lang').value : 'en-US'),
    facility: state.facility,
    scenario: state.scenario,
    facilityName: ($('#facility-name') ? $('#facility-name').value.trim() : ''),
    extractedTests: state.extractedTests.slice()
  };
  state.note = null;   state.session = { id: uuid(), code: anon, createdAt: new Date().toISOString(), facility: state.facility, scenario: state.scenario, facilityName: pkg.facilityName, ageBand: pkg.ageBand, sex: pkg.sex, lang: pkg.lang, narrative: text, extractedTests: pkg.extractedTests.slice(), risk: null, score: 0, status: 'requested', src: 'local', patient_id: null, summary: '', chiefComplaints: [], timeline: '', expectedFindings: '', redFlags: [], missingInfo: [], followupQuestions: [], tests: [], followUpDate: state.pendingFollowUpDate || null, sources: [] };
  $('#note-empty').style.display = 'none'; $('#note-loading').style.display = ''; $('#note-result').style.display = 'none';
  hideIntakeError();
  addAudit('session_created', 'Triage session created for ' + anon + ' [' + state.facility + ' / ' + state.scenario + '].');
  try {
    var note = await aiNote(pkg);
    state.note = note; applyNote(note);
  } catch (e) {
    if ($('#intake-error')) { $('#intake-error').textContent = 'AI summarizer could not be reached — a rule-based draft is shown instead. Verify your connection or try again.'; $('#intake-error').style.display = ''; }
    state.note = ruleBasedNote(pkg); state.note.fallback = 'rule-fallback'; applyNote(state.note);
  }
  saveSession(); pushSession(); toggleGenerateState();
  $('#new-intake-btn').style.display = '';
  if (state.isStaff) $('#open-queue-btn').style.display = '';
}

function aiNote(pkg) {
  var parts = [];
  if (pkg.ageBand) parts.push('Age band: ' + pkg.ageBand);
  if (pkg.sex) parts.push('Sex: ' + pkg.sex);
  if (pkg.lang) parts.push('Input language: ' + pkg.lang);
  parts.push('Facility type: ' + (FACILITY_LABELS[pkg.facility] || {label: pkg.facility}).label);
  if (pkg.scenario) parts.push('Scenario: ' + pkg.scenario);
  if (pkg.facilityName) parts.push('Facility name: ' + pkg.facilityName);
  parts.push('Patient narrative:\n' + pkg.narrative);
  if (pkg.extractedTests && pkg.extractedTests.length) parts.push('OCR extracted findings:\n' + pkg.extractedTests.map(function(t) { return t.name + ': ' + t.value + ' ' + t.unit + ' [' + t.flag + ']'; }).join('\n'));
  var prompt = 'You are a triage-assistant summarizer operating inside an educational, non-diagnostic prototype. Produce a STRICT JSON object only (wrap it in ```json ... ``` if needed, but also produce raw JSON parseable). Do not diagnose or prescribe. Use this patient intake package:\n\n' + parts.join('\n') + '\n\nOutput this JSON only:\n' +
    '{\n"summary":"one-line chief complaint summary",\n"chief_complaints":["array of up to 4 verbatim phrases"],\n"timeline":"chronology of onset/progression in 1-3 sentences",\n"expected_findings":"what physical/clinical findings are expected based on the narrative",\n"red_flags":["list of urgency signals found (never a diagnosis)"],\n"missing_info":["information still missing for a complete review"],\n"followup_questions":["short clinician-facing questions"],\n"tests":[{"name":"test","value":"numeric result","unit":"unit","flag":"low|high|normal|critical|unknown"}],\n"risk":"emergency|urgent|standard|routine","score":0,' +
    '"rationale":"concise reason for the risk level"\n}\nRules: risk = emergency if any red flag signals chest/airway/unconsciousness/seizure/stroke/major trauma/anaphylaxis/poisoning; urgent if persistent fever/severe pain/blood/rapid worsening; otherwise standard or routine. Score = 0-100 integer. Return ONLY valid JSON.';
  return fetch('/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ query: prompt, conversation_history: [] }) })
    .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function(d) {
      if (d.status === 'validation_required') return ruleBasedNote(pkg);
      var txt = d.response || '';
      var note = extractJson(txt) || extractJsonBlock(txt);
      if (note && normalizeNote(note)) return normalizeNote(note);
      return ruleBasedNote(pkg);
    });
}

function extractJson(text) {
  try { return JSON.parse(text); } catch (e) { /* try block-scan */ }
  var start = text.indexOf('{');
  if (start === -1) return null;
  var i = start, depth = 0, inStr = false, esc2 = false;
  for (; i < text.length; i++) { var c = text[i]; if (inStr) { if (esc2) { esc2 = false; } else if (c === '\\') { esc2 = true; } else if (c === '"') { inStr = false; } continue; } if (c === '"') { inStr = true; } else if (c === '{') { depth++; } else if (c === '}') { depth--; if (depth === 0) break; } }
  if (depth !== 0) return null;
  try { return JSON.parse(text.substring(start, i + 1)); } catch (e) { return null; }
}
function extractJsonBlock(text) {
  var m = text.match(/```json\s*([\s\S]*?)```/); if (!m) return null;
  try { return JSON.parse(m[1].trim()); } catch (e) { return null; }
}
function normalizeNote(n) {
  if (!n || typeof n !== 'object') return null;
  var risk = String(n.risk || n.priority || 'standard').toLowerCase();
  if (RISK_META[risk] === undefined) risk = 'standard';
  n.risk = risk;
  n.summary = String(n.summary || n.clinical_summary || '');
  n.chief_complaints = Array.isArray(n.chief_complaints) ? n.chief_complaints : String(n.symptoms || n.chiefComplaints || n.summary || '').split(/[;,\n]/).filter(function(x) { return x.trim().length > 3; }).slice(0, 4);
  n.timeline = String(n.timeline || '');
  n.expected_findings = String(n.expected_findings || n.expected || '');
  n.red_flags = Array.isArray(n.red_flags) ? n.red_flags : String(n.redFlags || n.red_flags_list || '').split(/[;,\n]/).filter(function(x) { return x.trim().length > 3; });
  n.missing_info = Array.isArray(n.missing_info) ? n.missing_info : String(n.missingInfo || '').split(/[;,\n]/).filter(function(x) { return x.trim().length > 3; });
  n.followup_questions = Array.isArray(n.followup_questions) ? n.followup_questions : String(n.followupQuestions || '').split(/[;,\n]/).filter(function(x) { return x.trim().length > 3; });
  n.tests = Array.isArray(n.tests) ? n.tests : [];
  n.score = Math.max(0, Math.min(100, Number(n.score) || 0));
  n.rationale = String(n.rationale || '');
  n.risk = RISK_META[n.risk] ? n.risk : 'standard';
  return n;
}

function ruleBasedNote(pkg) {
  var text = ((pkg.narrative || '') + '\n' + (pkg.extractedTests || []).map(function(t) { return t.name + ' ' + t.value; }).join('\n')).toLowerCase();
  var found = { emergency: [], urgent: [], standard: [], routine: [] };
  Object.keys(SIGNALS).forEach(function(lvl) { SIGNALS[lvl].forEach(function(s) { if (new RegExp(s[0], 'i').test(text)) found[lvl].push({ label: s[2], weight: s[1] }); }); });
  var score = 50, highest = 'routine', rationaleParts = [];
  if (found.emergency.length) { score += found.emergency.reduce(function(a, b) { return a + b.weight * 15; }, 0); highest = 'emergency'; rationaleParts.push('Emergency signals: ' + found.emergency.map(function(f) { return f.label; }).join(', ')); }
  if (found.urgent.length) { score += found.urgent.reduce(function(a, b) { return a + b.weight * 8; }, 0); if (RISK_META[highest].order > RISK_META.urgent.order) highest = 'urgent'; rationaleParts.push('Urgent signals: ' + found.urgent.map(function(f) { return f.label; }).join(', ')); }
  if (found.standard.length) { score += found.standard.reduce(function(a, b) { return a + b.weight * 3; }, 0); if (RISK_META[highest].order > RISK_META.standard.order) highest = 'standard'; rationaleParts.push('Standard signals: ' + found.standard.map(function(f) { return f.label; }).join(', ')); }
  score = Math.min(100, Math.max(0, score));
  var complaints = ((pkg.narrative || '').split(/[.;]/).filter(function(x) { return x.trim().length > 5; }).slice(0, 4)) || [];
  if (!complaints.length) complaints = [text.slice(0, 80)];
  var tests = parseTestsFromText(text);
  return {
    risk: highest, score: score, summary: '(Rule-based draft — ' + highest + ') · ' + complaints[0].slice(0, 100),
    chief_complaints: complaints, timeline: 'Timeline extracted from the narrative at intake (auto).',
    expected_findings: 'Findings consistent with the reported chief complaint; verify clinically.',
    red_flags: found.emergency.concat(found.urgent).map(function(f) { return f.label; }),
    missing_info: ['Demographic completeness', 'Confirm consent', 'Clinical examination findings'],
    followup_questions: ['Onset & duration?', 'Prior episodes & triggers?', 'Current medications?'],
    tests: tests, rationale: rationaleParts.join('; ') || 'Derived from keyword-weighted signals.', fallback: 'rule-fallback'
  };
}
/* ---------- Follow-up scheduler ---------- */
function parseFollowUpDate(text) {
  if (!text) return null;
  // Matches "Follow-up date: 12-05-2020", "follow up on 12-May-2020", "follow‑up 12/05/20", "recall: 2020-05-12"
  var m = text.match(/(?:follow[\s-]?up[\s-]*(?:date)?|recall|re[- ]?visit|review)[\s:#-]*(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})/i);
  if (!m) return null;
  var y = Number(m[3]); if (y < 100) y += 2000;
  var mo = Number(m[2]) - 1, dd = Number(m[1]);
  if (mo < 0 || mo > 11 || dd < 1 || dd > 31) return null;
  var dt = new Date(y, mo, dd);
  if (isNaN(dt.getTime())) return null;
  return dt.getFullYear() + '-' + ('0' + (dt.getMonth() + 1)).slice(-2) + '-' + ('0' + dt.getDate()).slice(-2);
}
function followUpPill(item) {
  var fu = (item && item.followUpDate) || null; if (!fu) return '';
  var today = new Date(); today.setHours(0, 0, 0, 0);
  var d = new Date(fu + 'T00:00:00'); if (isNaN(d.getTime())) return '';
  d.setHours(0, 0, 0, 0);
  var diff = Math.floor((d - today) / 86400000);
  if (diff < 0) return { cls: 'triage-badge triage-badge-due', html: '<i class="fas fa-bell"></i> Follow-up overdue ' + (-diff) + 'd' };
  if (diff === 0) return { cls: 'triage-badge triage-badge-due', html: '<i class="fas fa-bell"></i> Follow-up due today' };
  return { cls: 'triage-badge', html: '<i class="fas fa-calendar-day"></i> Follow-up in ' + diff + 'd' };
}
function applyStructuredOCR(d) {
  // d = structured OCR payload from the LLM (response_json) — {document_type, summary,
  //     abnormal_flags, clinical_insight, key_values:[{name,value,unit,flag}] or ["Follow-up date: 12-05-2020", …]}
  var meta = { documentType: (d && d.document_type) || 'Lab / Report', summary: (d && d.summary) || '', abnormalFlags: (d && d.abnormal_flags) || [], clinicalInsight: (d && d.clinical_insight) || '' };
  var tests = [];
  var kvTxt = '';
  if (d && Array.isArray(d.key_values)) {
    d.key_values.forEach(function(kv) {
      if (!kv) return;
      var kvName = (typeof kv === 'string') ? kv : String(kv.name || '');
      var kvVal = (typeof kv === 'string') ? '' : (kv.value != null ? String(kv.value) : '');
      var kvUnit = (typeof kv === 'string') ? '' : (kv.unit || '').toString().trim();
      var kvFlag = (typeof kv === 'string') ? '' : (kv.flag || 'unknown').toString().toLowerCase();
      kvTxt += ' ' + kvName + ' ' + kvVal + ' ' + kvUnit;
      if (typeof kv !== 'string' && kvName) tests.push({ name: kvName, value: kvVal, unit: kvUnit, flag: kvFlag });
    });
  }
  var _fu = parseFollowUpDate(kvTxt + ' ' + ((d && d.summary) || ''));
  if (_fu) meta.followUpDate = _fu;
  return { meta: meta, tests: tests };
}
function parseTestsFromText(text) {
  var tests = [];
  var lines = text.split('\n');
  var pat = /([A-Za-z][\w\s]{2,40}?)\s*[:=]\s*([\d.]+)\s*(mm Hg|mg\/dL|g\/dL|%|\/mm3|mU\/mL|mmol\/L|IU\/L|U\/L|mcg\/dL|ng\/mL|x[0-9]|\+|-|present|absent|normal|high|low)?/gi;
  lines.forEach(function(l) { var m; while ((m = pat.exec(l)) !== null) { var name = m[1].trim(); var value = m[2].trim(); var unit = m[3] || ''; var flag = 'unknown'; if (/(critical|panic|!!|severely abnormal)/i.test(l)) flag = 'critical'; else if (/(high|elevated|↑|above)/i.test(l) && /value/i.test(l)) flag = 'high'; else if (/(low|↓|below)/i.test(l) && /value/i.test(l)) flag = 'low'; else if (/(normal|within|reference)/i.test(l)) flag = 'normal'; if (tests.length < 8) tests.push({ name: name, value: value, unit: unit, flag: flag }); } });
  return tests;
}

function applyNote(note) {
  state.note = note; state.session.note = note; state.session.risk = note.risk; state.session.score = note.score; state.session.summary = note.summary; state.session.chiefComplaints = note.chief_complaints; state.session.timeline = note.timeline; state.session.expectedFindings = note.expected_findings; state.session.redFlags = note.red_flags; state.session.missingInfo = note.missing_info; state.session.followupQuestions = note.followup_questions; state.session.tests = note.tests; state.session.sources = note.tests && note.tests.length ? note.tests.map(function(t) { return { name: t.name, value: t.value, unit: t.unit, flag: t.flag }; }) : [];
  renderNote();
}

function renderNote() {
  var note = state.note; if (!note) return;
  var rm = RISK_META[note.risk];
  var html = '<div class="triage-risk-banner triage-risk-banner-' + note.risk + '"><div class="triage-risk-banner-head"><div class="triage-risk-ident"><span class="triage-risk-dot triage-risk-dot-' + note.risk + '"></span><div><div class="triage-risk-label triage-risk-label-' + note.risk + '">' + esc(rm.label) + '</div><div class="triage-risk-priority">Priority based on intake signals · advisory only</div></div></div><div class="triage-risk-score"><div class="triage-risk-score-num">' + note.score + '</div><div class="triage-risk-score-label">Risk score</div></div></div><div class="triage-risk-rationale">' + esc(note.rationale || rm.label + ' · non-diagnostic advisory') + '</div></div>';
  html += '<div class="triage-note-grid-2"><div><div class="triage-note-section"><h4><i class="fas fa-file-medical"></i> Chief Complaints</h4><ul>' + (note.chief_complaints || []).map(function(c) { return '<li><span class="triage-num">•</span>' + esc(c) + '</li>'; }).join('') + '</ul></div><div class="triage-note-section"><h4><i class="fas fa-clock"></i> Timeline</h4><p>' + esc(note.timeline || '—') + '</p></div></div><div><div class="triage-note-section"><h4><i class="fas fa-glass"></i> Expected Findings</h4><p>' + esc(note.expected_findings || '—') + '</p></div><div class="triage-note-section"><h4><i class="fas fa-exclamation-triangle triage-redflag"></i> Red Flags</h4>' + (note.red_flags && note.red_flags.length ? '<ul>' + note.red_flags.map(function(f) { return '<li><span class="triage-num">•</span> <span class="triage-redflag">' + esc(f) + '</span></li>'; }).join('') + '</ul>' : '<p>No urgent signals detected.</p>') + '</div></div></div>';
  html += '<div class="triage-note-grid-2"><div><div class="triage-note-section"><h4><i class="fas fa-question-circle"></i> Missing Info</h4><ul>' + (note.missing_info || []).map(function(m) { return '<li><span class="triage-num">•</span><span class="triage-missing">' + esc(m) + '</span></li>'; }).join('') + '</ul></div><div class="triage-note-section"><h4><i class="fas fa-comments"></i> Follow-up Questions</h4>' + (note.followup_questions || []).map(function(q) { return '<span class="triage-chip">' + esc(q) + '</span>'; }).join('') + '</div></div>';
  if (note.tests && note.tests.length) { html += '<div class="triage-note-section"><h4><i class="fas fa-vial"></i> Extracted / Expected Findings</h4><div class="triage-finding-grid">'; note.tests.forEach(function(t) { html += '<div class="triage-finding-card"><div class="triage-finding-test">' + esc(t.name) + '</div><div class="triage-finding-value">' + esc(String(t.value)) + ' <span class="triage-flag-pill triage-flag-' + (t.flag || 'unknown') + '">' + esc(t.flag || 'unknown') + '</span></div></div>'; }); html += '</div></div>'; }
  html += (note.fallback === 'rule-fallback' ? '<p class="triage-hint" style="color:var(--amber);"><i class="fas fa-triangle-exclamation me-1"></i>Offline (rule-based) draft — the AI service is unavailable. Reviewer must verify.</p>' : '') + '</div>';
  $('#note-empty').style.display = 'none'; $('#note-loading').style.display = 'none'; $('#note-result').style.display = ''; $('#note-result').innerHTML = html;
}

/* ---------- Session persistence ---------- */
function saveSession() { if (!state.session) return; var arr = lsGet(SK(), []); var idx = arr.findIndex(function(s) { return s.id === state.session.id; }); if (idx >= 0) arr[idx] = state.session; else arr.unshift(state.session); lsSet(SK(), arr); }
function getSessions() { return lsGet(SK(), []); }
function addAudit(action, detail) { var arr = lsGet(AK(), []); arr.unshift({ id: uuid(), ts: new Date().toISOString(), action: action, detail: detail, actor: state.role + ':' + ($('#reviewer-role') ? $('#reviewer-role').value : '') }); if (arr.length > 200) arr.length = 200; lsSet(AK(), arr); }

function parseList(v) { if (Array.isArray(v)) return v; if (typeof v === 'string' && v) { try { var p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch (e) { return []; } } return []; }
function sessionPayload(s) {
  var consentEl = $('#consent');
  return { id: s.id, anonym_code: s.code || '', facility: s.facility || '', scenario: s.scenario || '', facility_name: s.facilityName || '', age_band: s.ageBand || '', sex: s.sex || '', lang: s.lang || '', narrative: s.narrative || '', risk: s.risk || 'standard', score: s.score || 0, summary: s.summary || '', timeline: s.timeline || '', chief_complaints: parseList(s.chiefComplaints), red_flags: parseList(s.redFlags), missing_info: parseList(s.missingInfo), followup_questions: parseList(s.followupQuestions), tests: parseList(s.tests), follow_up_date: s.followUpDate || null, consent: !!(consentEl && consentEl.checked), status: s.status || 'requested', src: s.src || 'local', created_at: s.createdAt || null };
}
function pushSession() {
  if (!state.session) return Promise.resolve();
  return fetch('/api/triage/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(sessionPayload(state.session)) })
    .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function(j) {
      if (j.status === 'ok' && j.session) {
        state.queueSessions = [j.session].concat(state.queueSessions.filter(function(x) { return x.id !== j.session.id; }));
      }
    })
    .catch(function() {});
}

function toggleGenerateState() {
  $('#generate-btn').disabled = true;
  var consent = ($('#consent') ? $('#consent').checked : false);
  var txt = ($('#symptoms') ? $('#symptoms').value.trim() : '');
  if (!consent || !txt) toggleGenerate();
}

function setIntakeError(msg) { var el = $('#intake-error'); if (!el) return; el.style.display = ''; el.innerHTML = '<i class="fas fa-circle-exclamation me-1"></i> ' + esc(msg); }
function hideIntakeError() { var el = $('#intake-error'); if (el) el.style.display = 'none'; }
function clearSymptoms() { if ($('#symptoms')) $('#symptoms').value = ''; toggleGenerate(); }

/* ---------- Queue ---------- */
/* ---------- Batch validation ---------- */
function toggleBatchBar() {
  state.batchBar = !state.batchBar; if (!state.batchBar) state.batchSelected = {};
  var btn = $('#batch-toggle'); if (btn) { btn.classList.toggle('is-active', state.batchBar); btn.innerHTML = state.batchBar ? '<i class="fas fa-xmark me-1"></i>Exit batch' : '<i class="fas fa-check-double me-1"></i>Batch validate'; }
  var bar = $('#batch-bar'); if (bar) bar.style.display = state.batchBar ? '' : 'none';
  renderQueue();
}
function batchCount() { var n = 0; for (var k in state.batchSelected) { if (state.batchSelected[k]) n++; } return n; }
function toggleBatchSel(code) { if (!state.batchBar) return; if (state.batchSelected[code]) delete state.batchSelected[code]; else state.batchSelected[code] = true; updateBatchBar(); renderQueue(); }
function updateBatchBar() {
  var cnt = batchCount(); var btn = $('#batch-validate-btn'); if (btn) { btn.disabled = !cnt; var lbl = btn.querySelector('span'); if (lbl) lbl.textContent = cnt; }
  var ci = $('#batch-count'); if (ci) ci.textContent = cnt;
  var msg = $('#batch-msg'); if (msg) msg.innerHTML = cnt ? '<i class="fas fa-clipboard-check me-1"></i>' + cnt + ' selected — will be marked completed.' : 'Select queue items using the checkboxes to batch-validate them.';
}
async function batchValidate() {
  var codes = Object.keys(state.batchSelected).filter(function(k) { return state.batchSelected[k]; }); if (!codes.length) { if ($('#batch-msg')) $('#batch-msg').innerHTML = '<i class="fas fa-circle-exclamation me-1"></i>Select at least one item.'; return; }
  state.session = null;
  var ok = 0;
  for (var i = 0; i < codes.length; i++) { try { await updateStatus(codes[i], 'completed'); ok++; } catch (e) {} }
  addAudit('batch_validate', 'Batch-validated ' + ok + ' of ' + codes.length + ' queue sessions.');
  state.batchSelected = {}; updateBatchBar(); toggleGenerate();
  try { await refreshQueue(); } catch (e) {}
}

async function refreshQueue() {
  if (!state.isStaff) return;
  $('#queue-skeleton').style.display = ''; $('#queue-list').innerHTML = '';
  try {
    var d = await fetch('/api/doctor/checkups', { credentials: 'include' });
    var j = await d.json();
    var all = (j.status === 'ok' && j.checkups) ? j.checkups : [];
    state.queueServer = all.filter(function(c) { return c.type !== 'triage'; });
    state.queueSessions = all.filter(function(c) { return c.type === 'triage'; });
  } catch (e) { state.queueServer = []; state.queueSessions = []; }
  state.queueLoaded = true; addAudit('queue_view', 'Reviewer queue refreshed (' + (state.queueServer.length + state.queueSessions.length) + ' server items).'); renderQueue();
}
function mergedQueue() {
  var items = []; var seen = {};
  state.queueSessions.forEach(function(s) {
    if (!s.id || seen[s.id]) return; seen[s.id] = true;
    items.push({ id: s.id, code: s.anonym_code || s.id.slice(0, 8), createdAt: s.created_at || s.createdAt || '', risk: s.risk || 'standard', score: s.score || 0, status: s.status || 'requested', src: 'server', type: 'triage', patient_id: s.user_id || null, patientName: s.patient_name || '', narrative: s.narrative || '', facility: s.facility || '', scenario: s.scenario || '', facilityName: s.facility_name || '', summary: s.summary || '', timeline: s.timeline || '', chiefComplaints: parseList(s.chief_complaints), redFlags: parseList(s.red_flags), missingInfo: parseList(s.missing_info), followupQuestions: parseList(s.followup_questions), tests: parseList(s.tests), followUpDate: s.follow_up_date || null });
  });
  state.queueServer.forEach(function(c) {
    if (!c.id || seen[c.id]) return; seen[c.id] = true;
    items.push({ id: c.id, code: c.id.slice(0, 8), createdAt: c.created_at, risk: 'standard', score: 0, status: c.status, src: 'server', type: 'checkup', patient_id: c.patient_id, patientName: c.patient_name || '', package: c.package, preferredDate: c.preferred_date, narrative: c.notes || '', facility: '' });
  });
  var local = getSessions().slice();
  local.forEach(function(s) {
    if (!s.id || seen[s.id]) return; seen[s.id] = true;
    items.push(Object.assign({}, s, { src: 'local', type: 'triage' }));
  });
  if (state.seedLoaded) addAudit('queue_seed', 'Demo cases present in queue (' + local.filter(function(s) { return s.src === 'local'; }).length + ' local).');
  items.sort(function(a, b) { var wa = RISK_META[a.risk] ? RISK_META[a.risk].order : 2; var wb = RISK_META[b.risk] ? RISK_META[b.risk].order : 2; if (wa !== wb) return wa - wb; return new Date(b.createdAt) - new Date(a.createdAt); });
  return items;
}
function riskWeight(r) { return RISK_META[r] ? RISK_META[r].weight : 0; }
function updateBadge() { if (state.isStaff) { var items = mergedQueue(); var cnt = items.filter(function(i) { return i.status === 'requested'; }).length; var el = $('#reviewer-badge'); if (el) { el.style.display = cnt ? '' : 'none'; el.textContent = cnt; } } }

function renderQueue() {
  var list = $('#queue-list'); if (!list) return;
  var fStatus = ($('#filter-status') ? $('#filter-status').value : '');
  var fRisk = ($('#filter-risk') ? $('#filter-risk').value : '');
  var items = mergedQueue().filter(function(i) { if (fStatus && i.status !== fStatus) return false; if (fRisk && i.risk !== fRisk) return false; return true; });
  var countEl = $('#queue-count'); if (countEl) countEl.textContent = items.length + ' session' + (items.length !== 1 ? 's' : '');
  if (!items.length) { list.innerHTML = '<div class="triage-empty"><i class="fas fa-inbox"></i><p>No sessions match the current filter.</p></div>'; return; }
  var html = '';
  items.forEach(function(item) {
    var rw = riskWeight(item.risk); var rm = RISK_META[item.risk]; var sm = STATUS_META[item.status] || STATUS_META.requested;
    var _fu = followUpPill(item); var fuHtml = (_fu && _fu.html) ? _fu.html : '';
    html += '<div class="triage-queue-row triage-queue-row-risk-' + item.risk + '"><button class="triage-queue-row-head" data-code="' + esc(item.code) + '"><span class="triage-queue-dot" style="background:' + rm.color + '"></span><div class="triage-queue-main"><div class="triage-queue-title"><span class="triage-code">' + esc(item.code) + '</span> <span class="triage-badge triage-badge-risk-' + item.risk + '">' + esc(rm.label) + '</span> <span class="triage-badge triage-badge-status">' + esc(sm.label) + '</span>' + fuHtml + (item.patientName ? '<span class="triage-badge">Patient</span>' : '') + '</div><div class="triage-queue-meta">' + fmtDate(item.createdAt) + ' · ' + esc(item.package || item.scenario || item.facility || '—') + ' · ' + esc(item.narrative || '').slice(0, 60) + '</div></div><span class="triage-queue-score" style="color:' + rm.color + '">' + item.score + '</span></button>' + (state.isStaff && state.batchBar ? '<label class="triage-queue-cb-wrap" title="Select for batch validation"><input type="checkbox" class="triage-queue-cb" data-code="' + esc(item.code) + '"' + (state.batchSelected[item.code] ? ' checked' : '') + '></label>' : '') + '</div>';
  });
  list.innerHTML = html;
  list.querySelectorAll('.triage-queue-row-head').forEach(function(btn) { btn.addEventListener('click', function() { var code = btn.getAttribute('data-code'); var item = mergedQueue().find(function(i) { return i.code === code; }); if (item) expandQueueItem(item); }); });
  list.querySelectorAll('.triage-queue-cb').forEach(function(cb) { cb.addEventListener('change', function() { var code = cb.getAttribute('data-code'); if (cb.checked) state.batchSelected[code] = true; else delete state.batchSelected[code]; updateBatchBar(); }); });
  updateBatchBar();
}

var expandedItem = null;
function expandQueueItem(item) { expandedItem = item; var rm = RISK_META[item.risk]; var sm = STATUS_META[item.status] || STATUS_META.requested; var _sum = item.summary || (state.note ? state.note.summary : ''); var html = '<div class="triage-note-section"><h4><i class="fas fa-file-medical"></i> Structured Triage Note</h4><p>' + (_sum ? esc(_sum) : '<em>No note generated for this item.</em>') + '</p></div>';
  html += '<div class="triage-note-section"><h4><i class="fas fa-history"></i> Timeline</h4><p>' + fmtDate(item.createdAt) + ' · Created via ' + item.src + ' session.</p>' + (item.timeline ? '<p>' + esc(item.timeline) + '</p>' : '') + '</div>';
  if (item.redFlags && item.redFlags.length) { html += '<div class="triage-note-section"><h4><i class="fas fa-flag"></i> Red Flags</h4><ul>' + item.redFlags.map(function(f) { return '<li>' + esc(f) + '</li>'; }).join('') + '</ul></div>'; }
  if (item.tests && item.tests.length) { html += '<div class="triage-note-section"><h4><i class="fas fa-vial"></i> Findings</h4>'; item.tests.forEach(function(t) { html += '<div class="triage-finding-card"><div class="triage-finding-test">' + esc(t.name) + '</div><div class="triage-finding-value">' + esc(String(t.value)) + ' ' + esc(t.unit) + ' <span class="triage-flag-pill triage-flag-' + (t.flag || 'unknown') + '">' + esc(t.flag || 'unknown') + '</span></div></div>'; }); html += '</div>'; }
  html += '<div class="triage-note-section"><h4><i class="fas fa-arrow-right-from-bracket"></i> Referral Prep</h4><div id="referral-preview"></div></div>';
  $('#referral-body').innerHTML = html;
  var modal = $('#referral-modal'); modal.style.display = '';
  var actions = '<div class="triage-queue-actions"><span class="triage-acting">Status:</span>';
  if (item.status && STATUS_META[item.status] && STATUS_META[item.status].next) {
    var nm = STATUS_META[item.status].next; actions += '<button class="btn-primary btn-sm" onclick="updateStatus(\'' + item.id + '\',\'' + nm + '\')">' + esc(STATUS_META[item.status].action) + '</button>';
  } else if (item.status === 'completed') { actions += '<button class="btn-outline btn-sm" onclick="updateStatus(\'' + item.id + '\',\'scheduled\')">Reopen</button>'; }
  if (item.patient_id) { actions += '<button class="btn-primary btn-sm" style="background:var(--amber);color:#fff;" onclick="openReferral(\'' + item.id + '\')"><i class="fas fa-arrow-right-from-bracket me-1"></i>Prepare referral note</button>'; }
  actions += '<button class="btn-outline btn-sm" onclick="closeReferral()">Close</button></div>';
  $('#referral-body').insertAdjacentHTML('beforeend', actions);
}

async function updateStatus(id, status) {
  var item = mergedQueue().find(function(i) { return i.id === id || i.code === id; }); if (!item) return;
  var prev = item.status;
  item.status = status;
  var arr = lsGet(SK(), []); var idx = arr.findIndex(function(s) { return s.id === item.id; }); if (idx >= 0) { arr[idx].status = status; lsSet(SK(), arr); }
  var si = state.queueSessions.findIndex(function(s) { return s.id === item.id; }); if (si >= 0) state.queueSessions[si].status = status;
  var ci = state.queueServer.findIndex(function(c) { return c.id === item.id; }); if (ci >= 0) state.queueServer[ci].status = status;
  addAudit('review_status', 'Session ' + (item.code || item.id) + ' moved from ' + prev + ' → ' + status + '.');
  renderQueue();
  function revert() {
    item.status = prev;
    var a2 = lsGet(SK(), []); var i2 = a2.findIndex(function(s) { return s.id === item.id; }); if (i2 >= 0) { a2[i2].status = prev; lsSet(SK(), a2); }
    var s2 = state.queueSessions.findIndex(function(s) { return s.id === item.id; }); if (s2 >= 0) state.queueSessions[s2].status = prev;
    var c2 = state.queueServer.findIndex(function(c) { return c.id === item.id; }); if (c2 >= 0) state.queueServer[c2].status = prev;
    renderQueue();
  }
  if (item.src === 'server') {
    var url = item.type === 'checkup' ? '/api/checkup/' + item.id : '/api/triage/session/' + item.id;
    try {
      var r = await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ status: status }) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
    } catch (e) { revert(); saveSession(); updateBadge(); return; }
  }
  saveSession(); updateBadge();
}

/* ---------- Referral ---------- */
function openReferral(itemId) {
  var item = mergedQueue().find(function(i) { return i.id === itemId; }); if (!item) return;
  var note = state.note || { summary: item.narrative || '', risk: item.risk, score: item.score };
  var md = '### Referral Note\n' + '- **Priority:** ' + (note.risk || 'standard').toUpperCase() + ' (' + (note.score || '—') + '/100)\n' + '- **Patient:** ' + esc(item.patientName || item.code || 'Anonymous') + '\n' + '- **Facility:** ' + esc(item.facilityName || state.facilityName || '—') + '\n' + '- **Summary:**\n' + '  > ' + esc(note.summary || '—') + '\n' + '- **Key info for receiving centre:**\n  - Chief complaints: ' + (note.chief_complaints || []).join(', ') + '\n' + '  - Red flags: ' + (note.red_flags || []).join(', ') + '\n' + '- **Transit precautions:** ' + (note.risk === 'emergency' ? 'Use fastest available emergency transport; notify receiving ED en route.' : note.risk === 'urgent' ? 'Priority transport; monitor en route.' : 'Routine referral scheduling.') + '\n' + '- **Disclaimer:** Advisory referral draft generated by an educational prototype; final clinical decisions remain with the qualified reviewer.';
  $('#referral-preview').innerHTML = '<div class="triage-referral-box triage-referral-amber"><div class="triage-referral-label">Referral preview</div><pre style="margin-top:4px;">' + esc(md) + '</pre></div>';
  if (item.patient_id) {
    var sendBtn = document.createElement('button'); sendBtn.className = 'btn-primary btn-sm'; sendBtn.style.marginTop = '10px'; sendBtn.innerHTML = '<i class="fas fa-paper-plane me-1"></i>Send referral to patient';
    sendBtn.addEventListener('click', function() { sendReferral(item); });
    $('#referral-body').appendChild(sendBtn);
  }
}
async function sendReferral(item) {
  if (!item.patient_id) { addAudit('referral', 'Demo referral drafted locally (no patient attached).'); closeReferral(); return; }
  var note = state.note || { summary: item.narrative || '' };
  var md = '### Referral Note\n- **Priority:** ' + (note.risk || 'standard').toUpperCase() + ' (' + (note.score || '—') + '/100)\n- **Patient:** ' + esc(item.patientName || '') + '\n- **Facility:** ' + esc(item.facilityName || '') + '\n- **Summary:**\n  > ' + esc(note.summary || '') + '\n- **Transit precautions:** ' + (note.risk === 'emergency' ? 'Fastest emergency transport.' : note.risk === 'urgent' ? 'Priority transport; monitor en route.' : 'Routine referral scheduling.') + '\n- **Disclaimer:** Advisory draft; final clinical decisions remain with the qualified reviewer.';
  try { var fd = new FormData(); fd.append('instruction_text', md); fd.append('patient_id', item.patient_id); var r = await fetch('/patient/instruction', { method: 'POST', body: fd, credentials: 'include' }); var j = await r.json(); addAudit('referral', 'Referral instruction sent to patient ' + item.patient_id + ' (' + (j.status === 'success' ? 'saved' : j.status) + ').'); closeReferral(); } catch (e) { addAudit('referral', 'Referral failed to send (network error).'); }
}
function closeReferral() { $('#referral-modal').style.display = 'none'; }

/* ---------- Analytics ---------- */
function renderAnalytics() {
  var el = $('#analytics-content'); if (!el) return;
  var items = mergedQueue(); var local = items.filter(function(i) { return i.src === 'local' || !i.src; });
  var total = items.length, emerg = items.filter(function(i) { return i.risk === 'emergency'; }).length, urg = items.filter(function(i) { return i.risk === 'urgent'; }).length;
  var completed = items.filter(function(i) { return i.status === 'completed'; }).length; var avg = total ? Math.round(items.reduce(function(a, b) { return a + (b.score || 0); }, 0) / total) : 0;
  el.innerHTML = '<div class="triage-kpi-grid"><div class="triage-kpi"><div class="triage-kpi-label">Sessions</div><div class="triage-kpi-value">' + total + '</div></div><div class="triage-kpi"><div class="triage-kpi-label">Emergency</div><div class="triage-kpi-value" style="color:#dc2626">' + emerg + '</div></div><div class="triage-kpi"><div class="triage-kpi-label">Urgent</div><div class="triage-kpi-value" style="color:#ea580c">' + urg + '</div></div><div class="triage-kpi"><div class="triage-kpi-label">Avg. score</div><div class="triage-kpi-value">' + avg + '</div></div></div>' +
    '<div class="triage-chart-grid"><div class="triage-chart-card" id="chart-bars"><h4><i class="fas fa-chart-bar"></i> Risk distribution</h4><div class="triage-bars" id="analytics-bars"></div></div><div class="triage-chart-card" id="chart-donut"><h4><i class="fas fa-chart-pie"></i> Risk mix</h4><div class="triage-donut-wrap" id="analytics-donut"></div></div><div class="triage-chart-card" id="chart-heat"><h4><i class="fas fa-table-cells"></i> Facility × Scenario</h4><div id="analytics-heatmap"></div></div><div class="triage-chart-card" id="chart-line"><h4><i class="fas fa-chart-line"></i> Sessions over time</h4><div id="analytics-line"></div></div></div><p class="triage-hint" style="margin-top:12px;"><i class="fas fa-shield-halved me-1 triage-teal"></i>All analytics are computed locally from the current triage log and server checkup list. No diagnostic conclusions are drawn.</p>';
  renderBars(items); renderDonut(items); renderHeatmap(items); renderLine(items);
}
function renderBars(items) {
  var el = $('#analytics-bars'); if (!el) return; var keys = ['emergency','urgent','standard','routine']; var max = Math.max(1, items.filter(function(i) { return keys.indexOf(i.risk) >= 0; }).length || 1);
  var html = ''; keys.forEach(function(k) { var cnt = items.filter(function(i) { return i.risk === k; }).length; var pct = Math.round(cnt / max * 100); var rm = RISK_META[k]; html += '<div class="triage-bar-row"><span>' + esc(rm.label) + '</span><div class="triage-bar-track"><div class="triage-bar-fill" style="width:' + pct + '%;background:' + rm.color + '"></div></div><span class="triage-bar-val">' + cnt + '</span></div>'; }); el.innerHTML = html;
}
function renderDonut(items) {
  var el = $('#analytics-donut'); if (!el) return; var keys = ['emergency','urgent','standard','routine']; var vals = keys.map(function(k) { return items.filter(function(i) { return i.risk === k; }).length; }); var total = vals.reduce(function(a, b) { return a + b; }, 0) || 1; var cx = 60, cy = 60, r = 50, r0 = 34, C = 2 * Math.PI * r, start = 0; var html = ''; var colors = ['#dc2626','#ea580c','#eab308','#10b981'];
  vals.forEach(function(v, i) { var len = (v / total) * C; if (len > 0) { html += '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="' + colors[i] + '" stroke-width="16" stroke-dasharray="' + len + ' ' + (C - len) + '" stroke-dashoffset="' + (-start) + '" transform="rotate(-90 ' + cx + ' ' + cy + ')"/>'; } start += len; });
  html += '<circle cx="' + cx + '" cy="' + cy + '" r="' + r0 + '" fill="var(--bg-raise)"/>'; html += '<div class="triage-donut-center"><b>' + total + '</b><span>total</span></div>'; html += '<div class="triage-legend">'; keys.forEach(function(k, i) { var c = vals[i]; html += '<div class="triage-legend-row"><span class="triage-legend-dot" style="background:' + colors[i] + '"></span>' + esc(RISK_META[k].label) + ' <b>' + c + '</b></div>'; }); html += '</div>'; el.innerHTML = '<div class="triage-donut">' + html + '</div>';
}
function renderHeatmap(items) {
  var el = $('#analytics-heatmap'); if (!el) return; var facilities = []; var scenarios = []; var seen = {}; items.forEach(function(i) { var f = i.facility || '—'; if (!seen[f]) { seen[f] = true; facilities.push(f); } var s = i.scenario || '—'; if (scenarios.indexOf(s) === -1) scenarios.push(s); }); var html = '<table class="triage-heatmap"><tr><th></th>'; scenarios.forEach(function(s) { html += '<th>' + esc(s) + '</th>'; }); html += '</tr>'; facilities.forEach(function(f) { html += '<tr><td class="triage-heatmap-rowlabel">' + esc(f) + '</td>'; scenarios.forEach(function(s) { var cnt = items.filter(function(i) { return (i.facility || '—') === f && (i.scenario || '—') === s; }).length; var cls = cnt === 0 ? 'triage-heatmap-zero' : cnt <= 2 ? 'triage-heatmap-light' : 'triage-heatmap-dark'; html += '<td class="' + cls + '">' + cnt + '</td>'; }); html += '</tr>'; }); el.innerHTML = html;
}
function renderLine(items) {
  var el = $('#analytics-line'); if (!el) return; var days = []; var now = new Date(); for (var i = 6; i >= 0; i--) { var d = new Date(now); d.setDate(d.getDate() - i); days.push(d.toLocaleDateString('en-IN', { month: 'short', day: 'numeric' })); }
  var vals = days.map(function(d) { return items.filter(function(it) { var dt = new Date(it.createdAt); return dt.toLocaleDateString('en-IN', { month: 'short', day: 'numeric' }) === d; }).length; }); var max = Math.max(1, Math.max.apply(null, vals)); var w = 280, h = 100, pad = 10; var pts = vals.map(function(v, i) { return (pad + (i / Math.max(1, vals.length - 1)) * (w - 2 * pad)) + ',' + (h - pad - (v / max) * (h - 2 * pad)); }).join(' '); var dots = vals.map(function(v, i) { var x = pad + (i / Math.max(1, vals.length - 1)) * (w - 2 * pad); var y = h - pad - (v / max) * (h - 2 * pad); return '<circle cx="' + x + '" cy="' + y + '" r="3" fill="#38BFA0"/>'; }).join('');
  var svg = '<svg viewBox="0 0 ' + w + ' ' + h + '"><polyline points="' + pts + '" fill="none" stroke="#38BFA0" stroke-width="2" stroke-linejoin="round"/></svg>';
  el.innerHTML = svg + '<div style="display:flex;justify-content:space-between;font-size:10px;color:var(--ink-faint);margin-top:4px;">' + days.map(function(d, i) { return '<span>' + d + ': ' + vals[i] + '</span>'; }).join('') + '</div>';
}

/* ---------- Audit ---------- */
function renderAudit() {
  var el = $('#audit-content'); if (!el) return;
  var entries = lsGet(AK(), []);
  if (!entries.length) { el.innerHTML = '<div class="triage-empty"><i class="fas fa-scroll"></i><p>No audit entries yet. Generate a note, consent, or take a review action to start logging.</p></div>'; return; }
  var icons = { consent_recorded: 'fa-shield-halved', session_created: 'fa-clipboard-list', ai_call: 'fa-wand-magic-sparkles', ocr: 'fa-file-image', review_status: 'fa-eye', referral: 'fa-arrow-right-from-bracket', queue_view: 'fa-filter', demo_loaded: 'fa-database' };
  var html = '<div class="triage-audit-trail">';
  entries.forEach(function(e) { var icon = icons[e.action] || 'fa-circle'; html += '<div class="triage-audit-line"><div class="triage-audit-icon"><i class="fas ' + esc(icon) + '"></i></div><div class="triage-audit-body"><div class="triage-audit-title"><span>' + esc(e.action.replace(/_/g, ' ')) + '</span> <span class="triage-audit-actor">' + esc(e.actor || state.role) + '</span> <span class="triage-audit-time">' + timeAgo(e.ts) + '</span></div><div class="triage-audit-detail">' + esc(e.detail) + '</div></div></div>'; });
  html += '</div>'; el.innerHTML = html;
}

/* ---------- History / Timeline ---------- */
function renderHistory() {
  var el = $('#history-content'); if (!el) return;
  if (state.role === 'patient') renderPatientTimeline(el); else renderStaffHistory(el);
}
function renderPatientTimeline(el) {
  var html = '<div class="triage-card"><div class="triage-card-head"><h3><i class="fas fa-clock me-2 triage-teal"></i>My Follow-ups</h3><span class="triage-card-sub">Your triage notes, chat exchanges, and instructions from doctors/nurses.</span></div><div id="patient-timeline"></div></div>';
  el.innerHTML = html; var wrap = $('#patient-timeline');
  var sessions = getSessions(); var html2 = '';
  if (!sessions.length && !state.queueServer.length) { html2 = '<div class="triage-empty"><i class="fas fa-history"></i><p>No follow-ups yet. Start with Triage Intake.</p></div>'; } else { html2 += '<div class="triage-history-metrics"><div class="triage-history-visit"><div class="triage-history-visit-head"><span class="triage-code">' + sessions.length + '</span><span>Your sessions</span></div></div></div>'; }
  sessions.slice(0, 20).forEach(function(s) { var rm = RISK_META[s.risk] || RISK_META.routine; html2 += '<div class="triage-history-visit" data-code="' + esc(s.code) + '"><div class="triage-history-visit-head"><span class="triage-code">' + esc(s.code) + '</span> <span class="triage-badge triage-badge-risk-' + s.risk + '">' + esc(rm.label) + '</span> <span class="triage-badge triage-badge-status">' + esc(s.status || 'requested') + '</span></div><div class="triage-history-visit-meta">' + fmtDate(s.createdAt) + ' · ' + esc(s.summary || s.narrative || '').slice(0, 80) + '</div></div>'; });
  wrap.innerHTML = html2; wrap.querySelectorAll('.triage-history-visit').forEach(function(v) { v.addEventListener('click', function() { var code = v.getAttribute('data-code'); var s = sessions.find(function(x) { return x.code === code; }); if (s && s.note) { state.note = s.note; state.session = s; renderNote(); } }); });
  fetch('/api/chat/history', { credentials: 'include' })
    .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function(j) {
      if (j.status === 'ok' && j.messages) {
        var msgs = j.messages.filter(function(m) { return m.role === 'user'; }).slice(-20);
        if (msgs.length) {
          wrap.insertAdjacentHTML('beforeend', '<div class="triage-note-section" style="margin-top:14px;"><h4><i class="fas fa-comments me-2"></i>Recent chat exchanges</h4>' + msgs.map(function(m) { return '<div style="margin-bottom:8px;"><strong>' + fmtDate(m.created_at) + ':</strong> ' + esc(m.content || '').slice(0, 200) + '</div>'; }).join('') + '</div>');
        }
      }
    })
    .catch(function() { wrap.insertAdjacentHTML('beforeend', '<div class="triage-empty" style="margin-top:14px;"><i class="fas fa-exclamation-triangle"></i><p>Could not load chat history.</p></div>'); });
  fetch('/api/patient/instructions', { credentials: 'include' })
    .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function(j) {
      if (j.status === 'ok' && j.instructions && j.instructions.length) {
        var html3 = '<div class="triage-note-section" style="margin-top:14px;"><h4><i class="fas fa-arrow-right-from-bracket me-2 triage-amber"></i>Instructions from reviewers</h4>';
        j.instructions.forEach(function(instr) { html3 += '<div class="triage-referral-box"><div class="triage-referral-label">Instruction</div><pre style="margin-top:4px;">' + esc(instr.instruction_text || '') + '</pre><div class="triage-muted" style="margin-top:4px;">' + fmtDate(instr.created_at) + '</div></div>'; });
        html3 += '</div>'; wrap.insertAdjacentHTML('beforeend', html3);
      }
    })
    .catch(function() { wrap.insertAdjacentHTML('beforeend', '<div class="triage-empty" style="margin-top:14px;"><i class="fas fa-exclamation-triangle"></i><p>Could not load instructions.</p></div>'); });
}
function renderStaffHistory(el) {
  var sessions = getSessions(); var codes = []; var seen = {}; sessions.forEach(function(s) { if (!seen[s.code]) { seen[s.code] = true; codes.push(s); } });
  var html = '<div class="triage-card"><div class="triage-card-head"><h3><i class="fas fa-history me-2 triage-teal"></i>Patient History</h3><span class="triage-card-sub">Review a patient by their anonymous code. Search or pick a code below.</span></div><div class="triage-history-search"><div class="form-group" style="flex:1;"><input class="triage-input" id="history-search" placeholder="Search by anonymous code (e.g. PT-2024-0001)…" oninput="filterHistoryCodes()"></div></div><div class="triage-history-codes" id="history-codes">' + codes.map(function(s) { return '<span class="triage-history-code" data-code="' + esc(s.code) + '">' + esc(s.code) + '</span>'; }).join('') + '</div></div><div id="history-visits"></div>';
  el.innerHTML = html;
}
function filterHistoryCodes() { var q = ($('#history-search') ? $('#history-search').value : '').toLowerCase(); $$('#history-codes .triage-history-code').forEach(function(c) { c.style.display = c.textContent.toLowerCase().indexOf(q) === -1 ? 'none' : ''; }); }

/* ---------- Book Call ---------- */
function bindBookCall() {
  state.bookCallDoctor = '';
  state.bookCallWeek = new Date(); state.bookCallWeek.setDate(state.bookCallWeek.getDate() - state.bookCallWeek.getDay() + 1);
  var el = $('#book-call-content'); if (!el) return;
  el.innerHTML = '<div style="display:flex;gap:14px;"><div style="width:220px;"><div class="triage-card-head"><h3><i class="fas fa-user-doctor me-2"></i>Doctors</h3></div><div id="book-call-doctors" style="max-height:500px;overflow-y:auto;"></div></div><div style="flex:1;"><div class="triage-card-head"><h3><i class="fas fa-calendar-days me-2"></i>Availability</h3><div class="triage-filters" style="margin-bottom:8px;"><button class="btn-outline btn-sm" onclick="shiftWeek(-1)"><i class="fas fa-chevron-left"></i></button> <span id="book-call-week-label" style="min-width:160px;text-align:center;"></span> <button class="btn-outline btn-sm" onclick="shiftWeek(1)"><i class="fas fa-chevron-right"></i></button></div><div id="book-call-calendar" style="overflow-x:auto;"></div></div></div><div class="triage-card" style="margin-top:10px;"><div class="triage-card-head"><h3><i class="fas fa-list me-2"></i>My Bookings</h3></div><div id="book-call-bookings"></div></div>';
  loadDoctors();
}
function shiftWeek(n) { state.bookCallWeek.setDate(state.bookCallWeek.getDate() + n * 7); renderCalendar(); }
async function loadDoctors() {
  try { var d = await fetch('/api/doctor/doctors', { credentials: 'include' }); var j = await d.json(); var doctors = (j.status === 'ok' && j.doctors) ? j.doctors : []; var html = ''; doctors.forEach(function(doc) { html += '<div class="triage-booking-doc' + (state.bookCallDoctor === doc.id ? ' is-active' : '') + '" data-id="' + esc(doc.id) + '" onclick="selectDoctor(\'' + esc(doc.id) + '\')"><div class="triage-badge triage-badge-risk-' + (doc.id ? 'standard' : 'routine') + '" style="cursor:pointer;">' + esc(doc.name || doc.email) + '</div><div class="triage-muted" style="font-size:11px;">' + esc(doc.qualification || '') + '</div></div>'; }); $('#book-call-doctors').innerHTML = html || '<div class="triage-empty"><i class="fas fa-user-doctor"></i><p>No doctors found.</p></div>'; } catch (e) { $('#book-call-doctors').innerHTML = '<div class="triage-empty"><p>Could not load doctors.</p></div>'; } }
function selectDoctor(id) { state.bookCallDoctor = id; loadDoctors(); renderCalendar(); }
function fmtDay(d) { return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()] + ' ' + (d.getMonth()+1) + '/' + d.getDate(); }
async function renderCalendar() {
  var el = $('#book-call-calendar'); if (!el || !state.bookCallDoctor) { if (el) el.innerHTML = '<div class="triage-empty"><p>Select a doctor.</p></div>'; return; }
  var weekStart = new Date(state.bookCallWeek); weekStart.setHours(0,0,0,0);
  var html = '<table style="width:100%;border-collapse:collapse;font-size:12px;"><tr><th style="padding:4px;text-align:left;">Time</th>';
  for (var i = 0; i < 7; i++) { var d = new Date(weekStart); d.setDate(d.getDate() + i); html += '<th style="padding:4px;text-align:center;">' + fmtDay(d) + '</th>'; }
  html += '</tr>';
  try {
    var resp = await fetch('/api/doctor/availability?doctor_id=' + encodeURIComponent(state.bookCallDoctor), { credentials: 'include' });
    var j = await resp.json(); var slots = (j.status === 'ok' && j.availability) ? j.availability : [];
    var availMap = {}; slots.forEach(function(s) { var key = s.date + '|' + s.start_time; (availMap[key] = availMap[key] || []).push(s); });
    var bResp = await fetch('/api/call/bookings', { credentials: 'include' });
    var bj = await bResp.json(); var bookings = (bj.status === 'ok' && bj.bookings) ? bj.bookings : [];
    var bookMap = {}; bookings.forEach(function(b) { var k = b.scheduled_at.split('T')[0]; (bookMap[k] = bookMap[k] || []).push(b); });
    var hours = ['08','09','10','11','12','13','14','15','16','17','18','19','20'];
    hours.forEach(function(h) {
      html += '<tr><td style="padding:3px;text-align:left;font-weight:600;">' + h + ':00</td>';
      for (var i = 0; i < 7; i++) { var d = new Date(weekStart); d.setDate(d.getDate() + i); var dateStr = d.toISOString().slice(0,10); var avail = availMap[dateStr + '|' + h + ':00']; var bs = bookMap[dateStr] || []; var booked = bs.filter(function(b) { return b.scheduled_at.slice(0,13) === dateStr + 'T' + h; }); var cellCls = booked.length ? 'triage-slot-booked' : (avail ? 'triage-slot-available' : ''); var btnTxt = booked.length ? booked.map(function(b){return b.status}).join(',') : (avail ? 'Book' : ''); var onclick = booked.length ? '' : (state.role === 'patient' ? "bookCallDoctorSlot('" + state.bookCallDoctor + "','" + dateStr + "','" + h + ":00')" : "toggleDocAvailability('" + state.bookCallDoctor + "','" + dateStr + "','" + h + ":00')"); html += '<td style="padding:3px;text-align:center;"><button class="triage-btn ' + cellCls + '" style="font-size:11px;padding:2px 6px;" onclick="' + onclick + '">' + btnTxt + '</button></td>'; }
      html += '</tr>';
    });
  } catch (e) {}
  html += '</table>'; el.innerHTML = html; $('#book-call-week-label').textContent = fmtDay(weekStart) + ' \u2014 ' + fmtDay(new Date(weekStart.getTime() + 6*86400000));
}
function bookCallDoctorSlot(doctorId, date, time) { fetch('/api/doctor/availability?doctor_id=' + encodeURIComponent(doctorId), { credentials: 'include' }).then(function(r){ return r.json(); }).then(function(j) { var slots = (j.status === 'ok' && j.availability) ? j.availability : []; var slot = slots.find(function(s) { return s.date === date && s.start_time === time; }); if (slot) { fetch('/api/call/book', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({doctor_id: doctorId, availability_id: slot.id, notes: ''}), credentials: 'include' }).then(function(r) { return r.json(); }).then(function(j) { if (j.status === 'ok') { loadBookings(); renderCalendar(); } }); } }); }
async function toggleDocAvailability(doctorId, date, time) { try { var j = await fetch('/api/doctor/availability', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({date: date, start_time: time, end_time: time+':30', max_slots: 1}), credentials: 'include' }).then(function(r){ return r.json(); }); if (j.status === 'ok') renderCalendar(); } catch (e) {} }
async function loadBookings() { try { var d = await fetch('/api/call/bookings', { credentials: 'include' }); var j = await d.json(); var bookings = (j.status === 'ok' && j.bookings) ? j.bookings : []; var html = ''; if (!bookings.length) { html = '<div class="triage-empty"><i class="fas fa-list"></i><p>No bookings yet.</p></div>'; } else { html = '<table style="width:100%;font-size:12px;"><tr><th>Doctor</th><th>Date/Time</th><th>Status</th><th></th></tr>'; bookings.forEach(function(b) { html += '<tr><td>' + esc(b.doctor_name || b.doctor_id) + '</td><td>' + esc(b.scheduled_at) + '</td><td><span class="triage-badge triage-badge-status">' + esc(b.status) + '</span></td><td>' + (b.status === 'requested' && state.role === 'patient' ? '<button class="btn-outline btn-sm" onclick="updateBookingStatus(\'' + b.id + '\',\'cancelled\')">Cancel</button>' : '') + '</td></tr>'; }); html += '</table>'; } $('#book-call-bookings').innerHTML = html; } catch (e) { $('#book-call-bookings').innerHTML = '<div class="triage-empty"><p>Could not load bookings.</p></div>'; } }
async function updateBookingStatus(bookingId, status) { try { var j = await fetch('/api/call/booking/' + bookingId, { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({status: status}), credentials: 'include' }).then(function(r){ return r.json(); }); if (j.status === 'success') { loadBookings(); renderCalendar(); } } catch (e) {} }

/* ---------- Demo seeds ---------- */
function seedDemo() {
  if (state.seedLoaded) return; state.seedLoaded = true; lsSet('triage.demoLoaded.' + state.role, true);
  var demos = [
    { code:'PT-2024-0001', risk:'emergency', score:92, status:'requested', scenario:'opd', facility:'public_govt', ageBand:'45-60', sex:'male', narrative:'62-year-old male presenting with acute onset crushing central chest pain radiating to the left arm for the past 45 minutes, associated with diaphoresis and shortness of breath.', redFlags:['acute chest pain','diaphoresis','radiating pain'] },
    { code:'PT-2024-0002', risk:'urgent', score:74, status:'requested', scenario:'fever', facility:'phc', ageBand:'15-44', sex:'female', narrative:'30-year-old female with high-grade fever for 5 days, headache, neck stiffness, and photophobia. Reports difficulty concentrating over the past 2 days.', redFlags:['persistent high fever','neck stiffness','photophobia'] },
    { code:'PT-2024-0003', risk:'standard', score:52, status:'scheduled', scenario:'chronic', facility:'public_govt', ageBand:'60+', sex:'male', narrative:'68-year-old male with known diabetes and hypertension, presenting for routine NCD follow-up. Reports occasional dizziness and increased thirst over the past week.', redFlags:[] },
    { code:'PT-2024-0004', risk:'routine', score:28, status:'completed', scenario:'routine', facility:'phc', ageBand:'45-60', sex:'female', narrative:'50-year-old female attending for a general health checkup as part of an occupational health screening. No significant complaints reported.', redFlags:[] },
    { code:'PT-2024-0005', risk:'emergency', score:88, status:'requested', scenario:'fever', facility:'community', ageBand:'0-5', sex:'male', narrative:'3-year-old male child brought with high fever, difficulty breathing, and reduced oral intake for 2 days. Appears lethargic.', redFlags:['lethargy','difficulty breathing','reduced oral intake'] },
    { code:'PT-2024-0006', risk:'urgent', score:66, status:'requested', scenario:'referral', facility:'industrial', ageBand:'15-44', sex:'male', narrative:'40-year-old male factory worker with severe abdominal pain radiating to the back, nausea, and vomiting for the past 12 hours.', redFlags:['severe abdominal pain','radiating to back','vomiting'] },
    { code:'PT-2024-0007', risk:'standard', score:44, status:'scheduled', scenario:'maternal', facility:'public_govt', ageBand:'15-44', sex:'female', narrative:'28-year-old pregnant female (third trimester) presenting with lower back pain and mild swelling of ankles for the past week. No vaginal bleeding.', redFlags:[] },
    { code:'PT-2024-0008', risk:'routine', score:22, status:'completed', scenario:'followup', facility:'private_clinic', ageBand:'60+', sex:'female', narrative:'65-year-old female with hypothyroidism and hypertension attending for a routine medication review and health education on diet and exercise.', redFlags:[] }
  ];
  demos.forEach(function(d) { d.id = uuid(); d.createdAt = new Date(Date.now() - Math.floor(Math.random() * 7 * 86400000)).toISOString(); d.extractedTests = []; d.facilityName = ''; d.src = 'local'; d.patient_id = null; d.narrative = d.narrative; d.tests = []; d.chief_complaints = [d.narrative.split('.')[0]]; d.timeline = 'Onset described at intake.'; d.expected_findings = 'Consistent with chief complaint.'; d.red_flags = d.redFlags || []; d.missing_info = ['Clinical examination']; d.followup_questions = ['Onset & duration?', 'Prior episodes?']; d.summary = '(Demo) ' + d.narrative.slice(0, 80); d.rationale = 'Demo scenario.'; d.fallback = 'demo'; });
  var arr = getSessions(); demos.forEach(function(d) { var idx = arr.findIndex(function(s) { return s.code === d.code; }); if (idx >= 0) arr[idx] = d; else arr.unshift(d); }); lsSet(SK(), arr); addAudit('demo_loaded', '8 synthetic demo triage cases loaded into the queue.'); refreshQueue();
}

/* ---------- Actions binding ---------- */
function bindActions() {
  // tabs
  $$('.triage-tab').forEach(function(t) { t.addEventListener('click', function() { switchTab(t.getAttribute('data-tab')); }); });
  // facility change
  var ft = $('#facility-type'); if (ft) ft.addEventListener('change', onFacilityChange);
  // consent toggle
  var cs = $('#consent'); if (cs) cs.addEventListener('change', toggleGenerate);
  // seed btn
  var sb = $('#seed-btn'); if (sb) sb.addEventListener('click', seedDemo);
  // new intake
  var ni = $('#new-intake-btn'); if (ni) ni.addEventListener('click', resetIntake);
  // filter
  ['filter-status', 'filter-risk'].forEach(function(id) { var el = document.getElementById(id); if (el) el.addEventListener('change', renderQueue); });
}
function switchTab(name) {
  $$('.triage-tab').forEach(function(t) { t.classList.toggle('is-active', t.getAttribute('data-tab') === name); });
  $$('.triage-tabpanel').forEach(function(p) { p.classList.toggle('is-active', p.id === 'tab-' + name); });
  if (name === 'reviewer') refreshQueue();
  if (name === 'analytics') renderAnalytics();
  if (name === 'audit') renderAudit();
  if (name === 'history') renderHistory();
  if (name === 'book-call') { loadDoctors(); loadBookings(); }
}
function onFacilityChange(v) { state.facility = v; state.scenario = ($('#scenario') ? $('#scenario').value : ''); populateScenarioSelect(); }
function resetIntake() { if ($('#symptoms')) $('#symptoms').value = ''; if ($('#anon-code')) $('#anon-code').value = ''; if ($('#consent')) $('#consent').checked = false; if ($('#extracts')) $('#extracts').innerHTML = ''; if ($('#upload-area')) $('#upload-area').style.display = 'none'; state.extractedTests = []; state.note = null; state.session = null; $('#note-result').innerHTML = ''; $('#note-empty').style.display = ''; $('#note-loading').style.display = 'none'; $('#note-result').style.display = 'none'; $('#new-intake-btn').style.display = 'none'; $('#open-queue-btn').style.display = 'none'; toggleGenerate(); }

function bindThemeLogout() { /* placeholder — functions defined above */ }

/* ---------- Hero stats ---------- */
function renderHeroStats() {
  var el = $('#hero-stats'); if (!el) return;
  if (state.isStaff) { var items = mergedQueue(); var e = items.filter(function(i) { return i.risk === 'emergency'; }).length; var u = items.filter(function(i) { return i.risk === 'urgent'; }).length; var c = items.filter(function(i) { return i.status === 'completed'; }).length; el.innerHTML = '<div class="triage-stat"><div class="triage-stat-label"><i class="fas fa-clipboard-list"></i> Sessions</div><div class="triage-stat-value">' + items.length + '</div></div><div class="triage-stat"><div class="triage-stat-label"><i class="fas fa-exclamation-triangle"></i> Emergency</div><div class="triage-stat-value" style="color:#dc2626">' + e + '</div></div><div class="triage-stat"><div class="triage-stat-label"><i class="fas fa-triangle-exclamation"></i> Urgent</div><div class="triage-stat-value" style="color:#ea580c">' + u + '</div></div><div class="triage-stat"><div class="triage-stat-label"><i class="fas fa-circle-check"></i> Completed</div><div class="triage-stat-value" style="color:#10b981">' + c + '</div></div>'; } else { var ss = getSessions(); el.innerHTML = '<div class="triage-stat"><div class="triage-stat-label"><i class="fas fa-clipboard-list"></i> Sessions</div><div class="triage-stat-value">' + ss.length + '</div></div><div class="triage-stat"><div class="triage-stat-label"><i class="fas fa-wand-magic-sparkles"></i> Notes</div><div class="triage-stat-value">' + ss.filter(function(s) { return s.note; }).length + '</div></div><div class="triage-stat"><div class="triage-stat-label"><i class="fas fa-file-image"></i> OCR</div><div class="triage-stat-value">' + ss.filter(function(s) { return s.extractedTests && s.extractedTests.length; }).length + '</div></div><div class="triage-stat"><div class="triage-stat-label"><i class="fas fa-shield-halved"></i> Consent</div><div class="triage-stat-value">' + (localStorage.getItem('triage.consent.' + state.role) ? 'Yes' : 'No') + '</div></div>'; }
}

/* ---------- Boot ---------- */
if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); } else { init(); }
