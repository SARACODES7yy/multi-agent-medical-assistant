/* SWASTHYA PRATHAM — Triage client logic (port). Wires intake, OCR, AI note, queue, referral, analytics, audit, timeline to existing backend endpoints. */
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
/* i18n alias — falls back to returning the key if i18n.js is unavailable */
var t = (typeof window.t === 'function') ? window.t : function(k) { return k; };

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
    ['dangerous|not improving|getting worse|worsening', 1, 'Condition worsening'], ['severe pain|excruciating pain', 1, 'Severe pain'],
    ['weight loss|unintentional weight loss', 1, 'Unintentional weight loss'], ['cancer|malignancy|carcinoma|tumor|neoplasm|metastatic|metastasis|oncology', 2, 'Suspected malignancy']
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
  syncBookCallTabLabel();
  populateFacilitySelect();
  populateLangSelect();
  if (typeof populateUiLangSelect === 'function') populateUiLangSelect($('#ui-lang'));
  if (typeof applyI18n === 'function') applyI18n();
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
  loadNotifications();
  document.addEventListener('click', function(e) { var w = $('#notif-panel'); if (w && w.style.display !== 'none' && !e.target.closest('.triage-notif-wrap')) w.style.display = 'none'; });
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

/* ---------- Scenario workflows (suggested questions + guidance) ---------- */
var SCENARIO_WORKFLOW = {
  opd:        { ask: ['When did symptoms start?', 'Any chest pain or breathlessness?', 'Current medications?'], guide: 'Triage OPD arrivals by red-flag symptoms first; book diagnostics before consultation when red flags are absent.' },
  fever:      { ask: ['Fever for how many days?', 'Any rash or bleeding gums?', 'Recent travel or mosquito exposure?'], guide: 'Check dengue warning signs (belly pain, bleeding, persistent vomiting). Escalate immediately on any warning sign.' },
  maternal:   { ask: ['Gestational age?', 'Fetal movements normal?', 'Any bleeding or leaking?'], guide: 'Any bleeding, severe headache, blurred vision or reduced fetal movement → emergency referral this visit.' },
  chronic:    { ask: ['Last BP / HbA1c reading?', 'Adherence to current drugs?', 'New symptoms since last visit?'], guide: 'Focus on adherence and control metrics; flag missing labs as missing-info before closing the note.' },
  routine:    { ask: ['Main complaint today?', 'Duration of symptoms?', 'Any fever or weight loss?'], guide: 'Standard OPD flow — record complaint, vitals, then decide self-care, pharmacy or labs.' },
  immunization:{ ask: ['Child age and last vaccine date?', 'Any fever today?', 'Allergy to any vaccine?'], guide: 'Follow the national schedule; screen for contraindications (high fever, severe allergy) before administering.' },
  referral:   { ask: ['Why is higher-centre care needed?', 'Vitals stable for transit?', 'Records and medicines packed?'], guide: 'Complete the referral checklist, record transit precautions, and send the referral note with the patient.' },
  hearing:    { ask: ['Noise exposure history?', 'Any ringing or hearing loss?', 'Ear discharge or pain?'], guide: 'Occupational screening — log exposure duration and recommend audiometry when symptomatic.' },
  mobility:   { ask: ['How did the injury happen?', 'Can the worker bear weight?', 'Numbness or deformity?'], guide: 'Rule out fracture/nerve injury before clearance; document site, mechanism and work restriction.' },
  roster:     { ask: ['Shift pattern this week?', 'Excessive sleepiness?', 'Any chest pain or palpitations?'], guide: 'Night-shift triage — screen for fatigue risk and hypertension; advise work-hour limits when symptomatic.' },
  fever_camp: { ask: ['Fever days and max temperature?', 'Rash or joint pain?', 'Vomiting or bleeding?'], guide: 'Camp flow — rapid risk stratification, test suspects, refer warning-sign cases the same day.' },
  hostel:     { ask: ['Symptoms in room-mates?', 'Fever or sore throat?', 'Appetite and sleep ok?'], guide: 'Watch for clustered respiratory/GI illness; isolate and inform the campus health officer if clustering.' },
  mental:     { ask: ['Mood and sleep over 2 weeks?', 'Any self-harm thoughts?', 'Support system at home?'], guide: 'Non-judgemental screening; any self-harm ideation → immediate supervisor referral and safety plan.' },
  followup:   { ask: ['Any new symptoms since last visit?', 'Medicines taken regularly?', 'Side effects reported?'], guide: 'Review control of the chronic condition; adjust only via the qualified reviewer, never here.' },
  screening:  { ask: ['Any current symptoms?', 'Last screening date?', 'Family history of note?'], guide: 'Camp screening — capture vitals and key history; list abnormal results as missing-info requiring lab confirmation.' },
  eye:        { ask: ['Blurred vision since when?', 'Eye pain or flashes?', 'Diabetes or known eye disease?'], guide: 'Sudden vision loss or pain is emergency — same-day ophthalmology referral.' }
};
function renderScenarioBanner() {
  var banner = $('#scenario-banner'); if (!banner) return;
  var key = state.scenario;
  var wf = SCENARIO_WORKFLOW[key];
  var labels = {}; (SCENARIO_LABELS[state.facility] || []).forEach(function(p) { labels[p[0]] = p[1]; });
  var nameEl = $('#scenario-banner-name');
  if (nameEl) nameEl.textContent = labels[key] || key || '';
  var chips = $('#scenario-ask-chips'); var guide = $('#scenario-guide-text');
  if (!wf) { banner.style.display = 'none'; return; }
  banner.style.display = '';
  if (chips) {
    chips.innerHTML = wf.ask.map(function(q) { return '<button type="button" class="triage-chip" data-q="' + esc(q) + '"><i class="fas fa-plus me-1"></i>' + esc(q) + '</button>'; }).join('');
    chips.querySelectorAll('.triage-chip').forEach(function(c) {
      c.addEventListener('click', function() {
        var q = c.getAttribute('data-q') || '';
        var ta = $('#symptoms');
        if (ta) { ta.value = (ta.value ? ta.value.replace(/\s+$/, '') + ' ' : '') + q; toggleGenerate(); ta.focus(); }
      });
    });
  }
  if (guide) guide.textContent = wf.guide;
  if (typeof applyI18n === 'function') applyI18n();
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
  sel.onchange = function() { state.scenario = sel.value; renderScenarioBanner(); };
  renderScenarioBanner();
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
  ['dragenter', 'dragover'].forEach(function(ev) {
    dz.addEventListener(ev, function(e) { e.preventDefault(); dz.classList.add('is-dragover'); });
  });
  ['dragleave', 'drop'].forEach(function(ev) {
    dz.addEventListener(ev, function(e) { e.preventDefault(); dz.classList.remove('is-dragover'); });
  });
  dz.addEventListener('drop', function(e) {
    var files = Array.prototype.slice.call(e.dataTransfer.files || []);
    if (files.length) handleFiles(files);
  });
  fi.addEventListener('change', function() {
    var files = Array.prototype.slice.call(fi.files || []);
    if (files.length) handleFiles(files);
    fi.value = '';
  });
}
var OCR_QUEUE = [];
function ocrQueuedCount() { return OCR_QUEUE.filter(function(f) { return f.status === 'queued' || f.status === 'processing'; }).length; }
function renderFileQueue() {
  var q = $('#file-queue'); if (!q) return;
  if (!OCR_QUEUE.length) { q.innerHTML = ''; q.style.display = 'none'; return; }
  q.style.display = '';
  q.innerHTML = OCR_QUEUE.map(function(f, i) {
    var icon = f.ext === 'pdf' ? 'fa-file-pdf' : 'fa-file-image';
    var statusHtml = '';
    if (f.status === 'processing') statusHtml = '<div class="triage-file-progress"><div class="triage-file-progress-fill" style="width:' + (f.progress || 0) + '%"></div></div>';
    if (f.status === 'done') statusHtml = '<span class="triage-file-status triage-file-status-ok"><i class="fas fa-circle-check"></i> ' + (f.testCount != null ? f.testCount + ' findings' : 'Processed') + '</span>';
    if (f.status === 'error') statusHtml = '<span class="triage-file-status triage-file-status-err"><i class="fas fa-circle-xmark"></i> ' + esc(f.error || 'Failed') + '</span>';
    return '<div class="triage-file-chip">' +
      '<i class="fas ' + icon + ' triage-file-icon"></i>' +
      '<div class="triage-file-info"><div class="triage-file-name" title="' + esc(f.name) + '">' + esc(f.name) + '</div>' +
      '<div class="triage-file-size">' + f.sizeText + '</div></div>' +
      statusHtml +
      (f.status === 'queued' || f.status === 'processing' ? '' : '<button class="triage-file-remove" data-idx="' + i + '" title="Remove"><i class="fas fa-xmark"></i></button>') +
      '</div>';
  }).join('');
  q.querySelectorAll('.triage-file-remove').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var idx = parseInt(btn.getAttribute('data-idx'), 10);
      var f = OCR_QUEUE[idx];
      if (!f || f.status === 'processing') return;
      OCR_QUEUE.splice(idx, 1);
      state.extractedTests = state.extractedTests.filter(function(t) { return t._file !== f.name; });
      renderFileQueue(); toggleGenerate();
    });
  });
}
function ocrFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return Math.round(bytes / 1024) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}
function handleFiles(fileList) {
  var errEl = $('#upload-error');
  var files = Array.prototype.slice.call(fileList || []);
  var accepted = [];
  var rejected = [];
  files.forEach(function(file) {
    var ext = (file.name.split('.').pop() || '').toLowerCase();
    if (['png', 'jpg', 'jpeg', 'pdf'].indexOf(ext) === -1) { rejected.push(file.name + ' — unsupported type'); return; }
    var max = ext === 'pdf' ? 10 * 1048576 : 5 * 1048576;
    if (file.size > max) { rejected.push(file.name + ' — too large (max ' + (ext === 'pdf' ? '10' : '5') + 'MB)'); return; }
    accepted.push(file);
  });
  if (rejected.length && errEl) { errEl.innerHTML = '<i class="fas fa-triangle-exclamation"></i> ' + rejected.join('<br>'); errEl.style.display = ''; }
  else if (errEl) errEl.style.display = 'none';
  accepted.forEach(function(file) {
    var ext = (file.name.split('.').pop() || '').toLowerCase();
    var rec = { name: file.name, ext: ext, size: file.size, sizeText: ocrFileSize(file.size), status: 'queued', progress: 0, testCount: null, error: '' };
    OCR_QUEUE.push(rec);
    renderFileQueue();
    processFile(file, rec);
  });
  toggleGenerate();
}
function processFile(file, rec) {
  rec.status = 'processing'; renderFileQueue();
  var fd = new FormData(); fd.append('file', file);
  var xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/ocr');
  xhr.withCredentials = true;
  xhr.upload.addEventListener('progress', function(e) {
    if (e.lengthComputable) { rec.progress = Math.min(95, Math.round((e.loaded / e.total) * 95)); renderFileQueue(); }
  });
  xhr.addEventListener('load', function() {
    var d = null;
    try { d = xhr.responseText ? JSON.parse(xhr.responseText) : null; } catch (e) { d = null; }
    if (xhr.status !== 200 || !d || d.status !== 'success') {
      var detail = (d && d.detail) || ('Server error HTTP ' + xhr.status);
      rec.status = 'error'; rec.error = ocrFriendlyError(detail, xhr.status);
      renderFileQueue(); toggleGenerate();
      return;
    }
    var parsed = applyStructuredOCR(d);
    var tests = parsed.tests;
    state.extractedOCRMeta = parsed.meta;
    if (parsed.meta.followUpDate && !state.pendingFollowUpDate) {
      state.pendingFollowUpDate = parsed.meta.followUpDate;
      addAudit('followup_scheduled', 'Follow-up scheduled for ' + state.pendingFollowUpDate + ' from OCR follow-up line.');
    }
    tests.forEach(function(t) {
      t._file = file.name;
      if (!state.extractedTests.find(function(e) { return e.name === t.name && e.value === t.value; })) state.extractedTests.push(t);
    });
    var docTypeLabel = parsed.meta.documentType || 'Lab / Report';
    var html = '<div class="triage-finding-card"><div class="triage-finding-test">' + esc(docTypeLabel) + ' <span class="triage-finding-src">from ' + esc(file.name) + '</span></div></div>';
    if (parsed.meta.abnormalFlags && parsed.meta.abnormalFlags.length) html += '<div class="triage-finding-card"><div class="triage-finding-test">Abnormal Flags</div><div class="triage-finding-value">' + parsed.meta.abnormalFlags.map(function(f) { return '<span class="triage-flag-pill triage-flag-critical">' + esc(f) + '</span>'; }).join(' ') + '</div></div>';
    tests.forEach(function(t) { html += '<div class="triage-finding-card"><div class="triage-finding-test">' + esc(t.name) + '</div><div class="triage-finding-value">' + esc(String(t.value)) + ' ' + esc(t.unit) + ' <span class="triage-flag-pill triage-flag-' + esc(t.flag) + '">' + esc(t.flag) + '</span></div></div>'; });
    if (parsed.meta.summary) html += '<div class="triage-finding-card"><div class="triage-finding-test">AI Summary</div><div class="triage-finding-value" style="white-space:pre-wrap;">' + esc(parsed.meta.summary) + '</div></div>';
    if (parsed.meta.clinicalInsight) html += '<div class="triage-finding-card"><div class="triage-finding-test">Clinical Insight</div><div class="triage-finding-value" style="white-space:pre-wrap;">' + esc(parsed.meta.clinicalInsight) + '</div></div>';
    var ex = $('#extracts');
    if (ex) {
      if (!ex.dataset.fileIndex) ex.dataset.fileIndex = '0';
      var fi2 = parseInt(ex.dataset.fileIndex, 10);
      if (fi2 === 0 && !ex.dataset.init) { ex.innerHTML = ''; ex.dataset.init = '1'; }
      ex.insertAdjacentHTML('beforeend', html);
      ex.dataset.fileIndex = String(fi2 + 1);
    }
    rec.status = 'done'; rec.progress = 100; rec.testCount = tests.length;
    addAudit('ocr', 'OCR processed ' + file.name + ' — ' + tests.length + ' findings extracted.');
    renderFileQueue(); toggleGenerate();
  });
  xhr.addEventListener('error', function() {
    rec.status = 'error'; rec.error = 'Network error during upload.';
    renderFileQueue(); toggleGenerate();
  });
  xhr.send(fd);
}
function ocrFriendlyError(raw, status) {
  var s = String(raw || '');
  if (status === 502 || status === 504) return 'Server timed out — try again in a moment.';
  if (status === 413) return 'File too large (max 5MB images, 10MB PDF).';
  if (status === 400) return 'Could not read document — upload a clear photo or standard PDF.';
  if (s.indexOf('timeout') >= 0) return 'Analysis timed out — try again in a moment.';
  return s.slice(0, 90) || 'Upload failed. Please try again.';
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
  var missing = note.missing_info || [];
  var followups = note.followup_questions || [];
  var html = '<div class="triage-risk-banner triage-risk-banner-' + note.risk + '"><div class="triage-risk-banner-head"><div class="triage-risk-ident"><span class="triage-risk-dot triage-risk-dot-' + note.risk + '"></span><div><div class="triage-risk-label triage-risk-label-' + note.risk + '">' + esc(rm.label) + '</div><div class="triage-risk-priority">Priority based on intake signals · advisory only</div></div></div><div class="triage-risk-score"><div class="triage-risk-score-num">' + note.score + '</div><div class="triage-risk-score-label">Risk score</div></div></div><div class="triage-risk-rationale">' + esc(note.rationale || rm.label + ' · non-diagnostic advisory') + '</div></div>';
  html += '<div class="triage-queue-title" style="margin:2px 0 8px;">';
  if (!note.fallback) html += '<span class="triage-badge" title="Summarized by the AI pipeline (Groq &rarr; OpenRouter &rarr; Cloudflare &rarr; Gemini) with automatic provider fallback"><i class="fas fa-wand-magic-sparkles me-1"></i>' + esc(t('note.aiBadge')) + '</span> ';
  else if (note.fallback === 'demo') html += '<span class="triage-badge" title="Demo scenario"><i class="fas fa-flask me-1"></i>Demo</span> ';
  if (missing.length) html += '<span class="triage-badge triage-badge-missing"><i class="fas fa-circle-question me-1"></i>' + esc(t('queue.missing')) + ' · ' + missing.length + '</span> ';
  if (followups.length) html += '<span class="triage-badge triage-badge-followup"><i class="fas fa-comments me-1"></i>' + esc(t('queue.followups')) + ' · ' + followups.length + '</span>';
  html += '</div>';
  html += '<div class="triage-note-grid-2"><div><div class="triage-note-section"><h4><i class="fas fa-file-medical"></i> ' + esc(t('note.chief')) + '</h4><ul>' + (note.chief_complaints || []).map(function(c) { return '<li><span class="triage-num">•</span>' + esc(c) + '</li>'; }).join('') + '</ul></div><div class="triage-note-section"><h4><i class="fas fa-clock"></i> ' + esc(t('note.timeline')) + '</h4><p>' + esc(note.timeline || '—') + '</p></div></div><div><div class="triage-note-section"><h4><i class="fas fa-glass"></i> ' + esc(t('note.findings')) + '</h4><p>' + esc(note.expected_findings || '—') + '</p></div><div class="triage-note-section"><h4><i class="fas fa-exclamation-triangle triage-redflag"></i> ' + esc(t('note.redFlags')) + '</h4>' + (note.red_flags && note.red_flags.length ? '<ul>' + note.red_flags.map(function(f) { return '<li><span class="triage-num">•</span> <span class="triage-redflag">' + esc(f) + '</span></li>'; }).join('') + '</ul>' : '<p>' + esc(t('note.noUrgent')) + '</p>') + '</div></div></div>';
  html += '<div class="triage-note-grid-2"><div><div class="triage-note-section"><h4><i class="fas fa-question-circle"></i> ' + esc(t('note.missing')) + (missing.length ? ' <span class="triage-badge triage-badge-missing">' + missing.length + '</span>' : '') + '</h4>' + (missing.length ? '<ul class="triage-question-list">' + missing.map(function(m) { return '<li class="triage-q-missing"><i class="fas fa-circle-exclamation"></i><span>' + esc(m) + '</span></li>'; }).join('') + '</ul>' : '<p>None flagged — intake looks complete.</p>') + '</div><div class="triage-note-section"><h4><i class="fas fa-comments"></i> ' + esc(t('note.followup')) + (followups.length ? ' <span class="triage-badge triage-badge-followup">' + followups.length + '</span>' : '') + '</h4>' + (followups.length ? '<ul class="triage-question-list">' + followups.map(function(q, qi) { return '<li data-qidx="' + qi + '"><i class="fas fa-circle-question"></i><label class="triage-question-check-wrap" style="display:flex;gap:7px;align-items:flex-start;flex:1;"><input type="checkbox" class="triage-question-check"><span>' + esc(q) + '</span></label></li>'; }).join('') + '</ul>' : '<p>No follow-up questions queued.</p>') + '</div></div>';
  if (note.tests && note.tests.length) { html += '<div class="triage-note-section"><h4><i class="fas fa-vial"></i> ' + esc(t('note.extracted')) + '</h4><div class="triage-finding-grid">'; note.tests.forEach(function(t2) { html += '<div class="triage-finding-card"><div class="triage-finding-test">' + esc(t2.name) + '</div><div class="triage-finding-value">' + esc(String(t2.value)) + ' <span class="triage-flag-pill triage-flag-' + (t2.flag || 'unknown') + '">' + esc(t2.flag || 'unknown') + '</span></div></div>'; }); html += '</div></div>'; }
  html += (note.fallback === 'rule-fallback' ? '<p class="triage-hint" style="color:var(--amber);"><i class="fas fa-triangle-exclamation me-1"></i>Offline (rule-based) draft — the AI service is unavailable. Reviewer must verify.</p>' : '') + '<div id="note-translated" style="display:none;"></div></div>';
  $('#note-empty').style.display = 'none'; $('#note-loading').style.display = 'none'; $('#note-result').style.display = ''; $('#note-result').innerHTML = html;
  var tb = $('#note-translate-btn'); if (tb) tb.style.display = '';
  $('#note-result').querySelectorAll('.triage-question-check').forEach(function(cb) {
    cb.addEventListener('change', function() { cb.closest('li').classList.toggle('triage-question-done', cb.checked); });
  });
}
function notePlainText(note) {
  var lines = ['RISK: ' + ((RISK_META[note.risk] || {}).label || note.risk) + ' (score ' + (note.score || 0) + '/100)'];
  if (note.summary) lines.push('SUMMARY: ' + note.summary);
  if ((note.chief_complaints || []).length) lines.push('CHIEF COMPLAINTS: ' + note.chief_complaints.join('; '));
  if (note.timeline) lines.push('TIMELINE: ' + note.timeline);
  if (note.expected_findings) lines.push('EXPECTED FINDINGS: ' + note.expected_findings);
  if ((note.red_flags || []).length) lines.push('RED FLAGS: ' + note.red_flags.join('; '));
  if ((note.missing_info || []).length) lines.push('MISSING INFO: ' + note.missing_info.join('; '));
  if ((note.followup_questions || []).length) lines.push('FOLLOW-UP QUESTIONS: ' + note.followup_questions.join('; '));
  return lines.join('\n');
}
function translateNote() {
  var note = state.note; if (!note) return;
  var box = $('#note-translated'); if (!box) return;
  if (box.style.display !== 'none') { box.style.display = 'none'; return; }
  var target = (typeof currentLang === 'function') ? currentLang() : 'en';
  if (target === 'en') { target = 'hi'; }
  box.style.display = ''; box.innerHTML = '<div class="triage-referral-box triage-referral-amber"><div class="triage-referral-label"><span data-i18n="note.translating">' + esc(t('note.translating')) + '</span></div></div>';
  translateText(notePlainText(note), target).then(function(out) {
    if (out === notePlainText(note)) {
      box.innerHTML = '<div class="triage-referral-box"><div class="triage-referral-label">' + esc(t('note.translateFail')) + '</div></div>';
    } else {
      box.innerHTML = '<div class="triage-referral-box"><div class="triage-referral-label">' + esc(t('chat.translatedTo') + ' ' + (typeof targetLangName === 'function' ? targetLangName(target) : target)) + '</div><pre style="margin-top:6px;white-space:pre-wrap;">' + esc(out) + '</pre></div>';
    }
  }).catch(function() {
    box.innerHTML = '<div class="triage-referral-box"><div class="triage-referral-label">' + esc(t('note.translateFail')) + '</div></div>';
  });
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
  var all = [];
  try {
    var d = await fetch('/api/doctor/worklist', { credentials: 'include' });
    var j = await d.json();
    if (j.status === 'ok' && j.worklist) all = j.worklist;
  } catch (e) {}
  if (!all.length) {
    try {
      var d2 = await fetch('/api/doctor/checkups', { credentials: 'include' });
      var j2 = await d2.json();
      all = (j2.status === 'ok' && j2.checkups) ? j2.checkups : [];
    } catch (e) { all = []; }
  }
  state.queueServer = all.filter(function(c) { return c.type !== 'triage'; });
  state.queueSessions = all.filter(function(c) { return c.type === 'triage'; });
  checkCriticalLabs(all);
  state.queueLoaded = true; addAudit('queue_view', 'Reviewer queue refreshed (' + (state.queueServer.length + state.queueSessions.length) + ' server items).'); renderQueue();
}
function checkCriticalLabs(items) {
  var keys = {};
  (items || []).forEach(function(i) { if ((i.lab_severity || 0) >= 2) keys[i.id || i.code] = (i.patient_name || i.anonym_code || i.code || 'unknown patient'); });
  var prev = state.lastCriticalLabs || {};
  var now = Date.now(), TTL = 6 * 3600 * 1000;
  var seen = lsGet('triage.crit.seen', {});
  Object.keys(seen).forEach(function(k) { if (now - seen[k] > TTL) delete seen[k]; });
  Object.keys(keys).forEach(function(k) { if (!prev[k] && !seen[k]) { showToast('<i class="fas fa-vial-circle-check me-1"></i><strong>Critical lab result:</strong> ' + esc(keys[k]), true); seen[k] = now; } });
  state.lastCriticalLabs = keys;
  lsSet('triage.crit.seen', seen);
}
function showToast(html, sticky) {
  var wrap = $('#toast-wrap'); if (!wrap) return;
  while (wrap.children.length >= 3) { wrap.removeChild(wrap.firstElementChild); }
  var t = document.createElement('div');
  t.className = 'triage-toast' + (sticky ? ' triage-toast-critical' : '');
  t.innerHTML = html + '<button class="triage-toast-close" onclick="this.parentNode.remove()"><i class="fas fa-times"></i></button>';
  wrap.appendChild(t);
  setTimeout(function() { if (t.parentNode) t.remove(); }, sticky ? 12000 : 6000);
}
/* ---------- Queue prioritization (pinned order + drag/arrows) ---------- */
function pinnedKey() { return 'triage.pinned.' + (state.role || 'patient'); }
function getPinned() { var v = lsGet(pinnedKey(), []); return Array.isArray(v) ? v : []; }
function setPinned(arr) { lsSet(pinnedKey(), arr); }
/* First manual reorder snapshots the current displayed order into pins,
   so drag/arrows behave exactly like reordering the visible list. */
