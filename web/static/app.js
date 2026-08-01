const state = {
  scenarios: [],
  current: null,
  laps: [],
  currentLapIdx: 0,
  history: [], // decisions seen so far this session, for charts + events
  playing: false,
  seenEvents: new Set(),
  voiceOn: true,
};

const $ = (id) => document.getElementById(id);

// ---------- Clock ----------
setInterval(() => {
  $('clock').textContent = new Date().toLocaleTimeString('en-GB', { hour12: false });
}, 1000);

// ---------- Voice (Web Speech API — client-side, no key/network dependency) ----------
function speakDecision(label, sub) {
  if (!state.voiceOn || !('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel(); // don't queue up if calls arrive faster than speech
  const utter = new SpeechSynthesisUtterance(`${label}. ${sub}`);
  utter.rate = 1.05;
  utter.pitch = 0.9;
  window.speechSynthesis.speak(utter);
}

function toggleVoice() {
  state.voiceOn = !state.voiceOn;
  $('btn-voice').textContent = state.voiceOn ? '🔊 VOICE' : '🔇 VOICE';
  $('btn-voice').classList.toggle('active', state.voiceOn);
  if (!state.voiceOn) window.speechSynthesis.cancel();
}

// ---------- Car SVG ----------
// Stylized top-down technical-blueprint illustration of a generic (unbranded)
// current-regs F1 car — not a photo/render of any real team's livery.
function renderCarSvg() {
  $('car-svg-wrap').innerHTML = `
  <svg viewBox="0 0 520 260" fill="none">
    <g stroke="#35e0f0" stroke-width="1.5">
      <!-- rear wheels (wider, low-profile) -->
      <rect x="55" y="30" width="34" height="70" rx="10" opacity="0.95"/>
      <rect x="55" y="160" width="34" height="70" rx="10" opacity="0.95"/>
      <line x1="72" y1="42" x2="72" y2="88" opacity="0.35"/>
      <line x1="72" y1="172" x2="72" y2="218" opacity="0.35"/>
      <!-- front wheels (narrower) -->
      <rect x="410" y="42" width="26" height="54" rx="9" opacity="0.95"/>
      <rect x="410" y="164" width="26" height="54" rx="9" opacity="0.95"/>
      <line x1="423" y1="52" x2="423" y2="86" opacity="0.35"/>
      <line x1="423" y1="174" x2="423" y2="208" opacity="0.35"/>

      <!-- rear wing + endplates -->
      <path d="M20 55 L40 62 L40 198 L20 205 Z" opacity="0.6"/>
      <line x1="27" y1="70" x2="27" y2="190" opacity="0.5"/>

      <!-- sidepod undercuts -->
      <path d="M120 95 L145 60 L235 56 L255 95" opacity="0.5"/>
      <path d="M120 165 L145 200 L235 204 L255 165" opacity="0.5"/>
      <path d="M150 70 L150 90" opacity="0.3"/>
      <path d="M150 170 L150 190" opacity="0.3"/>

      <!-- main chassis / floor -->
      <path d="M89 108 L92 65 L260 62 L400 82 L400 178 L260 198 L92 195 L89 152 Z" opacity="0.9" stroke-width="1.8"/>
      <!-- floor edge / barge board line -->
      <path d="M95 112 L400 100 M95 148 L400 160" opacity="0.3"/>

      <!-- halo -->
      <path d="M205 65 Q225 15 275 22 Q305 27 300 62" opacity="0.85" stroke-width="1.8"/>
      <path d="M225 65 Q240 40 275 42" opacity="0.5"/>

      <!-- driver number roundel -->
      <circle cx="230" cy="130" r="16" opacity="0.4"/>

      <!-- nose + front wing -->
      <path d="M400 118 L455 122 L455 138 L400 142" opacity="0.9" stroke-width="1.8"/>
      <path d="M455 108 L470 105 L470 155 L455 152" opacity="0.7"/>
      <line x1="460" y1="115" x2="460" y2="145" opacity="0.4"/>

      <!-- DRS / rear wing top plane hint -->
      <path d="M40 68 L20 55 M40 192 L20 205" opacity="0.5"/>
    </g>
  </svg>`;
}

// ---------- Track SVGs ----------
// Stylized silhouettes evoking each circuit's known layout/character
// (Monza's Parabolica loop + chicanes, Silverstone's esses, Spa's Eau Rouge
// kink) — hand-drawn for the HUD aesthetic, not surveyed GPS geometry.
const TRACK_PATHS = {
  'Monza': "M28,78 L145,74 L156,58 L168,74 L300,70 C338,69 358,82 358,102 C358,122 336,130 300,127 L110,118 C62,116 28,108 28,78 Z",
  'Silverstone': "M45,52 C72,24 128,18 168,34 C186,41 184,56 202,58 C222,60 226,42 252,44 C296,47 314,72 298,94 C284,113 254,104 232,120 C204,140 148,136 106,122 C64,108 45,92 45,52 Z",
  'Spa-Francorchamps': "M26,118 C20,90 34,66 60,64 C78,63 74,44 96,38 C150,22 240,20 292,40 C326,53 344,76 330,98 C318,116 278,110 252,124 C214,144 130,146 78,130 C48,121 30,132 26,118 Z",
};

function renderTrackSvg(progressFrac, trackName) {
  const path = TRACK_PATHS[trackName] || TRACK_PATHS['Monza'];
  const wrap = $('track-map');
  wrap.innerHTML = `
    <svg viewBox="0 0 400 160">
      <path id="trackpath" d="${path}" fill="none" stroke="#1b2530" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="${path}" fill="none" stroke="#35e0f0" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="1200" stroke-dashoffset="${1200 - progressFrac * 1200}" opacity="0.9"/>
      <circle id="track-marker" r="6" fill="#f5b942"/>
      <circle id="track-start" r="3" fill="#6c7c8c"/>
    </svg>`;
  const p = document.getElementById('trackpath');
  const marker = document.getElementById('track-marker');
  const startPt = p.getPointAtLength(0);
  document.getElementById('track-start').setAttribute('cx', startPt.x);
  document.getElementById('track-start').setAttribute('cy', startPt.y);
  const len = p.getTotalLength();
  const pt = p.getPointAtLength(len * progressFrac);
  marker.setAttribute('cx', pt.x);
  marker.setAttribute('cy', pt.y);
}

// ---------- Sparklines ----------
function drawSpark(canvasId, series, colors) {
  const canvas = $(canvasId);
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const allVals = series.flatMap(s => s.values);
  if (!allVals.length) return;
  const min = Math.min(...allVals), max = Math.max(...allVals);
  const pad = (max - min) * 0.15 || 1;
  const lo = min - pad, hi = max + pad;

  ctx.strokeStyle = '#141b24';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const y = (h / 3) * i;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }

  series.forEach((s, si) => {
    const vals = s.values;
    if (vals.length < 2) return;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    vals.forEach((v, i) => {
      const x = (i / (vals.length - 1)) * w;
      const y = h - ((v - lo) / (hi - lo)) * h;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
  });
}

// ---------- Scenario picker ----------
async function loadScenarios() {
  const res = await fetch('/api/scenarios');
  state.scenarios = await res.json();
  const nav = $('scenario-picker');
  nav.innerHTML = state.scenarios.map(s =>
    `<button class="scn-btn" data-id="${s.id}">${s.label}</button>`
  ).join('');
  nav.querySelectorAll('.scn-btn').forEach(btn => {
    btn.addEventListener('click', () => selectScenario(btn.dataset.id));
  });
  selectScenario(state.scenarios[0].id);
}

function selectScenario(id) {
  state.current = state.scenarios.find(s => s.id === id);
  state.currentLapIdx = 0;
  state.history = [];
  state.seenEvents = new Set();
  $('events-list').innerHTML = '<div class="event-empty">No events yet — advance the lap.</div>';

  document.querySelectorAll('.scn-btn').forEach(b => b.classList.toggle('active', b.dataset.id === id));
  $('session-track').textContent = state.current.track.toUpperCase();
  $('session-type').textContent = state.current.session.toUpperCase();
  const wx = state.current.weather;
  $('wx-track').textContent = `${wx.track_c}°C`;
  $('wx-air').textContent = `${wx.air_c}°C`;
  $('wx-cond').textContent = wx.condition;
  $('wx-wind').textContent = `${wx.wind_kmh} km/h`;
  $('wx-pitloss').textContent = `${state.current.pit_stop_loss_sec.toFixed(1)}s`;

  fetchLap(state.current.first_lap);
}

// ---------- Fetch + render a lap decision ----------
async function fetchLap(lap) {
  setThinking(true);
  const res = await fetch(`/api/scenario/${state.current.id}/lap/${lap}`);
  const data = await res.json();
  setThinking(false);
  if (data.error) {
    $('decision-call').textContent = 'ANALYSIS ERROR';
    $('decision-call').className = 'decision-call';
    return;
  }
  state.history.push(data);
  render(data);
  updateEvents(data);
}

function setThinking(on) {
  $('btn-next').disabled = on;
  $('btn-prev').disabled = on;
  $('btn-play').disabled = on;
  if (on) {
    $('decision-call').textContent = 'ANALYZING TELEMETRY…';
    $('decision-call').className = 'decision-call thinking';
  }
}

function render(data) {
  const lap = data.latest_lap;
  const p = data.progress;

  $('lap-counter').textContent = `LAP ${p.current_lap} / ${p.total_laps}`;
  const frac = (p.current_lap - 1) / (p.total_laps - 1);
  renderTrackSvg(Math.min(Math.max(frac, 0), 1), data.meta.track);
  $('lap-progress-fill').style.width = `${(p.current_lap - p.first_lap) / (p.last_lap - p.first_lap) * 100}%`;

  // Callouts
  $('v-fl').textContent = `${lap.tire_temps_c.FL}°C · ${lap.tire_wear_pct.FL}%`;
  $('v-fr').textContent = `${lap.tire_temps_c.FR}°C · ${lap.tire_wear_pct.FR}%`;
  $('v-rl').textContent = `${lap.tire_temps_c.RL}°C · ${lap.tire_wear_pct.RL}%`;
  $('v-rr').textContent = `${lap.tire_temps_c.RR}°C · ${lap.tire_wear_pct.RR}%`;
  $('v-pu').textContent = `${lap.engine_temp_c}°C · ${lap.engine_temp_c > 122 ? 'HOT' : 'NOMINAL'}`;
  $('v-energy').textContent = `${lap.energy_pct}%`;
  $('v-brakes').textContent = `${lap.brake_temp_c}°C`;
  $('v-fuel').textContent = `${lap.fuel_kg} kg`;

  // Standings (synthesized from gap data — no full grid in the telemetry)
  $('row-ahead').querySelector('.gap').textContent = `-${lap.gap_ahead_sec.toFixed(1)}s`;
  $('row-ahead').querySelector('.name').textContent = 'CAR AHEAD';
  $('row-ahead').querySelector('.pos').textContent = '–1';
  $('row-us').querySelector('.gap').textContent = '—';
  $('row-us').querySelector('.name').textContent = lap.driver;
  $('row-us').querySelector('.pos').textContent = 'P—';
  $('row-behind').querySelector('.gap').textContent = `+${lap.gap_behind_sec.toFixed(1)}s`;
  $('row-behind').querySelector('.name').textContent = 'CAR BEHIND';
  $('row-behind').querySelector('.pos').textContent = '+1';

  // Charts (last up to 8 laps seen this session)
  const hist = state.history.slice(-8);
  drawSpark('chart-pace', [{ values: hist.map(h => h.latest_lap.lap_time_sec), color: '#35e0f0' }]);
  $('chart-pace-val').textContent = `${lap.lap_time_sec.toFixed(1)}s`;
  drawSpark('chart-wear', [
    { values: hist.map(h => h.latest_lap.tire_wear_pct.FL), color: '#35e0f0' },
    { values: hist.map(h => h.latest_lap.tire_wear_pct.FR), color: '#f5b942' },
    { values: hist.map(h => h.latest_lap.tire_wear_pct.RL), color: '#37e08a' },
    { values: hist.map(h => h.latest_lap.tire_wear_pct.RR), color: '#ff5f56' },
  ]);
  $('chart-wear-val').textContent = `${Math.max(...Object.values(lap.tire_wear_pct))}%`;
  drawSpark('chart-pu', [{ values: hist.map(h => h.latest_lap.engine_temp_c), color: '#f5b942' }]);
  $('chart-pu-val').textContent = `${lap.engine_temp_c}°C`;

  // Decision
  const call = data.decision.call || data.decision.raw || 'NO CALL';
  const label = call.split('.')[0].split(',')[0].toUpperCase();
  const dEl = $('decision-call');
  dEl.textContent = label;
  dEl.className = 'decision-call ' +
    (/BOX/.test(label) ? 'box' : /STAY/.test(label) ? 'stay' : /MANAGE/.test(label) ? 'manage' : '');
  $('decision-sub').textContent = call.replace(label, '').replace(/^[.,]\s*/, '') || lap.tire_compound.toUpperCase() + ' TYRES';
  $('dstat-confidence').textContent = data.decision.confidence_pct != null ? `${data.decision.confidence_pct}%` : '—';
  $('dstat-latency').textContent = `${data.elapsed_sec}s`;
  $('dstat-alt').textContent = data.decision.alternative_considered || '—';

  // Tool pills + evidence
  $('tool-pills').innerHTML = data.tool_calls.map(t => `<span class="pill active">${t.tool}()</span>`).join('');
  $('evidence-list').innerHTML = (data.decision.evidence || []).map(e => `<div class="evidence-item">${e}</div>`).join('');

  const regEl = $('reg-citation');
  const citation = data.decision.regulation_citation;
  if (citation && citation !== 'null') {
    regEl.style.display = 'flex';
    $('reg-citation-text').textContent = `FIA ${citation}`;
  } else {
    regEl.style.display = 'none';
  }

  speakDecision(label, $('decision-sub').textContent);
}

// ---------- Event feed ----------
function updateEvents(data) {
  const lap = data.latest_lap;
  const results = {};
  data.tool_calls.forEach(t => results[t.tool] = t.result);
  const events = [];

  if (lap.track_status !== 'green' && !state.seenEvents.has('flag_' + lap.track_status)) {
    state.seenEvents.add('flag_' + lap.track_status);
    events.push({ type: 'warn', ic: '⚑', title: `${lap.track_status.replace('_', ' ').toUpperCase()}`, sub: 'Track status change' });
  }
  if (results.estimate_degradation?.cliff_imminent && !state.seenEvents.has('cliff')) {
    state.seenEvents.add('cliff');
    events.push({ type: 'danger', ic: '◒', title: 'Tyre cliff imminent', sub: `${results.estimate_degradation.tire} wear at ${results.estimate_degradation.current_wear_pct}%` });
  }
  if (results.assess_traffic_risk?.under_attack && !state.seenEvents.has('attack')) {
    state.seenEvents.add('attack');
    events.push({ type: 'warn', ic: '⚠', title: 'Under attack', sub: `Gap behind closing — ${results.assess_traffic_risk.gap_behind_sec}s` });
  }
  if (results.assess_traffic_risk?.drs_range_ahead && !state.seenEvents.has('drs')) {
    state.seenEvents.add('drs');
    events.push({ type: 'info', ic: '➤', title: 'DRS range ahead', sub: `Gap ${results.assess_traffic_risk.gap_ahead_sec}s — overtake opportunity` });
  }
  if (results.safety_car_pit_value?.rare_opportunity && !state.seenEvents.has('sc_opp')) {
    state.seenEvents.add('sc_opp');
    events.push({ type: 'info', ic: '★', title: 'Cheap pit window', sub: `Saves ${results.safety_car_pit_value.sec_saved_vs_normal_pit}s vs. normal stop` });
  }

  if (!events.length) return;
  const list = $('events-list');
  if (list.querySelector('.event-empty')) list.innerHTML = '';
  events.forEach(e => {
    const row = document.createElement('div');
    row.className = `event-row ${e.type}`;
    row.innerHTML = `<span class="event-time">L${lap.lap}</span><span class="event-ic">${e.ic}</span><div class="event-body"><strong>${e.title}</strong><span>${e.sub}</span></div>`;
    list.prepend(row);
  });
}

// ---------- Controls ----------
$('btn-next').addEventListener('click', () => step(1));
$('btn-prev').addEventListener('click', () => step(-1));
$('btn-play').addEventListener('click', togglePlay);
$('btn-voice').addEventListener('click', toggleVoice);

function step(dir) {
  const laps = state.current;
  const cur = state.history.length ? state.history[state.history.length - 1].progress.current_lap : laps.first_lap;
  const next = cur + dir;
  if (next < laps.first_lap || next > laps.last_lap) return;
  fetchLap(next);
}

function togglePlay() {
  state.playing = !state.playing;
  $('btn-play').textContent = state.playing ? '⏸ PAUSE' : '▶ PLAY';
  if (state.playing) playLoop();
}

async function playLoop() {
  while (state.playing) {
    const cur = state.history[state.history.length - 1].progress.current_lap;
    if (cur >= state.current.last_lap) { state.playing = false; $('btn-play').textContent = '▶ PLAY'; break; }
    await fetchLap(cur + 1);
  }
}

// ---------- Init ----------
renderCarSvg();
loadScenarios();