function ensurePinOrder() {
  var visible = state._visibleCodes || [];
  var p = getPinned().filter(function(c) { return visible.indexOf(c) >= 0; });
  var seen = {}; p.forEach(function(c) { seen[c] = 1; });
  visible.forEach(function(c) { if (!seen[c]) { seen[c] = 1; p.push(c); } });
  return p;
}
function pinBefore(code, targetCode) {
  var p = ensurePinOrder().filter(function(c) { return c !== code; });
  var idx = targetCode ? p.indexOf(targetCode) : -1;
  if (idx >= 0) p.splice(idx, 0, code); else p.unshift(code);
  setPinned(p);
  addAudit('queue_prioritize', 'Session ' + code + ' dragged to priority position.');
  renderQueue();
}
function moveQueueItem(code, dir) {
  var visible = state._visibleCodes || [];
  var i = visible.indexOf(code); if (i < 0) return;
  var j = dir === 'up' ? i - 1 : i + 1;
  if (j < 0 || j >= visible.length) return;
  var p = ensurePinOrder();
  var pi = p.indexOf(code); var pj = p.indexOf(visible[j]);
  if (pi < 0 || pj < 0) return;
  p.splice(pi, 1);
  p.splice(pj, 0, code);
  setPinned(p);
  addAudit('queue_prioritize', 'Session ' + code + ' moved ' + dir + ' (manual priority).');
  renderQueue();
}
function clearPinnedQueue() {
  setPinned([]);
  addAudit('queue_prioritize', 'Cleared manual priority pins.');
  renderQueue();
}

function mergedQueue() {
  var items = []; var seen = {};
  state.queueSessions.forEach(function(s) {
    if (!s.id || seen[s.id]) return; seen[s.id] = true;
    items.push({ id: s.id, code: s.anonym_code || s.id.slice(0, 8), createdAt: s.created_at || s.createdAt || '', risk: s.risk || 'standard', score: s.score || 0, status: s.status || 'requested', src: 'server', type: 'triage', patient_id: s.user_id || null, patientName: s.patient_name || '', narrative: s.narrative || '', facility: s.facility || '', scenario: s.scenario || '', facilityName: s.facility_name || '', ageBand: s.age_band || '', sex: s.sex || '', summary: s.summary || '', timeline: s.timeline || '', chiefComplaints: parseList(s.chief_complaints), redFlags: parseList(s.red_flags), missingInfo: parseList(s.missing_info), followupQuestions: parseList(s.followup_questions), tests: parseList(s.tests), followUpDate: s.follow_up_date || null, labFlags: s.lab_flags || [], labSeverity: s.lab_severity || 0 });
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
  /* Manual priority: pinned codes first, in pinned order (risk order for the rest). */
  var pins = getPinned();
  if (pins.length) {
    var byCode = {}; items.forEach(function(it) { if (it.code) byCode[it.code] = it; });
    var top = [], rest = [];
    pins.forEach(function(c) { if (byCode[c] && top.indexOf(byCode[c]) < 0) top.push(byCode[c]); });
    items.forEach(function(it) { if (top.indexOf(it) === -1) rest.push(it); });
    items = top.concat(rest);
  }
  return items;
}
function riskWeight(r) { return RISK_META[r] ? RISK_META[r].weight : 0; }
function updateBadge() { if (state.isStaff) { var items = mergedQueue(); var cnt = items.filter(function(i) { return i.status === 'requested'; }).length; var el = $('#reviewer-badge'); if (el) { el.style.display = cnt ? '' : 'none'; el.textContent = cnt; } } }

function renderQueue() {
  var list = $('#queue-list'); if (!list) return;
  var skel = $('#queue-skeleton'); if (skel) skel.style.display = 'none';
  var emptyEl = $('#queue-empty');
  var fStatus = ($('#filter-status') ? $('#filter-status').value : '');
  var fRisk = ($('#filter-risk') ? $('#filter-risk').value : '');
  var items = mergedQueue().filter(function(i) { if (fStatus && i.status !== fStatus) return false; if (fRisk && i.risk !== fRisk) return false; return true; });
  state._visibleCodes = items.map(function(i) { return i.code; });
  var pins = getPinned();
  var pinbar = $('#queue-pinbar');
  if (pinbar) {
    var active = pins.filter(function(c) { return state._visibleCodes.indexOf(c) >= 0; }).length;
    pinbar.style.display = active > 1 ? '' : 'none';
    var pc = $('#queue-pincount'); if (pc) pc.textContent = active;
  }
  var countEl = $('#queue-count'); if (countEl) countEl.textContent = items.length + ' session' + (items.length !== 1 ? 's' : '');
  if (!items.length) { list.innerHTML = ''; if (emptyEl) emptyEl.style.display = ''; return; }
  if (emptyEl) emptyEl.style.display = 'none';
  var html = '';
  items.forEach(function(item) {
    var rw = riskWeight(item.risk); var rm = RISK_META[item.risk]; var sm = STATUS_META[item.status] || STATUS_META.requested;
    var _fu = followUpPill(item); var fuHtml = (_fu && _fu.html) ? _fu.html : '';
    var labBadge = '';
    if (item.labSeverity >= 2) labBadge = '<span class="triage-badge triage-lab-critical" title="Critical lab result"><i class="fas fa-vial-circle-check me-1"></i>Critical lab</span>';
    else if (item.labSeverity === 1) labBadge = '<span class="triage-badge triage-lab-abnormal" title="Abnormal lab result"><i class="fas fa-vial me-1"></i>Abnormal lab</span>';
    var missN = (item.missingInfo || []).length, fuN = (item.followupQuestions || []).length;
    var missBadge = missN ? '<span class="triage-badge triage-badge-missing" title="Missing information"><i class="fas fa-circle-question me-1"></i>' + missN + ' missing</span>' : '';
    var fuBadge = fuN ? '<span class="triage-badge triage-badge-followup" title="Follow-up questions"><i class="fas fa-comments me-1"></i>' + fuN + ' follow-ups</span>' : '';
    var isPinned = pins.indexOf(item.code) >= 0;
    var chips = fuHtml + labBadge + missBadge + fuBadge;
    var metaBits = fmtDate(item.createdAt) + ' · ' + esc(item.package || item.scenario || item.facility || '—');
    var story = esc(item.narrative || item.summary || '').slice(0, 100);
    html += '<div class="triage-queue-row triage-queue-row-risk-' + item.risk + '" draggable="true" data-code="' + esc(item.code) + '" title="Drag to reprioritize">'
      + '<div class="triage-queue-tools">'
      + '<button class="triage-pin-btn' + (isPinned ? ' is-active' : '') + '" data-pin="' + esc(item.code) + '" title="' + (isPinned ? esc(t('queue.clearPin')) : esc(t('queue.moveTop'))) + '"><i class="fas fa-thumbtack"></i></button>'
      + '<div class="triage-queue-prio"><button class="triage-prio-btn" data-act="up" data-code="' + esc(item.code) + '" title="' + esc(t('queue.moveUp')) + '"><i class="fas fa-chevron-up"></i></button>'
      + '<button class="triage-prio-btn" data-act="down" data-code="' + esc(item.code) + '" title="' + esc(t('queue.moveDown')) + '"><i class="fas fa-chevron-down"></i></button></div></div>'
      + '<button class="triage-queue-row-head" data-code="' + esc(item.code) + '"><div class="triage-queue-main"><div class="triage-queue-title"><span class="triage-queue-story" title="' + story + '">' + story + '</span><span class="triage-code">' + esc(item.code) + '</span> <span class="triage-badge triage-badge-risk-' + item.risk + '">' + esc(rm.label) + '</span> <span class="triage-queue-status">' + esc(sm.label) + '</span></div><div class="triage-queue-meta">' + (chips ? '<span class="triage-queue-chips">' + chips + '</span>' : '') + metaBits + '</div></div><span class="triage-queue-score" style="color:' + rm.color + '">' + item.score + '</span></button>'
      + (state.isStaff && state.batchBar ? '<label class="triage-queue-cb-wrap" title="Select for batch validation"><input type="checkbox" class="triage-queue-cb" data-code="' + esc(item.code) + '"' + (state.batchSelected[item.code] ? ' checked' : '') + '></label>' : '') + '</div>';
  });
  list.innerHTML = html;
  list.querySelectorAll('.triage-queue-row-head').forEach(function(btn) { btn.addEventListener('click', function() { var code = btn.getAttribute('data-code'); var item = mergedQueue().find(function(i) { return i.code === code; }); if (item) expandQueueItem(item); }); });
  list.querySelectorAll('.triage-queue-cb').forEach(function(cb) { cb.addEventListener('change', function() { var code = cb.getAttribute('data-code'); if (cb.checked) state.batchSelected[code] = true; else delete state.batchSelected[code]; updateBatchBar(); }); });
  list.querySelectorAll('.triage-prio-btn').forEach(function(btn) {
    btn.addEventListener('click', function(e) { e.stopPropagation(); moveQueueItem(btn.getAttribute('data-code'), btn.getAttribute('data-act')); });
  });
  list.querySelectorAll('.triage-pin-btn').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      var code = btn.getAttribute('data-pin');
      var p = getPinned();
      if (p.indexOf(code) >= 0) setPinned(p.filter(function(c) { return c !== code; }));
      else setPinned([code].concat(p.filter(function(c) { return c !== code; })));
      renderQueue();
    });
  });
  /* Drag & drop reprioritization */
  var dragCode = null;
  list.querySelectorAll('.triage-queue-row').forEach(function(row) {
    row.addEventListener('dragstart', function(e) { dragCode = row.getAttribute('data-code'); row.classList.add('is-dragging'); try { e.dataTransfer.setData('text/plain', dragCode); e.dataTransfer.effectAllowed = 'move'; } catch (err) {} });
    row.addEventListener('dragend', function() { dragCode = null; row.classList.remove('is-dragging'); list.querySelectorAll('.is-dropbefore').forEach(function(r) { r.classList.remove('is-dropbefore'); }); });
    row.addEventListener('dragover', function(e) { if (!dragCode) return; e.preventDefault(); row.classList.add('is-dropbefore'); });
    row.addEventListener('dragleave', function() { row.classList.remove('is-dropbefore'); });
    row.addEventListener('drop', function(e) {
      e.preventDefault(); row.classList.remove('is-dropbefore');
      var code = dragCode || (e.dataTransfer && e.dataTransfer.getData('text/plain'));
      var target = row.getAttribute('data-code');
      if (code && target && code !== target) pinBefore(code, target);
    });
  });
  updateBatchBar();
}

var expandedItem = null;
function buildItemTimeline(item) {
  var evts = [{ icon: 'fa-clipboard-list', when: item.createdAt, title: 'Intake created', text: (item.narrative || '').slice(0, 140), risk: item.risk }];
  if (item.timeline) evts.push({ icon: 'fa-clock', when: item.createdAt, title: 'Symptom timeline', text: item.timeline, risk: item.risk });
  if ((item.tests || []).length) evts.push({ icon: 'fa-vial', when: item.createdAt, title: 'Lab / OCR findings', text: item.tests.map(function(t2) { return t2.name + ' ' + t2.value + (t2.unit ? ' ' + t2.unit : ''); }).join(' · ').slice(0, 160), risk: 'standard' });
  if (item.followUpDate) evts.push({ icon: 'fa-calendar-check', when: item.followUpDate, title: 'Follow-up due', text: 'Scheduled follow-up date for this session.', risk: 'routine' });
  if (item.status && item.status !== 'requested') evts.push({ icon: 'fa-eye', when: item.createdAt, title: 'Status: ' + item.status, text: 'Current review status of this session.', risk: item.risk });
  evts.sort(function(a, b) { return new Date(a.when || 0) - new Date(b.when || 0); });
  return '<ul class="triage-timeline">' + evts.map(function(e) {
    return '<li class="triage-timeline-item triage-timeline-item-risk-' + (RISK_META[e.risk] ? e.risk : 'standard') + '">'
      + '<span class="triage-timeline-dot"><i class="fas ' + e.icon + '"></i></span>'
      + '<div class="triage-timeline-when">' + esc(fmtDate(e.when)) + '</div>'
      + '<div class="triage-timeline-title">' + esc(e.title) + '</div>'
      + (e.text ? '<div class="triage-timeline-text">' + esc(e.text) + '</div>' : '') + '</li>';
  }).join('') + '</ul>';
}
function expandQueueItem(item) { expandedItem = item; var rm = RISK_META[item.risk]; var sm = STATUS_META[item.status] || STATUS_META.requested; var _sum = item.summary || (state.note ? state.note.summary : ''); var html = '<div class="triage-note-section"><h4><i class="fas fa-file-medical"></i> ' + esc(t('expand.note')) + '</h4><p>' + (_sum ? esc(_sum) : '<em>' + esc(t('expand.noNote')) + '</em>') + '</p></div>';
  html += '<div class="triage-note-section"><h4><i class="fas fa-history"></i> ' + esc(t('expand.timeline')) + '</h4>' + buildItemTimeline(item) + '<p class="triage-muted" style="margin-top:6px;">' + fmtDate(item.createdAt) + ' · ' + esc(t('expand.createdVia')) + ' ' + esc(item.src) + ' ' + esc(t('expand.session')) + '</p>' + (item.timeline && item.timeline.length > 140 ? '<p>' + esc(item.timeline) + '</p>' : '') + '</div>';
  if (item.redFlags && item.redFlags.length) { html += '<div class="triage-note-section"><h4><i class="fas fa-flag"></i> Red Flags</h4><ul>' + item.redFlags.map(function(f) { return '<li>' + esc(f) + '</li>'; }).join('') + '</ul></div>'; }
  if (item.missingInfo && item.missingInfo.length) {
    html += '<div class="triage-note-section"><h4><i class="fas fa-circle-question"></i> ' + esc(t('expand.missing')) + ' <span class="triage-badge triage-badge-missing">' + item.missingInfo.length + '</span></h4><ul class="triage-question-list">' + item.missingInfo.map(function(m) { return '<li class="triage-q-missing"><i class="fas fa-circle-exclamation"></i><span>' + esc(m) + '</span></li>'; }).join('') + '</ul></div>';
  }
  if (item.followupQuestions && item.followupQuestions.length) {
    html += '<div class="triage-note-section"><h4><i class="fas fa-comments"></i> ' + esc(t('expand.followup')) + ' <span class="triage-badge triage-badge-followup">' + item.followupQuestions.length + '</span></h4><ul class="triage-question-list">' + item.followupQuestions.map(function(q) { return '<li><i class="fas fa-circle-question"></i><label style="display:flex;gap:7px;align-items:flex-start;flex:1;"><input type="checkbox" class="triage-question-check"><span>' + esc(q) + '</span></label></li>'; }).join('') + '</ul></div>';
  }
  if (item.tests && item.tests.length) { html += '<div class="triage-note-section"><h4><i class="fas fa-vial"></i> Findings</h4>'; item.tests.forEach(function(t2) { html += '<div class="triage-finding-card"><div class="triage-finding-test">' + esc(t2.name) + '</div><div class="triage-finding-value">' + esc(String(t2.value)) + ' ' + esc(t2.unit) + ' <span class="triage-flag-pill triage-flag-' + (t2.flag || 'unknown') + '">' + esc(t2.flag || 'unknown') + '</span></div></div>'; }); html += '</div>'; }
  html += '<div class="triage-note-section"><h4><i class="fas fa-arrow-right-from-bracket"></i> ' + esc(t('expand.referralPrep')) + '</h4><div id="referral-preview"></div></div>';
  $('#referral-body').innerHTML = html;
  var modal = $('#referral-modal'); modal.style.display = '';
  var actions = '<div class="triage-queue-actions"><span class="triage-acting">Status:</span>';
  if (item.status && STATUS_META[item.status] && STATUS_META[item.status].next) {
    var nm = STATUS_META[item.status].next; actions += '<button class="btn-primary btn-sm" onclick="updateStatus(\'' + item.id + '\',\'' + nm + '\')">' + esc(STATUS_META[item.status].action) + '</button>';
  } else if (item.status === 'completed') { actions += '<button class="btn-outline btn-sm" onclick="updateStatus(\'' + item.id + '\',\'scheduled\')">Reopen</button>'; }
  if (item.patient_id) { actions += '<button class="btn-primary btn-sm" style="background:var(--amber);color:#fff;" onclick="openReferral(\'' + item.id + '\')"><i class="fas fa-arrow-right-from-bracket me-1"></i>Prepare referral note</button>'; }
  if (item.type === 'triage' && item.src === 'server') { actions += '<button class="btn-primary btn-sm" onclick="openSoap(\'' + item.id + '\')"><i class="fas fa-file-medical me-1"></i>SOAP</button>'; }
  if (item.patient_id) { actions += '<button class="btn-primary btn-sm" style="background:var(--violet,#7c3aed);color:#fff;" onclick="openRx(\'' + item.id + '\')"><i class="fas fa-prescription me-1"></i>Rx</button>'; }
  if (item.patient_id) { actions += '<button class="btn-primary btn-sm" style="background:var(--amber,#d97706);color:#fff;" onclick="createInvoice(\'' + item.id + '\',\'' + item.patient_id + '\')"><i class="fas fa-file-invoice-dollar me-1"></i>Invoice</button>'; }
  actions += '<button class="btn-outline btn-sm" onclick="closeReferral()">Close</button></div>';
  $('#referral-body').insertAdjacentHTML('beforeend', actions);
  $('#referral-body').querySelectorAll('.triage-question-check').forEach(function(cb) {
    cb.addEventListener('change', function() { cb.closest('li').classList.toggle('triage-question-done', cb.checked); });
  });
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
function referralChecklist(item, note) {
  var tests = note.tests || item.tests || [];
  var checks = [
    { ok: !!(item.ageBand || item.sex || item.patientName), key: 'referral.check.demographics' },
    { ok: tests.length > 0, key: 'referral.check.reports' },
    { ok: tests.length > 0, key: 'referral.check.vitals' },
    { ok: false, key: 'referral.check.medications' },
    { ok: false, key: 'referral.check.allergies' }
  ];
  return '<ul class="triage-referral-checklist">' + checks.map(function(c) {
    return '<li class="' + (c.ok ? 'ok' : 'todo') + '"><i class="fas ' + (c.ok ? 'fa-circle-check' : 'fa-circle') + '"></i><span>' + esc(t(c.key)) + (c.ok ? '' : ' — verify before sending') + '</span></li>';
  }).join('') + '</ul>';
}
function openReferral(itemId) {
  var item = mergedQueue().find(function(i) { return i.id === itemId; }); if (!item) return;
  var note = { summary: item.summary || (state.note && state.note.summary) || item.narrative || '', risk: item.risk || (state.note && state.note.risk) || 'standard', score: item.score || (state.note && state.note.score) || 0, chief_complaints: item.chiefComplaints || [], red_flags: item.redFlags || [] };
  var transit = note.risk === 'emergency' ? t('referral.transitEmergency') : note.risk === 'urgent' ? t('referral.transitUrgent') : t('referral.transitRoutine');
  var md = '### Referral Note\n' + '- **' + t('referral.priority') + ':** ' + (note.risk || 'standard').toUpperCase() + ' (' + (note.score || '—') + '/100)\n' + '- **' + t('referral.patient') + ':** ' + esc(item.patientName || item.code || 'Anonymous') + '\n' + '- **' + t('referral.facility') + ':** ' + esc(item.facilityName || state.facilityName || '—') + '\n' + '- **' + t('referral.summary') + ':**\n  > ' + esc(note.summary || '—') + '\n' + '- **' + t('referral.keyInfo') + ':**\n  - ' + t('referral.chief') + ': ' + (note.chief_complaints || []).join(', ') + '\n' + '  - ' + t('referral.redFlags') + ': ' + (note.red_flags || []).join(', ') + '\n' + '- **' + t('referral.transit') + ':** ' + transit + '\n' + '- **Disclaimer:** ' + t('referral.disclaimer');
  var box = document.createElement('div');
  box.innerHTML = '<div class="triage-referral-box triage-referral-amber"><div class="triage-referral-label">' + esc(t('referral.preview')) + '</div>'
    + '<div style="margin-top:8px;"><strong>' + esc(t('referral.checklist')) + '</strong>' + referralChecklist(item, note) + '</div>'
    + '<div class="triage-referral-transit"><i class="fas fa-truck-medical"></i><strong>' + esc(t('referral.transit')) + ':</strong> ' + esc(transit) + '</div>'
    + '<pre style="margin-top:8px;white-space:pre-wrap;">' + esc(md) + '</pre></div>';
  $('#referral-preview').innerHTML = '';
  $('#referral-preview').appendChild(box);
  var btnRow = document.createElement('div');
  btnRow.className = 'triage-queue-actions';
  btnRow.style.marginTop = '10px';
  btnRow.innerHTML = '<button class="btn-outline btn-sm" id="referral-print-btn"><i class="fas fa-print me-1"></i>' + esc(t('referral.download')) + '</button>';
  $('#referral-preview').appendChild(btnRow);
  $('#referral-print-btn').addEventListener('click', function() { window.print(); });
  if (item.patient_id) {
    var sendBtn = document.createElement('button'); sendBtn.className = 'btn-primary btn-sm'; sendBtn.style.marginTop = '10px'; sendBtn.innerHTML = '<i class="fas fa-paper-plane me-1"></i>' + esc(t('referral.send'));
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

/* ---------- SOAP Notes ---------- */
var soapState = null; // { itemId, noteId, status }
function openSoap(itemId) {
  var item = mergedQueue().find(function(i) { return i.id === itemId; }); if (!item) return;
  soapState = { itemId: itemId, noteId: null, status: 'draft' };
  ['soap-s','soap-o','soap-a','soap-p'].forEach(function(id) { var el = $('#' + id); if (el) el.value = ''; });
  var msg = $('#soap-msg'); if (msg) msg.textContent = '';
  setSoapBadge('draft'); $('#soap-modal').style.display = '';
  fetch('/api/triage/session/' + itemId + '/soap', { credentials: 'include' })
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(j) {
      if (j && j.note) { fillSoap(j.note); soapState.noteId = j.note.id; soapState.status = j.note.status || 'draft'; setSoapBadge(soapState.status); }
      else if (msg) msg.textContent = 'No note yet — click Generate to AI-draft one from this triage session.';
    })
    .catch(function() {});
}
function fillSoap(note) {
  $('#soap-s').value = note.subjective || ''; $('#soap-o').value = note.objective || '';
  $('#soap-a').value = note.assessment || ''; $('#soap-p').value = note.plan || '';
  $('#soap-meta').textContent = 'Status: ' + (note.status === 'signed' ? 'Signed ' + (note.signed_at || '').replace('T', ' ').slice(0, 16) : 'Draft') + (note.updated_at ? ' · updated ' + note.updated_at.replace('T', ' ').slice(0, 16) : '');
}
function setSoapBadge(status) { var el = $('#soap-status-badge'); if (el) { el.textContent = status; el.style.background = status === 'signed' ? '#10b981' : '#eab308'; el.style.color = '#fff'; } }
function closeSoap() { $('#soap-modal').style.display = 'none'; }
async function soapGenerate() {
  if (!soapState) return;
  var btn = $('#soap-generate-btn'); var msg = $('#soap-msg');
  btn.disabled = true; msg.textContent = 'AI drafting SOAP note… (may take up to ~20 s)';
  try {
    var r = await fetch('/api/triage/session/' + soapState.itemId + '/soap', { method: 'POST', credentials: 'include' });
    var j = await r.json();
    if (!r.ok || !j.note) throw new Error(j.detail || 'Generation failed');
    soapState.noteId = j.note.id; soapState.status = j.note.status || 'draft';
    fillSoap(j.note); setSoapBadge(soapState.status);
    msg.textContent = 'Draft ready — review, edit, then Sign or Export PDF.';
    addAudit('soap_generate', 'SOAP note drafted for session ' + soapState.itemId.slice(0, 8) + '.');
  } catch (e) { msg.textContent = 'SOAP generation failed: ' + e.message; }
  btn.disabled = false;
}
async function soapSave(sign) {
  if (!soapState) return;
  var msg = $('#soap-msg'); var url = soapState.noteId ? '/api/soap/' + soapState.noteId : '/api/triage/session/' + soapState.itemId + '/soap';
  var btn = $(sign ? '#soap-sign-btn' : '#soap-save-btn'); if (btn) btn.disabled = true;
  try {
    var body = { subjective: $('#soap-s').value, objective: $('#soap-o').value, assessment: $('#soap-a').value, plan: $('#soap-p').value, sign: !!sign };
    var r = await fetch(url, { method: soapState.noteId ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(body) });
    var j = await r.json();
    if (!r.ok || (!j.note && !j.status)) throw new Error(j.detail || 'Save failed');
    if (j.note) { soapState.noteId = j.note.id; soapState.status = j.note.status; fillSoap(j.note); setSoapBadge(j.note.status); }
    msg.textContent = sign ? 'Note signed and locked.' : 'Draft saved.';
    addAudit('soap_save', 'SOAP note ' + (sign ? 'signed' : 'saved') + ' for session ' + soapState.itemId.slice(0, 8) + '.');
  } catch (e) { msg.textContent = 'Save failed: ' + e.message; }
  if (btn) btn.disabled = false;
}
function soapPdf() {
  if (!soapState || !soapState.noteId) { var msg = $('#soap-msg'); if (msg) msg.textContent = 'Generate and save the note first.'; return; }
  window.open('/api/soap/' + soapState.noteId + '/pdf', '_blank');
}

/* ---------- Prescription ---------- */
var rxState = null; // { itemId, patientId, rxId, status }
function openRx(itemId) {
  var item = mergedQueue().find(function(i) { return i.id === itemId; }); if (!item) return;
  rxState = { itemId: itemId, patientId: item.patient_id, rxId: null, status: 'draft' };
  $('#rx-intent').value = ''; $('#rx-advice').value = ''; $('#rx-items').innerHTML = ''; $('#rx-warnings').innerHTML = '';
  var msg = $('#rx-msg'); if (msg) msg.textContent = '';
  setRxBadge('draft'); $('#rx-modal').style.display = '';
}
function setRxBadge(status) { var el = $('#rx-status-badge'); if (el) { el.textContent = status; el.style.background = status === 'signed' ? '#10b981' : '#eab308'; el.style.color = '#fff'; } }
function closeRx() { $('#rx-modal').style.display = 'none'; }
function rxItemRow(item, idx) {
  item = item || {};
  return '<div class="triage-rx-row" data-idx="' + idx + '">' +
    '<input class="triage-input" data-f="drug" placeholder="Drug" value="' + esc(item.drug || '') + '">' +
    '<input class="triage-input" data-f="dose" placeholder="Dose" value="' + esc(item.dose || '') + '">' +
    '<input class="triage-input" data-f="route" placeholder="Route" value="' + esc(item.route || '') + '">' +
    '<input class="triage-input" data-f="frequency" placeholder="Frequency" value="' + esc(item.frequency || '') + '">' +
    '<input class="triage-input" data-f="duration" placeholder="Duration" value="' + esc(item.duration || '') + '">' +
    '<input class="triage-input" data-f="refills" placeholder="Refills" value="' + esc(item.refills || '0') + '">' +
    '<input class="triage-input" data-f="instructions" placeholder="Instructions" value="' + esc(item.instructions || '') + '">' +
    '<button class="btn-outline btn-sm" title="Remove" onclick="this.parentNode.remove()"><i class="fas fa-trash"></i></button></div>';
}
function renderRxItems(items) {
  var wrap = $('#rx-items');
  var html = '<div class="triage-rx-row triage-rx-head"><span>Drug</span><span>Dose</span><span>Route</span><span>Freq</span><span>Duration</span><span>Refills</span><span>Instructions</span><span></span></div>';
  (items && items.length ? items : [{}]).forEach(function(it, i) { html += rxItemRow(it, i); });
  wrap.innerHTML = html;
}
function collectRxItems() {
  var items = [];
  $('#rx-items').querySelectorAll('.triage-rx-row[data-idx]').forEach(function(row) {
    var obj = {};
    row.querySelectorAll('input[data-f]').forEach(function(inp) { obj[inp.getAttribute('data-f')] = inp.value; });
    if ((obj.drug || '').trim()) items.push(obj);
  });
  return items;
}
async function rxGenerate() {
  if (!rxState) return;
  var intent = ($('#rx-intent').value || '').trim();
  var msg = $('#rx-msg');
  if (!intent) { msg.textContent = 'Type your prescribing intent first.'; return; }
  if (!rxState.patientId) { msg.textContent = 'No patient attached to this session — cannot prescribe.'; return; }
  var btn = $('#rx-generate-btn'); btn.disabled = true;
  msg.textContent = 'AI formatting prescription… (may take up to ~20 s)';
  try {
    var r = await fetch('/api/prescription/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ patient_id: rxState.patientId, triage_session_id: rxState.itemId, intent: intent }) });
    var j = await r.json();
    if (!r.ok || !j.prescription) throw new Error(j.detail || 'Generation failed');
    rxState.rxId = j.prescription.id; rxState.status = j.prescription.status || 'draft';
    renderRxItems(j.prescription.items || []);
    var warns = j.prescription.warnings || [];
    $('#rx-warnings').innerHTML = warns.length ? '<div class="triage-referral-box triage-referral-amber"><div class="triage-referral-label">⚠ Warnings (check patient profile)</div><ul style="margin:4px 0 0 16px;">' + warns.map(function(w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul></div>' : '<div class="triage-hint">No interaction/allergy warnings flagged by AI.</div>';
    $('#rx-advice').value = j.prescription.advice || '';
    setRxBadge(rxState.status);
    msg.textContent = 'Draft ready — edit inline, then Sign or Export PDF.';
    addAudit('rx_generate', 'Prescription drafted for session ' + rxState.itemId.slice(0, 8) + '.');
  } catch (e) { msg.textContent = 'Prescription generation failed: ' + e.message; }
  btn.disabled = false;
}
async function rxSave(sign) {
  if (!rxState || !rxState.rxId) { var m0 = $('#rx-msg'); if (m0) m0.textContent = 'Generate the prescription first.'; return; }
  var msg = $('#rx-msg'); var btn = $(sign ? '#rx-sign-btn' : '#rx-save-btn'); if (btn) btn.disabled = true;
  try {
    var body = { items: collectRxItems(), advice: $('#rx-advice').value, sign: !!sign };
    var r = await fetch('/api/prescription/' + rxState.rxId, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(body) });
    var j = await r.json();
    if (!r.ok || !j.prescription) throw new Error(j.detail || 'Save failed');
    rxState.status = j.prescription.status; setRxBadge(j.prescription.status);
    msg.textContent = sign ? 'Prescription signed.' : 'Draft saved.';
    addAudit('rx_save', 'Prescription ' + (sign ? 'signed' : 'saved') + ' (' + rxState.rxId.slice(0, 8) + ').');
  } catch (e) { msg.textContent = 'Save failed: ' + e.message; }
  if (btn) btn.disabled = false;
}
function rxPdf() {
  if (!rxState || !rxState.rxId) { var msg = $('#rx-msg'); if (msg) msg.textContent = 'Generate and save the prescription first.'; return; }
  window.open('/api/prescription/' + rxState.rxId + '/pdf', '_blank');
}

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

/* ---------- Patient records (prescriptions / invoices / checkup) ---------- */
function rxItemText(it) {
  it = it || {};
  var parts = [it.drug || it.name].filter(Boolean);
  if (it.dose) parts.push(it.dose);
  if (it.frequency) parts.push(it.frequency);
  if (it.duration) parts.push('x ' + it.duration);
  if (it.route) parts.push('(' + it.route + ')');
  return parts.join(' · ');
}
function invoiceStatusBadge(s) { return '<span class="triage-badge triage-badge-' + (s === 'paid' ? 'risk-routine' : 'risk-urgent') + '">' + esc(s === 'paid' ? 'Paid' : s === 'refunded' ? 'Refunded' : (s || 'unpaid')) + '</span>'; }
function rxStatusBadge(s) { return '<span class="triage-badge triage-badge-' + (s === 'signed' ? 'risk-routine' : 'risk-standard') + '">' + esc((s || 'draft')) + '</span>'; }
function renderRecords() {
  var wrap = $('#records-content'); if (!wrap) return;
  wrap.innerHTML = '<div class="triage-empty"><p>Loading records…</p></div>';
  var tally = 0;
  Promise.all([
    fetch('/api/prescriptions', { credentials: 'include' }).then(function(r) { return r.ok ? r.json() : null; }),
    fetch('/api/invoices', { credentials: 'include' }).then(function(r) { return r.ok ? r.json() : null; }),
    fetch('/api/checkup/status', { credentials: 'include' }).then(function(r) { return r.ok ? r.json() : null; }).catch(function() { return null; })
  ]).then(function(kit) {
    var rxs = (kit[0] && kit[0].status === 'ok' && kit[0].prescriptions) ? kit[0].prescriptions : [];
    var invs = (kit[1] && kit[1].status === 'ok' && kit[1].invoices) ? kit[1].invoices : [];
    var ck = kit[2] || {};
    tally = rxs.length + invs.length;
    var badge = $('#records-badge'); if (badge) { badge.textContent = tally || ''; badge.style.display = tally ? '' : 'none'; }
    var html = '<div class="triage-records-grid">';

    /* Full-body checkup card */
    html += '<div class="triage-card"><div class="triage-card-head"><h3><i class="fas fa-heart-pulse me-2 triage-teal"></i>Full Body Checkup</h3><span class="triage-card-sub">Your latest health checkup status.</span></div>';
    if (ck.has_completed) {
      html += '<div class="triage-referral-box"><div class="triage-referral-label">Completed</div><p style="margin:4px 0 0;">Your last full-body checkup was completed.' + (ck.pending ? ' A new request is being scheduled.' : '') + '</p></div>';
    } else if (ck.pending) {
      html += '<div class="triage-referral-box triage-referral-amber"><div class="triage-referral-label">' + esc((ck.pending.package || 'full_body')).replace(/_/g, ' ') + ' · ' + esc(ck.pending.status || 'requested') + '</div><p style="margin:4px 0 0;">Requested ' + fmtDate(ck.pending.requested_at) + (ck.pending.preferred_date ? ' · preferred ' + esc(ck.pending.preferred_date) : '') + '. Your care team will contact you to schedule it.</p></div>';
    } else {
      html += '<div class="triage-empty"><i class="fas fa-calendar-plus"></i><p>No checkup on record. Ask your care team about a full-body checkup.</p></div>';
    }
    html += '</div>';

    /* Prescriptions card */
    html += '<div class="triage-card"><div class="triage-card-head"><h3><i class="fas fa-prescription me-2 triage-violet"></i>Prescriptions</h3><span class="triage-card-sub">Signed and draft prescriptions from reviewers.</span></div>';
    if (!rxs.length) {
      html += '<div class="triage-empty"><i class="fas fa-file-medical"></i><p>No prescriptions yet.</p></div>';
    } else {
      html += '<div class="triage-records-list">';
      rxs.forEach(function(rx) {
        var items = (rx.items || []).filter(function(i) { return (i.drug || i.name); });
        html += '<div class="triage-history-visit"><div class="triage-history-visit-head"><span class="triage-code">Rx</span> ' + rxStatusBadge(rx.status) + '<span class="triage-muted ms-auto">' + fmtDate(rx.created_at) + '</span></div><div class="triage-history-visit-meta">' + (items.length ? items.map(rxItemText).join('<br>') : esc(rx.advice || 'No items')) + '</div><div class="triage-records-actions"><button class="btn-outline btn-sm" onclick="window.open(\'/api/prescription/' + encodeURIComponent(rx.id) + '/pdf\',\'_blank\')"><i class="fas fa-file-pdf me-1"></i>PDF</button></div></div>';
      });
      html += '</div>';
    }
    html += '</div>';

    /* Invoices card */
    html += '<div class="triage-card triage-records-span"><div class="triage-card-head"><h3><i class="fas fa-file-invoice-dollar me-2 triage-amber"></i>Invoices</h3><span class="triage-card-sub">Download your invoices; mark them paid after settling.</span></div>';
    if (!invs.length) {
      html += '<div class="triage-empty"><i class="fas fa-receipt"></i><p>No invoices yet.</p></div>';
    } else {
      html += '<table class="triage-invoice-table"><tr><th>No</th><th>Date</th><th>Items</th><th>Total</th><th>Status</th><th></th></tr>';
      invs.forEach(function(inv) {
        html += '<tr><td>' + esc(inv.invoice_no || inv.id.slice(0, 8)) + '</td><td>' + fmtDate(inv.created_at) + '</td><td>' + esc((inv.items || []).map(function(i) { return i.description; }).filter(Boolean).join(', ') || '—') + '</td><td>' + esc(inv.currency || 'INR') + ' ' + (Number(inv.total) || 0).toFixed(2) + '</td><td>' + invoiceStatusBadge(inv.status) + '</td><td class="triage-invoice-actions">' + (inv.status !== 'paid' && inv.status !== 'refunded' ? '<button class="btn-outline btn-sm" onclick="patientInvoicePaid(\'' + encodeURIComponent(inv.id) + '\')"><i class="fas fa-circle-check me-1"></i>Mark paid</button>' : '') + '<button class="btn-outline btn-sm" onclick="window.open(\'/api/invoice/' + encodeURIComponent(inv.id) + '/pdf\',\'_blank\')"><i class="fas fa-file-pdf me-1"></i>PDF</button></td></tr>';
      });
      html += '</table>';
    }
    html += '</div></div>';
    wrap.innerHTML = html;
  }).catch(function() {
    wrap.innerHTML = '<div class="triage-empty"><i class="fas fa-exclamation-triangle"></i><p>Could not load records.</p></div>';
  });
}
async function patientInvoicePaid(id) {
  try {
    var r = await fetch('/api/invoice/' + encodeURIComponent(id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ status: 'paid' }) });
    var j = await r.json();
    if (j.status === 'ok') { showToast('<i class="fas fa-circle-check me-1"></i>Invoice marked paid'); renderRecords(); }
  } catch (e) {}
}

/* ---------- Book Call ---------- */
function getLocalDateStr(d) {
  var y = d.getFullYear();
  var m = String(d.getMonth() + 1).padStart(2, '0');
  var day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}
/* ---------- Book Call ---------- */
function bindBookCall() {
  state.bookCallDoctor = '';
  var now = new Date();
  var day = now.getDay();
  var diff = now.getDate() - day + (day === 0 ? -6 : 1);
  state.bookCallWeek = new Date(now.setDate(diff));
  state.bookCallWeek.setHours(0,0,0,0);
  var el = $('#book-call-content'); if (!el) return;
  el.innerHTML = '<div class="triumph-booking-guide"><strong>How it works:</strong> Patients — pick a doctor and an available time slot to book a call. Doctors — set your availability below. All bookings appear in your bookings list below.</div><div class="triumph-booking-layout"><div class="triumph-booking-doctors"><h3><i class="fas fa-user-doctor me-2"></i>Doctors</h3><select id="triumph-book-call-doctors" class="triumph-booking-select" style="width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--line);background:var(--bg-raise);color:var(--ink);font-size:13.5px;cursor:pointer;"><option value="">Select a doctor...</option></select></div><div class="triumph-booking-main"><div class="triumph-booking-header"><h3><i class="fas fa-calendar-days me-2"></i>Availability</h3><div class="triumph-booking-week-nav"><button class="btn-outline btn-sm" onclick="shiftWeek(-1)"><i class="fas fa-chevron-left"></i></button> <span id="triumph-book-call-week-label" style="min-width:170px;text-align:center;"></span> <button class="btn-outline btn-sm" onclick="shiftWeek(1)"><i class="fas fa-chevron-right"></i></button></div></div><div id="triumph-book-call-calendar" class="triumph-booking-calendar" style="overflow-x:auto;"></div></div></div><div class="triumph-bookings-card triage-card"><div class="triumph-booking-header"><h3><i class="fas fa-list me-2"></i>My Bookings</h3></div><div id="triumph-book-call-bookings"></div></div>';
  loadDoctors();
}
function syncBookCallTabLabel() {
  var ic = $('#book-call-tab-icon');
  var lb = $('#book-call-tab-label');
  if (!lb) return;
  if (state.isStaff) {
    lb.setAttribute('data-i18n', 'tab.appointments');
    if (ic) ic.className = 'fas fa-calendar-days me-1';
  } else {
    lb.setAttribute('data-i18n', 'tab.bookCall');
    if (ic) ic.className = 'fas fa-phone me-1';
  }
  lb.textContent = t(state.isStaff ? 'tab.appointments' : 'tab.bookCall');
}
function fmtT12(hhmm) {
  var p = String(hhmm || '00').split(':');
  var h = parseInt(p[0], 10); if (isNaN(h)) h = 0;
  var m = p[1] || '00';
  var ap = h >= 12 ? 'PM' : 'AM';
  var h12 = h % 12; if (h12 === 0) h12 = 12;
  return h12 + ':' + m + ' ' + ap;
}
function fmtApptDate(scheduledAt) {
  var p = String(scheduledAt || '').split('T');
  var ds = p[0];
  if (!ds) return '—';
  var today = getLocalDateStr(new Date());
  if (ds === today) return 'Today';
  var tm = new Date(); tm.setDate(tm.getDate() + 1);
  if (ds === getLocalDateStr(tm)) return 'Tomorrow';
  var d = new Date(ds + 'T00:00:00');
  return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()] + ', ' + (d.getMonth()+1) + '/' + d.getDate();
}
function apptStatusCls(s) { return 'triumph-status-' + (s || 'requested'); }
function apptRowHtml(b) {
  var person = esc(b.patient_name || b.patient_id || 'Patient');
  var when = fmtApptDate(b.scheduled_at);
  var time = fmtT12(String(b.scheduled_at || '').split('T')[1]);
  var notes = b.notes ? '<div class="triumph-appt-notes">' + esc(b.notes) + '</div>' : '';
  var actions = '';
  if (b.status === 'requested') {
    actions = '<button class="btn-primary btn-sm" onclick="updateBookingStatus(\'' + b.id + '\',\'confirmed\')">Confirm</button> <button class="btn-outline btn-sm" onclick="updateBookingStatus(\'' + b.id + '\',\'cancelled\')">Reject</button>';
  } else if (b.status === 'confirmed') {
    actions = '<button class="btn-outline btn-sm" onclick="updateBookingStatus(\'' + b.id + '\',\'completed\')">Mark completed</button>';
  }
  return '<div class="triumph-appt-row">'
    + '<div class="triumph-appt-when"><span class="triumph-appt-date">' + (when === 'Today' || when === 'Tomorrow' ? '<b>' + when + '</b>' : when) + '</span><span class="triumph-appt-time">' + time + '</span></div>'
    + '<div class="triumph-appt-who"><span class="triumph-appt-name">' + person + '</span>' + notes + '</div>'
    + '<div class="triumph-appt-side"><span class="triumph-appt-status triumph-status-badge ' + apptStatusCls(b.status) + '">' + esc(b.status || 'requested') + '</span>'
    + (actions ? '<span class="triumph-appt-actions">' + actions + '</span>' : '') + '</div>'
    + '</div>';
}
async function loadDoctorAppointments() {
  var host = $('#book-call-content'); if (!host) return;
  var tEl = $('#book-call-title'); if (tEl) tEl.textContent = t('tab.appointments');
  var sEl = $('#book-call-sub'); if (sEl) sEl.textContent = 'Patients coming for check-up — review and confirm their appointments.';
  var iEl = $('#book-call-title-icon'); if (iEl) iEl.className = 'fas fa-calendar-days me-2 triage-teal';
  host.innerHTML =
    '<div class="triumph-appt-stats">'
    + '<div class="triumph-appt-stat"><b id="appt-today">0</b><span>Today</span></div>'
    + '<div class="triumph-appt-stat"><b id="appt-pending">0</b><span>Pending</span></div>'
    + '<div class="triumph-appt-stat"><b id="appt-confirmed">0</b><span>Confirmed</span></div>'
    + '<div class="triumph-appt-stat"><b id="appt-completed">0</b><span>Completed</span></div>'
    + '</div>'
    + '<div id="triumph-appt-list" class="triumph-appt-list"></div>'
    + '<details class="triumph-avail"><summary><i class="fas fa-calendar-days me-1"></i> Manage your availability</summary>'
    + '<div class="triumph-avail-body"><div class="triumph-booking-header"><div class="triumph-booking-week-nav">'
    + '<button class="btn-outline btn-sm" onclick="shiftWeek(-1)"><i class="fas fa-chevron-left"></i></button>'
    + ' <span id="triumph-book-call-week-label" style="min-width:170px;text-align:center;"></span> '
    + '<button class="btn-outline btn-sm" onclick="shiftWeek(1)"><i class="fas fa-chevron-right"></i></button>'
    + '</div></div><div id="triumph-book-call-calendar" class="triumph-booking-calendar" style="overflow-x:auto;"></div></div></details>';
  if (!state.selfId) {
    try { var m = await (await fetch('/me', { credentials: 'include' })).json(); state.selfId = (m && m.status === 'ok' && m.user && m.user.id) ? m.user.id : ''; }
    catch (e) { state.selfId = ''; }
  }
  if (state.selfId) { state.bookCallDoctor = state.selfId; renderCalendar(); }
  renderDoctorAppointments();
}
async function renderDoctorAppointments() {
  var list = $('#triumph-appt-list'); if (!list) return;
  var today = getLocalDateStr(new Date());
  var cToday = 0, cPending = 0, cConfirmed = 0, cCompleted = 0;
  var upcoming = [], past = [];
  try {
    var d = await fetch('/api/call/bookings', { credentials: 'include' });
    var j = await d.json();
    var bookings = (j.status === 'ok' && j.bookings) ? j.bookings : [];
    bookings.forEach(function(b) {
      var when = String(b.scheduled_at || '').split('T')[0];
      if (b.status === 'cancelled') cCompleted = cCompleted; else if (b.status === 'completed') cCompleted++;
      else if (b.status === 'confirmed') cConfirmed++;
      else if (b.status === 'requested') cPending++;
      if (when === today) cToday++;
      var isUp = b.status !== 'cancelled' && b.status !== 'completed' && when >= today;
      (isUp ? upcoming : past).push(b);
    });
  } catch (e) {}
  upcoming.sort(function(a, b) { return String(a.scheduled_at || '').localeCompare(String(b.scheduled_at || '')); });
  past.sort(function(a, b) { return String(b.scheduled_at || '').localeCompare(String(a.scheduled_at || '')); });
  function setStat(id, v) { var e = document.getElementById(id); if (e) e.textContent = String(v); }
  setStat('appt-today', cToday); setStat('appt-pending', cPending); setStat('appt-confirmed', cConfirmed); setStat('appt-completed', cCompleted);
  var html = '';
  if (!upcoming.length && !past.length) {
    html = '<div class="triumph-booking-empty"><i class="fas fa-calendar-check"></i><p>No appointments yet. Patients who book a slot will appear here.</p></div>';
  } else {
    if (upcoming.length) { html += '<div class="triumph-appt-group"><h4>Upcoming</h4>' + upcoming.map(apptRowHtml).join('') + '</div>'; }
    if (past.length) { html += '<div class="triumph-appt-group"><h4>Past</h4>' + past.map(apptRowHtml).join('') + '</div>'; }
  }
  list.innerHTML = html;
}
function shiftWeek(n) { state.bookCallWeek.setDate(state.bookCallWeek.getDate() + n * 7); renderCalendar(); }
async function loadDoctors() {
  try {
    var d = await fetch('/api/doctor/doctors', { credentials: 'include' });
    var j = await d.json();
    var doctors = (j.status === 'ok' && j.doctors) ? j.doctors : [];
    var sel = $('#triumph-book-call-doctors');
    if (sel) {
      sel.innerHTML = '<option value="">Select a doctor...</option>';
      doctors.forEach(function(doc) {
        var opt = document.createElement('option');
        opt.value = doc.id;
        opt.textContent = (doc.name || doc.email) + ' — ' + (doc.qualification || 'General Practitioner');
        sel.appendChild(opt);
      });
      sel.onchange = function() { state.bookCallDoctor = sel.value; renderCalendar(); };
      if (!state.bookCallDoctor && doctors.length > 0) {
        state.bookCallDoctor = doctors[0].id;
        sel.value = doctors[0].id;
      }
      if (state.bookCallDoctor) sel.value = state.bookCallDoctor;
    }
    renderCalendar();
  } catch (e) {
    if (sel) sel.innerHTML = '<option value="">Could not load doctors</option>';
  }
}
function selectDoctor(id) { state.bookCallDoctor = id; loadDoctors(); }
function fmtDay(d) { return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()] + ' ' + (d.getMonth()+1) + '/' + d.getDate(); }
function showConfirm(title, msg, onYes, onNo) {
  var overlay = document.createElement('div'); overlay.className = 'triumph-booking-confirm';
  overlay.innerHTML = '<div class="triumph-booking-confirm-box"><h3>' + esc(title) + '</h3><p>' + esc(msg) + '</p><div class="triumph-actions"><button class="btn-outline btn-sm" id="triumph-confirm-no">No</button> <button class="btn-primary btn-sm" id="triumph-confirm-yes">Yes</button></div></div>';
  document.body.appendChild(overlay);
  $('#triumph-confirm-yes').onclick = function() { overlay.remove(); onYes(); };
  $('#triumph-confirm-no').onclick = function() { overlay.remove(); };
}
async function renderCalendar() {
  var el = $('#triumph-book-call-calendar');
  if (!el || !state.bookCallDoctor) {
    if (el) el.innerHTML = '<div class="triumph-booking-empty"><p>Select a doctor to see availability.</p></div>';
    return;
  }
  var weekStart = new Date(state.bookCallWeek); weekStart.setHours(0,0,0,0);
  var days = [];
  var html = '<table><tr><th>Time</th>';
  for (var i = 0; i < 7; i++) {
    var d = new Date(weekStart); d.setDate(d.getDate() + i);
    days.push(d);
    html += '<th>' + fmtDay(d) + '</th>';
  }
  html += '</tr>';
  try {
    var resp = await fetch('/api/doctor/availability?doctor_id=' + encodeURIComponent(state.bookCallDoctor), { credentials: 'include' });
    var j = await resp.json();
    var slots = (j.status === 'ok' && j.availability) ? j.availability : [];
    
    // Always fill missing weekday slots with defaults (09:00, 10:00, 11:00, 14:00, 15:00, 16:00)
    var existingKeys = {};
    slots.forEach(function(s) {
      var k = s.date + '|' + (s.start_time.length === 5 ? s.start_time : s.start_time.slice(0,5));
      existingKeys[k] = true;
    });
    days.forEach(function(d) {
      if (d.getDay() >= 1 && d.getDay() <= 5) {
        var dStr = getLocalDateStr(d);
        ['09:00', '10:00', '11:00', '14:00', '15:00', '16:00'].forEach(function(st) {
          var k = dStr + '|' + st;
          if (!existingKeys[k]) {
            slots.push({ id: 'default_' + dStr + '_' + st, doctor_id: state.bookCallDoctor, date: dStr, start_time: st, max_slots: 1 });
          }
        });
      }
    });

    var availMap = {};
    slots.forEach(function(s) {
      var key = s.date + '|' + (s.start_time.length === 5 ? s.start_time : s.start_time.slice(0,5));
      (availMap[key] = availMap[key] || []).push(s);
    });
    
    var bResp = await fetch('/api/call/bookings', { credentials: 'include' });
    var bj = await bResp.json();
    var bookings = (bj.status === 'ok' && bj.bookings) ? bj.bookings : [];
    var bookMap = {};
    bookings.forEach(function(b) {
      var k = b.scheduled_at.split('T')[0];
      (bookMap[k] = bookMap[k] || []).push(b);
    });

    var hours = ['08','09','10','11','12','13','14','15','16','17','18','19','20'];
    hours.forEach(function(h) {
      html += '<tr><td style="padding:4px;text-align:left;font-weight:600;font-size:12px;">' + h + ':00</td>';
      days.forEach(function(d) {
        var dateStr = getLocalDateStr(d);
        var timeKey = h + ':00';
        var avail = availMap[dateStr + '|' + timeKey];
        var bs = bookMap[dateStr] || [];
        var booked = bs.filter(function(b) { return b.scheduled_at.slice(0,13) === dateStr + 'T' + h; });
        var slot = avail ? avail[0] : null;
        var cellCls = booked.length ? 'triumph-booking-slot-booked' : (avail ? 'triumph-booking-slot-available' : 'triumph-booking-slot-full');
        var btnTxt = booked.length ? (booked[0].status.charAt(0).toUpperCase() + booked[0].status.slice(1, 8)) : (avail ? (state.role === 'patient' || !state.role || state.role === 'guest' ? 'Book' : 'Available') : 'Full');
        var onclick = booked.length ? '' : (state.role === 'patient' || !state.role || state.role === 'guest' ?
          (avail ? "showConfirm('Book Call', 'Book call with doctor on " + esc(fmtDay(d)) + " at " + h + ":00?', function(){ bookCallDoctorSlot('" + state.bookCallDoctor + "','" + dateStr + "','" + timeKey + "'); })" : "") :
          "toggleDocAvailability('" + state.bookCallDoctor + "','" + dateStr + "','" + timeKey + "')"
        );
        html += '<td style="padding:4px;"><button class="triumph-booking-slot-btn ' + cellCls + '" ' + (onclick ? 'onclick="' + onclick + '"' : '') + '>' + btnTxt + '</button></td>';
      });
      html += '</tr>';
    });
  } catch (e) {
    console.error("Calendar render error:", e);
  }
  html += '</table>';
  el.innerHTML = html;
  var weekEnd = new Date(weekStart); weekEnd.setDate(weekEnd.getDate() + 6);
  $('#triumph-book-call-week-label').textContent = fmtDay(weekStart) + ' — ' + fmtDay(weekEnd);
}
function bookCallDoctorSlot(doctorId, date, time) {
  fetch('/api/call/book', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({doctor_id: doctorId, date: date, start_time: time, notes: ''}),
    credentials: 'include'
  }).then(function(r) { return r.json(); }).then(function(res) {
    if (res.status === 'ok') {
      loadBookings();
      renderCalendar();
    } else {
      alert('Booking failed: ' + (res.detail || 'Unknown error'));
    }
  }).catch(function(err) {
    alert('Booking error: ' + err.message);
  });
}
async function toggleDocAvailability(doctorId, date, time) { try { var parts = time.split(':'); var endH = String(parseInt(parts[0], 10) + 1).padStart(2, '0'); var endTime = endH + ':' + (parts[1] || '00'); var j = await fetch('/api/doctor/availability', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({doctor_id: doctorId, date: date, start_time: time, end_time: endTime, max_slots: 1}), credentials: 'include' }).then(function(r){ return r.json(); }); if (j.status === 'ok') renderCalendar(); } catch (e) {} }
async function loadBookings() { try { var d = await fetch('/api/call/bookings', { credentials: 'include' }); var j = await d.json(); var bookings = (j.status === 'ok' && j.bookings) ? j.bookings : []; var html = ''; if (!bookings.length) { html = '<div class="triumph-booking-empty"><i class="fas fa-list"></i><p>No bookings yet.</p></div>'; } else { html = '<table class="triumph-bookings-table"><tr><th>' + (state.role === 'patient' ? 'Doctor' : 'Patient') + '</th><th>Date/Time</th><th>Status</th><th></th></tr>'; bookings.forEach(function(b) { var statusCls = 'triumph-status-' + (b.status || 'requested'); var person = state.role === 'patient' ? (b.doctor_name || b.doctor_id) : (b.patient_name || b.patient_id); var actions = ''; if (b.status === 'requested') { if (state.role === 'patient') actions = '<button class="btn-outline btn-sm" onclick="updateBookingStatus(\'' + b.id + '\',\'cancelled\')">Cancel</button>'; else actions = '<button class="btn-primary btn-sm" onclick="updateBookingStatus(\'' + b.id + '\',\'confirmed\')">Confirm</button> <button class="btn-outline btn-sm" onclick="updateBookingStatus(\'' + b.id + '\',\'cancelled\')">Reject</button>'; } html += '<tr><td>' + esc(person) + '</td><td>' + esc(b.scheduled_at) + '</td><td><span class="triumph-status-badge ' + statusCls + '">' + esc(b.status || 'unknown') + '</span></td><td>' + actions + '</td></tr>'; }); html += '</table>'; } $('#triumph-book-call-bookings').innerHTML = html; } catch (e) { $('#triumph-book-call-bookings').innerHTML = '<div class="triumph-booking-empty"><p>Could not load bookings.</p></div>'; } }
async function updateBookingStatus(bookingId, status) { try { var j = await fetch('/api/call/booking/' + bookingId, { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({status: status}), credentials: 'include' }).then(function(r){ return r.json(); }); if (j.status === 'success') { if (state.isStaff) { renderDoctorAppointments(); renderCalendar(); } else { loadBookings(); renderCalendar(); } } } catch (e) {} }

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

/* ---------- Notifications + digest + invoices (Priority 2/3) ---------- */
state.notifs = [];
function notifKindIcon(k) { return { digest: 'fa-calendar-day', followup_due: 'fa-calendar-check', lab_critical: 'fa-vial-circle-check', invoice: 'fa-file-invoice-dollar', rx_signed: 'fa-prescription', soap_signed: 'fa-file-medical', booking_requested: 'fa-phone' }[k] || 'fa-bell'; }
function notifKindCls(k) { return { digest: 'triage-teal', followup_due: 'triage-amber', lab_critical: 'triage-danger2', invoice: 'triage-amber', rx_signed: 'triage-violet', soap_signed: 'triage-teal', booking_requested: 'triage-blue' }[k] || 'triage-muted'; }
async function loadNotifications() {
  try {
    var d = await fetch('/api/notifications?limit=30', { credentials: 'include' });
    var j = await d.json();
    state.notifs = (j.status === 'ok' && j.notifications) ? j.notifications : [];
    var un = (j.status === 'ok') ? (j.unread || 0) : 0;
    var b = $('#notif-count');
    if (b) { b.style.display = un ? '' : 'none'; b.textContent = un > 99 ? '99+' : un; }
  } catch (e) { state.notifs = []; }
  renderNotifList();
}
function renderNotifList() {
  var el = $('#notif-list'); if (!el) return;
  if (!state.notifs.length) { el.innerHTML = '<div class="triage-empty" style="padding:14px;"><p>No notifications yet.</p></div>'; return; }
  el.innerHTML = state.notifs.map(function(n) {
    return '<div class="triage-notif-item' + (n.is_read ? '' : ' triage-notif-unread') + '">'
      + '<i class="fas ' + esc(notifKindIcon(n.kind)) + ' ' + esc(notifKindCls(n.kind)) + '"></i>'
      + '<div class="triage-notif-body"><div class="triage-notif-title">' + esc(n.title || n.kind) + '</div>'
      + (n.body ? '<div class="triage-notif-text">' + esc(n.body) + '</div>' : '')
      + '<div class="triage-notif-time">' + timeAgo(n.created_at) + '</div></div>'
      + (n.is_read ? '' : '<button class="triage-notif-read" onclick="markNotifRead(\'' + esc(n.id) + '\')" title="Mark read"><i class="fas fa-circle"></i></button>')
      + '</div>';
  }).join('');
  updateBadge();
}
function toggleNotifPanel() {
  var p = $('#notif-panel'); if (!p) return;
  var show = p.style.display === 'none';
  p.style.display = show ? '' : 'none';
  if (show) loadNotifications();
}
async function markNotifRead(id) {
  try { await fetch('/api/notifications/' + encodeURIComponent(id) + '/read', { method: 'POST', credentials: 'include' }); } catch (e) {}
  loadNotifications();
}
async function markNotifsRead() {
  try { await fetch('/api/notifications/read-all', { method: 'POST', credentials: 'include' }); } catch (e) {}
  loadNotifications();
}
async function openDigest() {
  var btn = $('#digest-run-btn'); if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin me-1"></i>Running…'; }
  try {
    var r = await fetch('/api/notifications/digest', { method: 'POST', credentials: 'include' });
    var j = await r.json();
    if (j.status === 'ok' && j.digest) { renderDigest(j.digest); if (j.dispatched) showToast('<i class="fas fa-paper-plane me-1"></i>Digest sent to ' + j.dispatched + ' clinician' + (j.dispatched === 1 ? '' : 's')); }
    else showToast('<i class="fas fa-circle-exclamation me-1"></i>Digest failed: ' + esc(j.detail || 'unknown'));
  } catch (e) { showToast('<i class="fas fa-circle-exclamation me-1"></i>Digest error'); }
  if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-bolt me-1"></i>Run digest'; }
  loadNotifications();
}
function digestKindMeta(k) { return { followup_due: ['Follow-ups due', 'triage-amber', 'fa-calendar-check'], lab_critical: ['Critical labs', 'triage-danger2', 'fa-vial-circle-check'], invoice_unpaid: ['Unpaid invoices', 'triage-violet', 'fa-file-invoice-dollar'], new_requests: ['New requests', 'triage-blue', 'fa-clipboard-list'] }[k] || [k, 'triage-muted', 'fa-bell']; }
function renderDigest(dig) {
  var dateEl = $('#digest-date'); if (dateEl && dig.date) dateEl.textContent = dig.date;
  var el = $('#digest-body'); if (!el) return;
  if (!dig.summary || !dig.summary.total) { el.innerHTML = '<div class="triage-empty"><i class="fas fa-circle-check triage-teal"></i><p>All caught up — no pending action items today.</p></div>'; return; }
  var tiles = '';
  (dig.items || []).forEach(function(it) {
    if (!it.count) return;
    var m = digestKindMeta(it.kind);
    tiles += '<div class="triage-digest-tile"><i class="fas ' + esc(m[2]) + ' ' + esc(m[1]) + '"></i><div><div class="triage-digest-count">' + it.count + '</div><div class="triage-digest-label">' + esc(m[0]) + '</div></div></div>';
  });
  el.innerHTML = '<div class="triage-digest-grid">' + tiles + '</div><div class="triage-digest-generate">Generated ' + timeAgo(dig.generated_at) + ' · advisory, reviewer-facing</div>';
}
async function loadInvoices() {
  var el = $('#invoices-body'); if (!el) return;
  el.innerHTML = '<div class="triage-skeleton"><div></div><div></div></div>';
  var rows = [];
  try { var r = await fetch('/api/invoices', { credentials: 'include' }); var j = await r.json(); rows = (j.status === 'ok' && j.invoices) ? j.invoices : []; } catch (e) { rows = []; }
  if (!rows.length) { el.innerHTML = '<div class="triage-empty"><p>No invoices yet. Use “Invoice” from a queue item to raise one.</p></div>'; return; }
  el.innerHTML = '<table class="triage-invoice-table"><tr><th>No</th><th>Patient</th><th>Date</th><th>Total</th><th>Status</th><th></th></tr>'
    + rows.map(function(inv) {
      var paid = inv.status === 'paid';
      return '<tr><td>' + esc(inv.invoice_no) + '</td><td>' + esc(inv.patient_name || '—') + '</td><td>' + fmtDate(inv.created_at) + '</td>'
        + '<td>' + esc(inv.currency || 'INR') + ' ' + esc(String(inv.total)) + '</td>'
        + '<td><span class="triage-badge ' + (paid ? 'triage-badge-status' : 'triage-badge triage-lab-abnormal') + '">' + esc(inv.status || 'unpaid') + '</span></td>'
        + '<td class="triage-invoice-actions"><button class="btn-outline btn-sm" onclick="invoicePdf(\'' + esc(inv.id) + '\')"><i class="fas fa-file-pdf me-1"></i>PDF</button>'
        + (paid ? '' : '<button class="btn-primary btn-sm" onclick="markInvoicePaid(\'' + esc(inv.id) + '\')"><i class="fas fa-check me-1"></i>Mark paid</button>')
        + '</td></tr>';
    }).join('') + '</table>';
}
async function markInvoicePaid(id) {
  try { var r = await fetch('/api/invoice/' + encodeURIComponent(id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ status: 'paid' }) }); var j = await r.json(); if (j.status === 'ok') { showToast('<i class="fas fa-circle-check me-1"></i>Invoice marked paid'); loadInvoices(); } } catch (e) {}
}
function invoicePdf(id) {
  window.open('/api/invoice/' + encodeURIComponent(id) + '/pdf', '_blank');
}
async function createInvoice(itemId, patientId) {
  try {
    var j = await fetch('/api/invoices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ patient_id: patientId, triage_session_id: itemId, items: [{ description: 'Consultation', qty: 1, rate: 0, amount: 0 }] }) }).then(function(r) { return r.json(); });
    if (j.status === 'ok') { showToast('<i class="fas fa-file-invoice-dollar me-1"></i>Invoice ' + esc((j.invoice || {}).invoice_no || '') + ' raised'); loadInvoices(); }
    else { showToast('<i class="fas fa-circle-exclamation me-1"></i>Invoice failed: ' + esc(j.detail || 'unknown')); }
  } catch (e) { showToast('<i class="fas fa-circle-exclamation me-1"></i>Invoice error'); }
}

/* ---------- Actions binding ---------- */
function bindActions() {
  // tabs
  $$('.triage-tab').forEach(function(t) { t.addEventListener('click', function() { switchTab(t.getAttribute('data-tab')); }); });
  // tab keyboard navigation (arrows / home / end)
  var tabs = $$('.triage-tab');
  tabs.forEach(function(t, i) {
    t.addEventListener('keydown', function(e) {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); var n = (i + 1) % tabs.length; tabs[n].focus(); switchTab(tabs[n].getAttribute('data-tab')); }
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); var p = (i - 1 + tabs.length) % tabs.length; tabs[p].focus(); switchTab(tabs[p].getAttribute('data-tab')); }
      else if (e.key === 'Home') { e.preventDefault(); tabs[0].focus(); switchTab(tabs[0].getAttribute('data-tab')); }
      else if (e.key === 'End') { e.preventDefault(); tabs[tabs.length - 1].focus(); switchTab(tabs[tabs.length - 1].getAttribute('data-tab')); }
    });
  });
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
  $$('.triage-tab').forEach(function(t) { t.classList.toggle('is-active', t.getAttribute('data-tab') === name); t.setAttribute('aria-selected', t.getAttribute('data-tab') === name ? 'true' : 'false'); });
  $$('.triage-tabpanel').forEach(function(p) { p.classList.toggle('is-active', p.id === 'tab-' + name); });
  if (name === 'reviewer') { refreshQueue(); if (state.isStaff) loadInvoices(); }
  if (name === 'analytics') renderAnalytics();
  if (name === 'audit') renderAudit();
  if (name === 'history') renderHistory();
  if (name === 'records') renderRecords();
  if (name === 'book-call') { if (state.isStaff) { loadDoctorAppointments(); } else { loadDoctors(); loadBookings(); } }
}
function onFacilityChange(v) { state.facility = v; state.scenario = ($('#scenario') ? $('#scenario').value : ''); populateScenarioSelect(); }
function resetIntake() { if ($('#symptoms')) $('#symptoms').value = ''; if ($('#anon-code')) $('#anon-code').value = ''; if ($('#consent')) $('#consent').checked = false; if ($('#extracts')) { $('#extracts').innerHTML = ''; delete $('#extracts').dataset.fileIndex; delete $('#extracts').dataset.init; } if ($('#upload-error')) $('#upload-error').style.display = 'none'; OCR_QUEUE = []; var fq = $('#file-queue'); if (fq) { fq.innerHTML = ''; fq.style.display = 'none'; } state.extractedTests = []; state.extractedOCRMeta = null; state.note = null; state.session = null; $('#note-result').innerHTML = ''; $('#note-empty').style.display = ''; $('#note-loading').style.display = 'none'; $('#note-result').style.display = 'none'; $('#new-intake-btn').style.display = 'none'; $('#open-queue-btn').style.display = 'none'; toggleGenerate(); }

function bindThemeLogout() { /* placeholder — functions defined above */ }

/* ---------- Hero stats ---------- */
function heroStat(icon, label, value, color) {
  return '<div class="triage-stat"><div class="triage-stat-label"><i class="fas ' + icon + '"></i> ' + label + '</div><div class="triage-stat-value"' + (color ? ' style="color:' + color + '"' : '') + '>' + value + '</div></div>';
}
function renderHeroStats() {
  var el = $('#hero-stats'); if (!el) return;
  if (state.isStaff) {
    el.innerHTML = heroStat('clipboard-list', 'Sessions', '&hellip;') + heroStat('exclamation-triangle', 'Emergency', '&hellip;') + heroStat('triangle-exclamation', 'Urgent', '&hellip;') + heroStat('circle-check', 'Completed', '&hellip;');
    fetch('/api/analytics/summary', { credentials: 'include' })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(d) {
        if (!d || !d.kpis) throw new Error('no summary');
        var k = d.kpis;
        el.innerHTML = heroStat('clipboard-list', 'Sessions', k.sessions) + heroStat('exclamation-triangle', 'Emergency', k.emergency, '#dc2626') + heroStat('triangle-exclamation', 'Urgent', k.urgent, '#ea580c') + heroStat('circle-check', 'Completed', k.completed, '#10b981');
      })
      .catch(function() {
        var items = mergedQueue();
        var e = items.filter(function(i) { return i.risk === 'emergency'; }).length;
        var u = items.filter(function(i) { return i.risk === 'urgent'; }).length;
        var c = items.filter(function(i) { return i.status === 'completed'; }).length;
        el.innerHTML = heroStat('clipboard-list', 'Sessions', items.length) + heroStat('exclamation-triangle', 'Emergency', e, '#dc2626') + heroStat('triangle-exclamation', 'Urgent', u, '#ea580c') + heroStat('circle-check', 'Completed', c, '#10b981');
      });
  } else { var ss = getSessions(); el.innerHTML = '<div class="triage-stat"><div class="triage-stat-label"><i class="fas fa-clipboard-list"></i> Sessions</div><div class="triage-stat-value">' + ss.length + '</div></div><div class="triage-stat"><div class="triage-stat-label"><i class="fas fa-wand-magic-sparkles"></i> Notes</div><div class="triage-stat-value">' + ss.filter(function(s) { return s.note; }).length + '</div></div><div class="triage-stat"><div class="triage-stat-label"><i class="fas fa-file-image"></i> OCR</div><div class="triage-stat-value">' + ss.filter(function(s) { return s.extractedTests && s.extractedTests.length; }).length + '</div></div><div class="triage-stat"><div class="triage-stat-label"><i class="fas fa-shield-halved"></i> Consent</div><div class="triage-stat-value">' + (localStorage.getItem('triage.consent.' + state.role) ? 'Yes' : 'No') + '</div></div>'; }
}

/* ---------- Boot ---------- */
if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', init); } else { init(); }
