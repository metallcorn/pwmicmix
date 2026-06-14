'use strict';

// ===== state ============================================================== //
let channels = [];
let master = 1.0;
let masterMuted = false;
let devices = [];
const vu = {};                 // mic_id -> {lvl, peak, clipStart}
let masterVu = { lvl: 0, peak: 0 };
let modalMode = 'add', reassignMic = null, selDevice = null;
let authed = false, serverDown = false, packaged = false;

// ===== api ================================================================ //
async function api(path, body) {
  const opt = body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : {};
  const r = await fetch('/api/' + path, opt);
  if (r.status === 401) { showLogin(); throw new Error('auth'); }
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
}

// ===== helpers ============================================================ //
function gainToDb(g) {
  if (g <= 0.0001) return '−∞';
  const db = 20 * Math.log10(g);
  if (Math.abs(db) < 0.3) return '0 dB';
  const v = Math.abs(db) >= 10 ? db.toFixed(0) : db.toFixed(1);
  return (db > 0 ? '+' + v : v) + ' dB';
}
// Fader uses a dB-linear taper (like a real console): even resolution along the
// whole travel instead of cramming everything below −30 dB into the last 3%.
const FADER_MIN_DB = -60, FADER_MAX_DB = 12;     // headroom for makeup gain (boost)
const FADER_MARKS = [12, 6, 0, -12, -24, -40];   // dB labels, positioned by value
function sliderToGain(v) {
  v = +v;
  if (v <= 0) return 0;
  const db = FADER_MIN_DB + (v / 100) * (FADER_MAX_DB - FADER_MIN_DB);
  return Math.pow(10, db / 20);
}
function gainToSlider(g) {
  if (g <= 0) return 0;
  const db = Math.max(FADER_MIN_DB, Math.min(FADER_MAX_DB, 20 * Math.log10(g)));
  return Math.round(((db - FADER_MIN_DB) / (FADER_MAX_DB - FADER_MIN_DB)) * 100);
}
function faderScaleHtml() {
  const span = FADER_MAX_DB - FADER_MIN_DB;
  let h = FADER_MARKS.map((db) => {
    const pos = ((FADER_MAX_DB - db) / span) * 100;
    const lbl = db > 0 ? '+' + db : String(db);
    return `<span style="top:${pos.toFixed(1)}%"${db === 0 ? ' class="unity"' : ''}>${lbl}</span>`;
  }).join('');
  h += '<span style="top:100%">−∞</span>';
  return '<div class="fader-scale">' + h + '</div>';
}

// RMS amplitude (0..1) → meter height % on a dB scale.
// METER_GAIN lifts the scale so normal signals fill the meter confidently
// (we show RMS, which sits lower than the peak meters other apps display).
const METER_GAIN_DB = 12;    // makeup — higher = more sensitive to quiet audio
const METER_RANGE_DB = 72;   // window floor ≈ −84 dBFS so very quiet sources still register
function rmsToPct(rms) {
  if (rms <= 0.00001) return 0;
  const db = 20 * Math.log10(rms) + METER_GAIN_DB;
  return Math.max(0, Math.min(100, ((db + METER_RANGE_DB) / METER_RANGE_DB) * 100));
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function plural(n, one, many) { return n === 1 ? one : many; }

async function withSpin(btn, fn) {
  if (!btn) return fn();
  btn.classList.add('loading'); btn.disabled = true;
  try { return await fn(); }
  finally { btn.classList.remove('loading'); btn.disabled = false; }
}

// ===== boot =============================================================== //
async function boot() {
  // a QR link carries ?pin=… — sign in automatically, then clean the URL
  const pin = new URLSearchParams(location.search).get('pin');
  if (pin) {
    try {
      await fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }) });
    } catch (_) {}
    history.replaceState(null, '', location.pathname);
  }
  try {
    const { authed: ok } = await api('ping');
    if (ok) { authed = true; init(); }
    else showLogin();
  } catch (_) { /* showLogin already triggered, or transient */ }
}

function init() {
  hideLogin();
  loadState();
  loadPresets();
}

async function loadState() {
  try {
    const data = await api('channels');
    channels = data.channels; master = data.master; masterMuted = !!data.master_muted;
    packaged = !!data.packaged;   // AppImage build → no terminal, offer in-UI restart
    // link groups are UI-only — restore them from localStorage
    try {
      linked.clear();
      JSON.parse(localStorage.getItem('am_links') || '[]')
        .forEach((id) => { if (channels.some((c) => c.mic_id === id)) linked.add(id); });
    } catch (_) {}
    renderAll();
    if (channels.length === 0) openAddModal();
  } catch (_) {}
}

// ===== login ============================================================== //
function showLogin() {
  authed = false;
  document.getElementById('login').classList.add('open');
  setTimeout(() => document.getElementById('pin').focus(), 100);
}
function hideLogin() { document.getElementById('login').classList.remove('open'); }

async function submitPin() {
  const inp = document.getElementById('pin');
  const err = document.getElementById('loginErr');
  const pin = inp.value.trim();
  if (!pin) return;
  await withSpin(document.getElementById('loginBtn'), async () => {
    const r = await fetch('/api/auth', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }),
    });
    if (r.ok) { authed = true; err.textContent = ''; init(); }
    else {
      err.textContent = 'Wrong PIN, try again';
      inp.classList.add('bad'); inp.value = '';
      setTimeout(() => inp.classList.remove('bad'), 450);
    }
  });
}
document.getElementById('pin').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitPin(); });

// ===== rendering ========================================================== //
function renderAll() {
  const strip = document.getElementById('strip');
  strip.innerHTML = '';
  strip.appendChild(makeMaster());
  channels.forEach((ch) => {
    if (!vu[ch.mic_id]) vu[ch.mic_id] = { lvl: 0, peak: 0, clipStart: 0 };
    strip.appendChild(makeChannel(ch));
  });
  const add = document.createElement('div');
  add.className = 'ch add';
  add.onclick = () => openAddModal();
  add.innerHTML = '<div class="add-inner"><div class="add-plus">+</div><div class="add-label">Add channel</div></div>';
  strip.appendChild(add);
  channels.forEach((c) => setGateVisual(c.mic_id));   // now the nodes are in the DOM
  updateHeader();
  // keep a fader always selected so keyboard control + highlight are visible
  if (selected !== 'master' && !channels.some((c) => c.mic_id === selected)) {
    selected = channels.length ? channels[0].mic_id : null;
  }
  refreshFaderHighlight();
}

function updateHeader() {
  const active = channels.filter((c) => c.active).length;
  document.getElementById('chcount').textContent = channels.length + ' ' + plural(channels.length, 'channel', 'channels');
  document.getElementById('subtitle').textContent = channels.length
    ? (active + ' of ' + channels.length + ' ' + plural(channels.length, 'channel', 'channels') + ' live')
    : 'no active channels';
  document.getElementById('dot').className = connLost ? 'dot lost' : 'dot' + (active ? ' live' : '');
  const srcs = [...new Set(channels.map((c) => c.src_label).filter(Boolean))];
  document.getElementById('devlabel').textContent = srcs.length ? srcs.join(', ') : '—';
  document.getElementById('btnStop').style.display = channels.length && active > 0 ? '' : 'none';
  document.getElementById('btnRun').style.display = channels.length && active === 0 ? '' : 'none';
  document.getElementById('btnRestart').style.display = packaged ? '' : 'none';  // no terminal → in-UI restart
}

function makeMaster() {
  const d = document.createElement('div');
  d.className = 'ch master';
  d.innerHTML = `
    <div class="ch-top"><span class="ch-id">MASTER</span></div>
    <div class="ch-name"><strong>Master</strong><small>all channels</small></div>
    <div class="meter-area">
      <div class="vu"><div class="vu-fill g" id="vuMaster"></div><div class="vu-peak" id="pkMaster"></div></div>
    </div>
    <div class="led" style="visibility:hidden"></div>
    <div class="fader-wrap">
      <div class="fader-row">${faderScaleHtml()}<input type="range" class="fader" min="0" max="100" value="${gainToSlider(master)}" id="faderMaster"></div>
      <span class="fader-db" id="dbMaster">${gainToDb(master)}</span>
    </div>
    <div class="ch-foot">
      <span class="badge ${masterMuted ? 'mute' : 'off'}" id="badgeMaster">${masterMuted ? 'muted' : 'mix'}</span>
      <div class="foot-ctl"><button class="mutebtn${masterMuted ? ' on' : ''}" id="muteMaster" onclick="toggleMasterMute()" title="Mute all (Ctrl+Alt+M)">M</button></div>
    </div>`;
  const f = d.querySelector('#faderMaster');
  f.oninput = () => applyMaster(+f.value);
  f.onpointerdown = () => selectChannel('master');
  d.querySelector('#dbMaster').onclick = () => editDb('master');
  return d;
}

function applyMaster(sliderVal) {
  deactivatePreset();
  const g = sliderToGain(sliderVal);
  master = g;
  document.getElementById('dbMaster').textContent = gainToDb(g);
  // refresh every channel's "with master" readout
  channels.forEach((c) => {
    const dbg = document.getElementById('dbg_' + c.mic_id);
    if (dbg) dbg.textContent = '↳ ' + gainToDb(c.gain * g);
  });
  throttle('m', () => api('master', { gain: g }).catch(() => {}));
}

const LINK_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 12h6"/><path d="M10 8H8a4 4 0 0 0 0 8h2"/><path d="M14 8h2a4 4 0 0 1 0 8h-2"/></svg>';
const GEAR_ICON = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8"/></svg>';

function makeChannel(ch) {
  const d = document.createElement('div');
  d.id = 'ch_' + ch.mic_id;
  d.className = 'ch' + (ch.active ? ' active' : ' muted')
    + (linked.has(ch.mic_id) ? ' linked' : '');
  const s = ch.active ? 'ok' : 'off';
  const badge = { ok: 'live', off: 'off' };
  d.innerHTML = `
    <div class="ch-top">
      <span class="ch-id">#${ch.id}</span>
      <div class="ch-acts">
        <button class="ic" title="Reassign" onclick="openReassign('${ch.mic_id}')">⚙</button>
        <button class="ic del" title="Remove" onclick="removeChannel('${ch.mic_id}')">✕</button>
      </div>
    </div>
    <div class="ch-name" id="name_${ch.mic_id}" ondblclick="startRename('${ch.mic_id}')" title="Double-click to rename">
      <strong>${esc(ch.name)}</strong>
      <small>${esc(ch.port_label || ch.src_label || '')}</small>
    </div>
    <div class="meter-area">
      <div class="vu" id="vuc_${ch.mic_id}">
        <div class="vu-fill g" id="vu_${ch.mic_id}"></div>
        <div class="vu-peak" id="pk_${ch.mic_id}"></div>
        <div class="gate-line off" id="gate_${ch.mic_id}" title="Noise gate threshold — drag"><span class="gate-grip"></span></div>
      </div>
    </div>
    <div class="led" id="led_${ch.mic_id}"></div>
    <div class="fader-wrap">
      <div class="fader-row">${faderScaleHtml()}<input type="range" class="fader" min="0" max="100" value="${gainToSlider(ch.gain)}" id="fader_${ch.mic_id}"></div>
      <div class="db-stack">
        <span class="fader-db" id="db_${ch.mic_id}" title="Channel gain — click to type">${gainToDb(ch.gain)}</span>
        <span class="fader-db2" id="dbg_${ch.mic_id}" title="With master">↳ ${gainToDb(ch.gain * master)}</span>
      </div>
      <div class="knob-wrap"><button class="ng-gear" title="Gate settings" onclick="openNgCfg(event,'${ch.mic_id}')">${GEAR_ICON}</button><div class="gate-knob off" id="knob_${ch.mic_id}" title="Noise gate threshold — drag / wheel / [ ]"><i></i></div><span class="knob-lbl" id="ngval_${ch.mic_id}">NG</span></div>
    </div>
    <div class="ch-foot">
      <span class="badge ${s === 'ok' ? 'ok' : 'off'}" id="badge_${ch.mic_id}">${badge[s]}</span>
      <div class="foot-ctl">
        <button class="lockbtn${linked.has(ch.mic_id) ? ' on' : ''}" id="lock_${ch.mic_id}" title="Link faders to move together (L)" onclick="toggleLink('${ch.mic_id}')">${LINK_ICON}</button>
        <button class="solobtn${ch.solo ? ' on' : ''}" id="solo_${ch.mic_id}" title="Solo (S) — hear only soloed channels; clears mute" onclick="toggleSolo('${ch.mic_id}')">S</button>
        <button class="mutebtn${ch.muted ? ' on' : ''}" id="mute_${ch.mic_id}" title="Mute (M)" onclick="toggleMute('${ch.mic_id}')">M</button>
      </div>
    </div>`;
  faderPrev[ch.mic_id] = gainToSlider(ch.gain);
  const f = d.querySelector('#fader_' + cssEsc(ch.mic_id));
  f.oninput = () => onFaderInput(ch.mic_id, +f.value);
  f.onpointerdown = () => selectChannel(ch.mic_id);
  f.onwheel = (e) => faderWheel(ch.mic_id, e);
  d.querySelector('#db_' + cssEsc(ch.mic_id)).onclick = () => editDb(ch.mic_id);
  const gl = d.querySelector('#gate_' + cssEsc(ch.mic_id));
  gl.onpointerdown = (e) => gateDragStart(ch.mic_id, e);
  gl.onwheel = (e) => { if (e.ctrlKey || e.metaKey) return; e.preventDefault(); setGate(ch.mic_id, gatePct(ch.mic_id) + (e.deltaY < 0 ? 3 : -3)); };
  const kn = d.querySelector('#knob_' + cssEsc(ch.mic_id));
  kn.onpointerdown = (e) => knobDragStart(ch.mic_id, e);
  kn.onwheel = (e) => { if (e.ctrlKey || e.metaKey) return; e.preventDefault(); setGate(ch.mic_id, gatePct(ch.mic_id) + (e.deltaY < 0 ? 3 : -3)); };
  return d;   // gate visual is set in renderAll, once the node is in the DOM
}
const cssEsc = (s) => (window.CSS && CSS.escape) ? CSS.escape(s) : s;

// ===== fader link (gang) + selection + hotkeys =========================== //
const linked = new Set();     // mic_ids whose faders move together
const faderPrev = {};         // mic_id -> last slider value (for relative delta)
let selected = null;          // 'master' | mic_id | null

function saveLinks() { try { localStorage.setItem('am_links', JSON.stringify([...linked])); } catch (_) {} }
function toggleLink(mic_id) {
  if (linked.has(mic_id)) linked.delete(mic_id); else linked.add(mic_id);
  saveLinks();
  const el = document.getElementById('ch_' + mic_id);
  if (el) {
    el.classList.toggle('linked', linked.has(mic_id));
    const b = document.getElementById('lock_' + mic_id);
    if (b) b.classList.toggle('on', linked.has(mic_id));
  }
  refreshFaderHighlight();   // group highlight may have changed
  deactivatePreset();
}

// ----- mute -------------------------------------------------------------- //
function setMuted(mic_id, muted) {
  const ch = channels.find((c) => c.mic_id === mic_id); if (!ch) return;
  deactivatePreset();
  ch.muted = muted;
  const b = document.getElementById('mute_' + mic_id);
  if (b) b.classList.toggle('on', muted);
  debounce('mu_' + mic_id, () => api('mute', { mic_id, muted }).catch(() => {}));
}
function toggleMute(mic_id) {
  const ch = channels.find((c) => c.mic_id === mic_id);
  if (ch) setMuted(mic_id, !ch.muted);
}
function toggleMasterMute() {
  deactivatePreset();
  masterMuted = !masterMuted;
  const b = document.getElementById('muteMaster'); if (b) b.classList.toggle('on', masterMuted);
  const bd = document.getElementById('badgeMaster');
  if (bd) { bd.textContent = masterMuted ? 'muted' : 'mix'; bd.className = 'badge ' + (masterMuted ? 'mute' : 'off'); }
  api('master_mute', { muted: masterMuted }).catch(() => {});
}
function muteSet(ids) {
  ids = ids.filter((id) => channels.some((c) => c.mic_id === id));
  if (!ids.length) return;
  const allMuted = ids.every((id) => channels.find((c) => c.mic_id === id).muted);
  ids.forEach((id) => setMuted(id, !allMuted));   // toggle group as one
}

// ----- solo -------------------------------------------------------------- //
// Solo = only soloed channels are heard; the rest are silenced (server-side).
// Enabling solo clears that channel's mute; toggling solo off does NOT restore it.
function setSolo(ids, solo) {
  ids = ids.filter((id) => channels.some((c) => c.mic_id === id));
  if (!ids.length) return;
  deactivatePreset();
  ids.forEach((id) => {
    const ch = channels.find((c) => c.mic_id === id);
    ch.solo = solo;
    if (solo) ch.muted = false;        // mirror the backend (solo clears mute)
  });
  api('solo', { ids, solo }).catch(() => {});
  refreshSoloButtons();                // dimming of non-soloed channels comes via levels poll
}
function toggleSolo(mic_id) {
  const ch = channels.find((c) => c.mic_id === mic_id);
  if (ch) setSolo([mic_id], !ch.solo);
}
function soloSet(ids) {                 // group toggle (Alt+S)
  ids = ids.filter((id) => channels.some((c) => c.mic_id === id));
  if (!ids.length) return;
  const allSolo = ids.every((id) => channels.find((c) => c.mic_id === id).solo);
  setSolo(ids, !allSolo);
}
function refreshSoloButtons() {
  channels.forEach((c) => {
    const s = document.getElementById('solo_' + c.mic_id);
    if (s) s.classList.toggle('on', !!c.solo);
    const m = document.getElementById('mute_' + c.mic_id);   // solo may have cleared mute
    if (m) m.classList.toggle('on', !!c.muted);
  });
}

// ----- align link group to the anchor ----------------------------------- //
function alignGroup() {
  const ids = [...highlightedSet()].filter((x) => x !== 'master');
  if (ids.length < 2) { toast('Link 2+ channels (🔒), then Align', 'warn'); return; }
  const anchor = channels.find((c) => c.mic_id === selected) || channels.find((c) => c.mic_id === ids[0]);
  const v = gainToSlider(anchor.gain);
  ids.forEach((id) => {
    const f = document.getElementById('fader_' + id);
    if (f) { f.value = v; faderPrev[id] = v; setChannelFader(id, v); }
  });
}

// ----- help & clear modals ----------------------------------------------- //
function toggleHelp() { document.getElementById('help').classList.toggle('open'); }

// ── connect a phone: QR with the PIN baked in, switchable per network interface ──
let netinfo = null, qrIface = null;
async function openQr() {
  try { netinfo = await api('netinfo'); }
  catch (_) { toast('Could not read network info', 'err'); return; }
  const list = (netinfo.interfaces && netinfo.interfaces.length)
    ? netinfo.interfaces : [{ name: 'network', ip: netinfo.default }];
  const el = document.getElementById('qrIfaces');
  el.innerHTML = (list.length > 1 ? list : []).map(i =>
    `<button class="qr-iface" data-ip="${esc(i.ip)}" onclick="selectIface('${esc(i.ip)}')">${esc(i.name)} <b>${esc(i.ip)}</b></button>`
  ).join('');
  const def = list.find(i => i.ip === netinfo.default) || list[0];
  selectIface(def.ip);
  document.getElementById('qrmodal').classList.add('open');
}
function selectIface(ip) {
  qrIface = ip;
  document.querySelectorAll('.qr-iface').forEach(b => b.classList.toggle('on', b.dataset.ip === ip));
  document.getElementById('qrImg').src = '/api/qr?ip=' + encodeURIComponent(ip);
  document.getElementById('qrInfo').innerHTML = `http://${esc(ip)}:${esc(netinfo.port)} · PIN <b>${esc(netinfo.pin)}</b>`;
}
function closeQr() { document.getElementById('qrmodal').classList.remove('open'); }
function askClear() {
  if (!channels.length) { toast('No channels to remove'); return; }
  document.getElementById('clearModal').classList.add('open');
}
function closeClear() { document.getElementById('clearModal').classList.remove('open'); }
async function doClear() {
  await withSpin(document.getElementById('clearConfirm'), async () => {
    try { await api('stop', {}); channels = []; renderAll(); }
    catch (e) { toast('Error: ' + e.message, 'err'); }
  });
  closeClear();
}

// apply a slider value to one channel (DOM + gain + send)
function setChannelFader(mic_id, val) {
  const ch = channels.find((c) => c.mic_id === mic_id);
  if (!ch) return;
  deactivatePreset();
  const g = sliderToGain(val);
  ch.gain = g;
  const dbEl = document.getElementById('db_' + mic_id);
  if (dbEl) dbEl.textContent = gainToDb(g);
  const dbg = document.getElementById('dbg_' + mic_id);
  if (dbg) dbg.textContent = '↳ ' + gainToDb(g * master);
  throttle('v_' + mic_id, () => api('volume', { mic_id, gain: g }).catch(() => {}));
}

// quick volume tweak with the mouse wheel while hovering a fader
function faderWheel(mic_id, e) {
  if (e.ctrlKey || e.metaKey) return;     // Ctrl+wheel = zoom (handled globally)
  e.preventDefault();
  const f = document.getElementById('fader_' + mic_id); if (!f) return;
  const nv = Math.max(0, Math.min(100, +f.value + (e.deltaY < 0 ? 2 : -2)));
  f.value = nv; selectChannel(mic_id); onFaderInput(mic_id, nv);
}

// ----- noise gate UI ----------------------------------------------------- //
function pctToRms(pct) {
  if (pct <= 0) return 0;
  const db = (pct / 100) * METER_RANGE_DB - METER_GAIN_DB - METER_RANGE_DB;
  return Math.pow(10, db / 20);
}
function gatePct(mic_id) {
  const ch = channels.find((c) => c.mic_id === mic_id);
  return ch && ch.gate > 0 ? rmsToPct(ch.gate) : 0;
}
function setGateVisual(mic_id) {
  const ch = channels.find((c) => c.mic_id === mic_id); if (!ch) return;
  const pct = ch.gate > 0 ? rmsToPct(ch.gate) : 0;
  const off = ch.gate <= 0;
  const line = document.getElementById('gate_' + mic_id);
  if (line) { line.style.setProperty('--gate', pct.toFixed(1) + '%'); line.classList.toggle('off', off); }
  const kn = document.getElementById('knob_' + mic_id);
  if (kn) { kn.style.setProperty('--knob', ((pct / 100) * 270 - 135).toFixed(0) + 'deg'); kn.classList.toggle('off', off); }
  const lbl = document.getElementById('ngval_' + mic_id);
  if (lbl) lbl.textContent = off ? 'NG (off)' : 'NG (' + Math.round(20 * Math.log10(ch.gate)) + ')';
}
function setGate(mic_id, pct, send) {
  const ch = channels.find((c) => c.mic_id === mic_id); if (!ch) return;
  pct = Math.max(0, Math.min(100, pct));
  ch.gate = pct < 1 ? 0 : pctToRms(pct);   // bottom = off
  deactivatePreset();
  setGateVisual(mic_id);
  if (send !== false) throttle('g_' + mic_id, () => api('gate', { mic_id, threshold: ch.gate }).catch(() => {}));
}
function gateDragStart(mic_id, e) {
  e.preventDefault(); e.stopPropagation();
  const vu = document.getElementById('vuc_' + mic_id); if (!vu) return;
  const mobile = window.matchMedia('(max-width:640px)').matches;
  const move = (ev) => {
    const r = vu.getBoundingClientRect();
    const pct = mobile ? ((ev.clientX - r.left) / r.width * 100) : ((r.bottom - ev.clientY) / r.height * 100);
    setGate(mic_id, pct);
  };
  const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); };
  document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
  move(e);
}
// ----- noise-gate settings popup (Th / At / Hd / Rl / Hs) ---------------- //
const NG_PARAMS = [
  { k: 'th', label: 'Th', get: (c) => (c.gate > 0 ? Math.round(20 * Math.log10(c.gate)) : null), fmt: (v) => (v === null ? 'off' : v + ' dB'), step: 2, min: -90, max: 0 },
  { k: 'at', label: 'At', get: (c) => Math.round((c.gate_attack ?? 0.01) * 1000), fmt: (v) => v + ' ms', step: 5, min: 0, max: 200 },
  { k: 'hd', label: 'Hd', get: (c) => Math.round((c.gate_hold ?? 0.35) * 1000), fmt: (v) => v + ' ms', step: 25, min: 0, max: 2000 },
  { k: 'rl', label: 'Rl', get: (c) => Math.round((c.gate_release ?? 0.15) * 1000), fmt: (v) => v + ' ms', step: 25, min: 0, max: 1000 },
  { k: 'hs', label: 'Hs', get: (c) => Math.round(c.gate_hyst ?? 6), fmt: (v) => v + ' dB', step: 1, min: 0, max: 24 },
];
let ngMic = null;

function openNgCfg(e, mic) {
  e.stopPropagation();
  ngMic = mic;
  renderNgCfg();
  const pop = document.getElementById('ngcfg');
  pop.classList.add('open');                  // display it so we can measure its size
  const Z = uiZoom || 1;
  const r = e.currentTarget.getBoundingClientRect();
  // Screen-space size = unzoomed layout size × Z. (offsetWidth/Height, not
  // getBoundingClientRect, so the open-animation's transient scale/translate
  // doesn't corrupt the measurement.) The popup has its own `zoom`, which also
  // scales its top/left, so divide the final screen coords by Z when setting.
  const M = 8, pw = pop.offsetWidth * Z, ph = pop.offsetHeight * Z;
  let left = Math.min(Math.max(M, r.left - 40), window.innerWidth - pw - M);
  left = Math.max(M, left);
  // prefer below the gear; flip above when there isn't room (short screens / low channels)
  let top = r.bottom + 6;
  if (top + ph > window.innerHeight - M) {
    const above = r.top - ph - 6;
    top = above >= M ? above : Math.max(M, window.innerHeight - ph - M);
  }
  pop.style.left = (left / Z) + 'px';
  pop.style.top = (top / Z) + 'px';
  // Second pass: trust the real rendered rect over the arithmetic and nudge the
  // popup fully on-screen (covers any zoom edge case). style coords are /Z.
  requestAnimationFrame(() => {
    if (!pop.classList.contains('open')) return;
    const b = pop.getBoundingClientRect();
    let nl = b.left, nt = b.top;
    if (b.right > window.innerWidth - M) nl -= b.right - (window.innerWidth - M);
    if (b.bottom > window.innerHeight - M) nt -= b.bottom - (window.innerHeight - M);
    nl = Math.max(M, nl); nt = Math.max(M, nt);
    if (Math.abs(nl - b.left) > 0.5) pop.style.left = (nl / Z) + 'px';
    if (Math.abs(nt - b.top) > 0.5) pop.style.top = (nt / Z) + 'px';
  });
}
function closeNgCfg() { document.getElementById('ngcfg').classList.remove('open'); ngMic = null; }
function renderNgCfg() {
  const ch = channels.find((c) => c.mic_id === ngMic); if (!ch) return;
  const pop = document.getElementById('ngcfg');
  pop.innerHTML = '<div class="ngcfg-h">Noise gate</div>'
    + NG_PARAMS.map((p) => `<div class="ngrow" data-k="${p.k}" title="${p.label}">
        <span class="ngk">${p.label}</span>
        <span class="ngv" onclick="editNg('${p.k}')">${p.fmt(p.get(ch))}</span></div>`).join('')
    + `<div class="ngcfg-apply"><span>Apply to:</span>
        <button onclick="ngApply('all')">All</button>
        <button onclick="ngApply('linked')">Linked</button></div>`;
  pop.querySelectorAll('.ngrow').forEach((row) => {
    row.onwheel = (ev) => { if (ev.ctrlKey || ev.metaKey) return; ev.preventDefault(); nudgeNg(row.dataset.k, ev.deltaY < 0 ? 1 : -1); };
  });
}
function curNg(ch, p) { const v = p.get(ch); return v === null ? p.min : v; }
function setNg(k, v) {
  const ch = channels.find((c) => c.mic_id === ngMic); if (!ch) return;
  const p = NG_PARAMS.find((x) => x.k === k);
  v = Math.max(p.min, Math.min(p.max, Math.round(v)));
  const body = { mic_id: ngMic };
  if (k === 'th') { ch.gate = v <= p.min ? 0 : Math.pow(10, v / 20); body.threshold = ch.gate; setGateVisual(ngMic); }
  else if (k === 'at') { ch.gate_attack = v / 1000; body.attack = ch.gate_attack; }
  else if (k === 'hd') { ch.gate_hold = v / 1000; body.hold = ch.gate_hold; }
  else if (k === 'rl') { ch.gate_release = v / 1000; body.release = ch.gate_release; }
  else if (k === 'hs') { ch.gate_hyst = v; body.hyst = ch.gate_hyst; }
  throttle('ng_' + ngMic, () => api('gate', body).catch(() => {}));
  deactivatePreset();
  renderNgCfg();
}
function nudgeNg(k, dir) {
  const ch = channels.find((c) => c.mic_id === ngMic); if (!ch) return;
  const p = NG_PARAMS.find((x) => x.k === k);
  setNg(k, curNg(ch, p) + dir * p.step);
}
function editNg(k) {
  const ch = channels.find((c) => c.mic_id === ngMic); if (!ch) return;
  const p = NG_PARAMS.find((x) => x.k === k);
  const row = document.querySelector(`#ngcfg .ngrow[data-k="${k}"] .ngv`);
  if (!row || row.querySelector('input')) return;
  const inp = document.createElement('input'); inp.type = 'text'; inp.className = 'ng-edit';
  inp.value = (p.get(ch) === null ? '' : p.get(ch));
  row.textContent = ''; row.appendChild(inp); inp.focus(); inp.select();
  const done = (save) => { if (save) { const n = parseFloat(inp.value.replace(',', '.')); if (!isNaN(n)) setNg(k, n); else renderNgCfg(); } else renderNgCfg(); };
  inp.onblur = () => done(true);
  inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); done(true); } if (e.key === 'Escape') done(false); };
}
function ngApply(scope) {
  const ch = channels.find((c) => c.mic_id === ngMic); if (!ch) return;
  let targets = (scope === 'all' ? channels.map((c) => c.mic_id) : [...linked]).filter((id) => id !== ngMic && channels.some((c) => c.mic_id === id));
  if (!targets.length) { toast(scope === 'linked' ? 'No linked channels' : 'No other channels', 'warn'); return; }
  targets.forEach((id) => { const oc = channels.find((c) => c.mic_id === id); if (oc) { oc.gate_attack = ch.gate_attack; oc.gate_hold = ch.gate_hold; oc.gate_release = ch.gate_release; oc.gate_hyst = ch.gate_hyst; } });
  api('gate', { mic_id: ngMic, attack: ch.gate_attack, hold: ch.gate_hold, release: ch.gate_release, hyst: ch.gate_hyst, apply_to: targets }).catch(() => {});
  toast(`Gate shape copied to ${targets.length} ${plural(targets.length, 'channel', 'channels')}`);
}
document.addEventListener('click', (e) => {
  const pop = document.getElementById('ngcfg');
  if (pop.classList.contains('open') && !pop.contains(e.target)) closeNgCfg();
});

function knobDragStart(mic_id, e) {
  e.preventDefault();
  const base = gatePct(mic_id); const startY = e.clientY;
  const move = (ev) => setGate(mic_id, base + (startY - ev.clientY) * 0.6);
  const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); };
  document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
}

// fader moved → apply; if linked, move the whole link group by the same delta
function onFaderInput(mic_id, val) {
  const prev = faderPrev[mic_id] ?? val;
  const delta = val - prev;
  faderPrev[mic_id] = val;
  setChannelFader(mic_id, val);
  if (delta && linked.has(mic_id)) {
    linked.forEach((other) => {
      if (other === mic_id) return;
      const el = document.getElementById('fader_' + other);
      if (!el) return;
      const nv = Math.max(0, Math.min(100, (faderPrev[other] ?? +el.value) + delta));
      el.value = nv; faderPrev[other] = nv;
      setChannelFader(other, nv);
    });
  }
}

function selectChannel(id) {
  selected = id;
  const el = id === 'master' ? document.querySelector('.ch.master') : document.getElementById('ch_' + id);
  if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  refreshFaderHighlight();
}

// the set of channels a keypress would move: the selected one, plus its whole
// link group if it's linked
function highlightedSet() {
  if (!selected) return new Set();
  if (selected === 'master') return new Set(['master']);
  if (linked.has(selected)) return new Set(linked);
  return new Set([selected]);
}

function refreshFaderHighlight() {
  const set = highlightedSet();
  document.querySelectorAll('.ch.kbsel, .ch.selected').forEach((e) => {
    e.classList.remove('kbsel'); e.classList.remove('selected');
  });
  set.forEach((id) => {
    const el = id === 'master' ? document.querySelector('.ch.master') : document.getElementById('ch_' + id);
    if (el) el.classList.add('kbsel');
  });
  // mark the primary (the one numbers/clicks picked) distinctly
  const primary = selected === 'master' ? document.querySelector('.ch.master')
    : (selected ? document.getElementById('ch_' + selected) : null);
  if (primary) primary.classList.add('selected');
}

function moveSelection(dir) {
  const list = ['master', ...channels.map((c) => c.mic_id)];
  let i = list.indexOf(selected);
  i = i < 0 ? (dir > 0 ? 0 : list.length - 1) : (i + dir + list.length) % list.length;
  selectChannel(list[i]);
}

function nudgeGateSelected(step) {
  if (selected && selected !== 'master') setGate(selected, gatePct(selected) + step);
}

function nudgeSelected(step) {
  if (!selected) { moveSelection(1); return; }
  if (selected === 'master') {
    const f = document.getElementById('faderMaster'); if (!f) return;
    f.value = Math.max(0, Math.min(100, +f.value + step)); applyMaster(+f.value);
  } else {
    const f = document.getElementById('fader_' + selected); if (!f) return;
    const nv = Math.max(0, Math.min(100, +f.value + step));
    f.value = nv; onFaderInput(selected, nv);
  }
}

// click the dB readout → type an exact dB value
function editDb(target) {
  const id = target === 'master' ? 'dbMaster' : 'db_' + target;
  const el = document.getElementById(id);
  if (!el || el.querySelector('input')) return;
  const cur = target === 'master' ? master : (channels.find((c) => c.mic_id === target)?.gain ?? 0);
  const curDb = cur <= 0.0001 ? '-inf' : (20 * Math.log10(cur)).toFixed(1);
  const inp = document.createElement('input');
  inp.type = 'text'; inp.className = 'db-edit'; inp.value = curDb;
  el.textContent = ''; el.appendChild(inp); inp.focus(); inp.select();
  let done = false;
  const finish = (save) => {
    if (done) return; done = true;
    if (save) {
      const raw = inp.value.trim().replace(',', '.').replace(/d?b$/i, '').trim();
      let g;
      if (/^-?inf|−inf|-∞|−∞$/i.test(raw) || raw === '') g = NaN;
      else { const db = parseFloat(raw); g = isNaN(db) ? NaN : Math.pow(10, db / 20); }
      if (!isNaN(g)) {
        g = Math.max(0, Math.min(FADER_MAX_GAIN, g));
        const v = gainToSlider(g);
        const f = document.getElementById(target === 'master' ? 'faderMaster' : 'fader_' + target);
        if (f) f.value = v;
        if (target === 'master') applyMaster(v); else { faderPrev[target] = v; setChannelFader(target, v); }
      }
    }
    el.textContent = gainToDb(target === 'master' ? master : (channels.find((c) => c.mic_id === target)?.gain ?? 0));
  };
  inp.onblur = () => finish(true);
  inp.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  };
}
const FADER_MAX_GAIN = Math.pow(10, 12 / 20);   // +12 dB cap (matches fader top)

// ===== UI zoom ============================================================ //
// The packaged build runs in a native window with no browser chrome, so there
// are no zoom buttons. We zoom the UI ourselves via CSS `zoom` (Chromium /
// QtWebEngine) — Ctrl + =/−/0 and Ctrl+wheel — and remember it.
let uiZoom = 1;
try { const z = parseFloat(localStorage.getItem('am_zoom')); if (z >= 0.5 && z <= 2.5) uiZoom = z; } catch (_) {}
function applyZoom() {
  // Drive a CSS var that scales every UI *surface* (console, modals, QR, login,
  // popups, toasts) but not the page background / dimming backdrops — see the
  // `--ui-zoom` rule in style.css. Zooming the document instead would scale the
  // background and overflow the viewport.
  document.documentElement.style.zoom = '';                 // clear the old approach
  document.documentElement.style.setProperty('--ui-zoom', String(uiZoom));
  try { localStorage.setItem('am_zoom', String(uiZoom)); } catch (_) {}
}
function setZoom(z) { uiZoom = Math.max(0.5, Math.min(2.5, Math.round(z * 20) / 20)); applyZoom(); }
function zoomBy(d) { setZoom(uiZoom + d); }
applyZoom();
window.addEventListener('wheel', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;     // plain wheel stays with faders/gate
  e.preventDefault();
  zoomBy(e.deltaY < 0 ? 0.1 : -0.1);
}, { passive: false });

document.addEventListener('keydown', (e) => {
  if (document.getElementById('login').classList.contains('open')) return;
  const t = e.target;
  const typing = t && ((t.tagName === 'INPUT' && t.type !== 'range') || t.tagName === 'TEXTAREA');
  if ((e.ctrlKey || e.metaKey) && !e.altKey) {     // browser-style zoom shortcuts
    if (e.key === '=' || e.key === '+') { e.preventDefault(); zoomBy(0.1); return; }
    if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomBy(-0.1); return; }
    if (e.key === '0') { e.preventDefault(); setZoom(1); return; }
  }
  if (e.altKey && /^Digit[0-9]$/.test(e.code)) {
    e.preventDefault();
    const d = +e.code.slice(5);
    if (d === 0) selectChannel('master');
    else if (channels[d - 1]) selectChannel(channels[d - 1].mic_id);
    return;
  }
  if (e.code === 'KeyM' && !e.metaKey) {
    if (typing) return;
    e.preventDefault();
    if (e.ctrlKey && e.altKey) toggleMasterMute();           // global mute
    else if (e.altKey) muteSet([...highlightedSet()].filter((x) => x !== 'master'));
    else if (selected && selected !== 'master') muteSet([selected]);
    return;
  }
  if (e.code === 'KeyS' && !e.metaKey && !e.ctrlKey) {       // solo (S) / group (Alt+S)
    if (typing) return;
    e.preventDefault();
    if (e.altKey) soloSet([...highlightedSet()].filter((x) => x !== 'master'));
    else if (selected && selected !== 'master') soloSet([selected]);
    return;
  }
  if (e.key === 'Escape') {
    document.getElementById('help').classList.remove('open');
    document.getElementById('clearModal').classList.remove('open');
    document.getElementById('qrmodal').classList.remove('open');
    document.getElementById('quitModal').classList.remove('open');
    document.getElementById('restartModal').classList.remove('open');
  }
  if (typing || document.getElementById('modal').classList.contains('open')) return;
  if (e.code === 'KeyL' && e.altKey && !e.ctrlKey) {        // global unlink
    e.preventDefault(); if (linked.size) { linked.clear(); saveLinks(); renderAll(); } return;
  }
  if (e.code === 'KeyL' && !e.altKey && !e.ctrlKey) {       // link selected
    e.preventDefault(); if (selected && selected !== 'master') toggleLink(selected); return;
  }
  if (e.code === 'KeyN' && !e.altKey && !e.ctrlKey) {       // align group to anchor
    e.preventDefault(); alignGroup(); return;
  }
  if (/^Digit[1-9]$/.test(e.code) && !e.altKey && !e.ctrlKey && !e.metaKey) {   // recall preset
    e.preventDefault(); const p = presets[+e.code.slice(5) - 1]; if (p) applyPreset(p.id); return;
  }
  // [ and ] adjust the noise-gate threshold of the selected channel
  if (e.code === 'BracketRight') { e.preventDefault(); nudgeGateSelected(e.shiftKey ? 8 : 3); return; }
  if (e.code === 'BracketLeft') { e.preventDefault(); nudgeGateSelected(e.shiftKey ? -8 : -3); return; }
  if (e.key === 'ArrowUp') { e.preventDefault(); nudgeSelected(e.shiftKey ? 6 : 2); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); nudgeSelected(e.shiftKey ? -6 : -2); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); moveSelection(-1); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); moveSelection(1); }
});

// debounced senders
const timers = {};
function debounce(key, fn, ms = 60) { clearTimeout(timers[key]); timers[key] = setTimeout(fn, ms); }

// throttle: fire immediately, then at most once per `ms` while called repeatedly
// (used for fader/master/gate so dragging applies live, not only on release)
const throttles = {};
function throttle(key, fn, ms = 45) {
  const now = performance.now();
  const t = throttles[key] || (throttles[key] = { last: 0, timer: null });
  const wait = ms - (now - t.last);
  if (wait <= 0) { t.last = now; if (t.timer) { clearTimeout(t.timer); t.timer = null; } fn(); }
  else if (!t.timer) { t.timer = setTimeout(() => { t.last = performance.now(); t.timer = null; fn(); }, wait); }
}

// ===== level polling + connection watchdog =============================== //
let connLost = false, pollFails = 0;

async function pollLevels() {
  if (!authed || serverDown) return;     // serverDown = intentional UI shutdown
  try {
    const { levels, master: m } = await api('levels');
    applyLevels(levels, m);
    pollFails = 0;
    if (connLost) onReconnect();         // we were down — the backend is back
  } catch (e) {
    if (e && e.message === 'auth') return; // 401 → login overlay already shown
    if (!connLost && ++pollFails >= 3) setConnLost(true); // ~240 ms of failures
  }
}
const levelTimer = setInterval(pollLevels, 80);

// reflect a dead/unreachable backend: red dot, dimmed console, status text.
// keeps polling so it auto-recovers the moment the server comes back.
function setConnLost(v) {
  connLost = v;
  document.body.classList.toggle('disconnected', v);
  const dot = document.getElementById('dot');
  if (v) {
    dot.className = 'dot lost';
    document.getElementById('subtitle').textContent = 'connection lost — reconnecting…';
  } else {
    updateHeader();                      // restores dot + subtitle from real state
  }
}

async function onReconnect() {
  pollFails = 0;
  setConnLost(false);
  toast('Reconnected to the server');
  try { await loadState(); await loadPresets(); } catch (_) {} // server may have restarted
}

function setMeter(fillId, pkId, st, raw, isMaster) {
  const fill = document.getElementById(fillId);
  const pk = document.getElementById(pkId);
  if (!fill) return null;
  const pct = rmsToPct(raw);
  // meter ballistics: instant attack (jump to peaks), smooth release — makes
  // the bar leap confidently like a hardware/DAW meter instead of crawling.
  if (pct > st.lvl) st.lvl = pct; else st.lvl = st.lvl * 0.78 + pct * 0.22;
  if (st.lvl > st.peak) st.peak = st.lvl; else st.peak *= 0.96;
  fill.style.setProperty('--lvl', st.lvl.toFixed(1) + '%');
  fill.className = 'vu-fill ' + (st.lvl > 85 ? 'r' : st.lvl > 70 ? 'y' : 'g');
  if (pk) pk.style.setProperty('--peak', st.peak.toFixed(1) + '%');
  return st.lvl;
}

function applyLevels(levels, mLevel) {
  channels.forEach((ch) => {
    const st = vu[ch.mic_id]; if (!st) return;
    const fill = document.getElementById('vu_' + ch.mic_id); if (!fill) return;
    const led = document.getElementById('led_' + ch.mic_id);
    const badge = document.getElementById('badge_' + ch.mic_id);
    const chEl = document.getElementById('ch_' + ch.mic_id);
    const raw = levels[ch.mic_id];

    if (raw === 'off' || raw === 'muted' || !ch.active) {
      st.lvl = 0; st.peak = 0;
      fill.style.setProperty('--lvl', '0%'); fill.className = 'vu-fill g';
      const pk = document.getElementById('pk_' + ch.mic_id); if (pk) pk.style.setProperty('--peak', '0%');
      if (led) led.className = 'led';
      if (raw === 'muted') { setBadge(badge, 'mute', 'muted'); setChannelState(chEl, 'muted'); }
      else { setBadge(badge, 'off', 'off'); setChannelState(chEl, 'muted'); }
      st.clipStart = 0;
      return;
    }
    if (raw === 'no_route') {                 // source device/route is gone — real problem
      st.lvl *= 0.6; st.peak *= 0.97;
      fill.style.setProperty('--lvl', st.lvl.toFixed(1) + '%');
      if (led) led.className = 'led';
      setBadge(badge, 'err', 'no route'); setChannelState(chEl, 'active', 'nosignal'); st.clipStart = 0;
      return;
    }
    if (raw === 'no_signal') {                 // routed, just quiet — calm, no alarm
      st.lvl *= 0.6; st.peak *= 0.97;
      fill.style.setProperty('--lvl', st.lvl.toFixed(1) + '%');
      if (led) led.className = 'led';
      setBadge(badge, 'off', 'silent'); setChannelState(chEl, 'active'); st.clipStart = 0;
      return;
    }
    const lvl = setMeter('vu_' + ch.mic_id, 'pk_' + ch.mic_id, st, raw);
    const clipping = lvl > 92;
    if (led) led.className = 'led' + (clipping ? ' on' : '');
    if (clipping) { if (!st.clipStart) st.clipStart = performance.now(); } else st.clipStart = 0;
    const clipAlert = st.clipStart && performance.now() - st.clipStart > 500;
    if (clipAlert) {
      setBadge(badge, 'warn', 'clip'); setChannelState(chEl, 'active', 'clipping');
      maybeToast('clip_' + ch.mic_id, `“${ch.name}” is clipping — lower the level`, 'warn');
    } else { setBadge(badge, 'ok', 'live'); setChannelState(chEl, 'active'); }
  });
  setMeter('vuMaster', 'pkMaster', masterVu, mLevel || 0, true);
}

// update only the level-state classes, preserving kbsel/selected/linked etc.
function setChannelState(el, ...states) {
  if (!el) return;
  el.classList.remove('active', 'muted', 'clipping', 'nosignal');
  el.classList.add(...states);
}

function setBadge(el, cls, text) {
  if (!el) return;
  if (el.textContent !== text) el.textContent = text;
  const want = 'badge ' + cls;
  if (el.className !== want) el.className = want;
}

const toastSeen = {};
function maybeToast(key, msg, kind) {
  const now = performance.now();
  if (toastSeen[key] && now - toastSeen[key] < 4000) return;
  toastSeen[key] = now; toast(msg, kind);
}

// ===== channel actions ==================================================== //
async function toggleChannel(mic_id) {
  const ch = channels.find((c) => c.mic_id === mic_id); if (!ch) return;
  const sw = document.getElementById('sw_' + mic_id);
  if (sw) sw.classList.toggle('on');                    // optimistic
  try {
    const r = await api('toggle', { mic_id, active: !ch.active });
    ch.active = r.active; renderAll();
  } catch (e) { toast('Error: ' + e.message, 'err'); renderAll(); }
}

async function removeChannel(mic_id) {
  const ch = channels.find((c) => c.mic_id === mic_id);
  const el = document.getElementById('ch_' + mic_id);
  try {
    await api('remove', { mic_id });
    channels = channels.filter((c) => c.mic_id !== mic_id); delete vu[mic_id];
    // collapse just this node (neighbours slide in); no full re-render, so the
    // other strips don't re-animate.
    if (el) {
      el.classList.add('removing');
      el.addEventListener('animationend', () => { el.remove(); updateHeader(); }, { once: true });
      setTimeout(() => { if (el.isConnected) { el.remove(); updateHeader(); } }, 400);
    } else renderAll();
  } catch (e) { toast('Error: ' + e.message, 'err'); }
}

function startRename(mic_id) {
  const ch = channels.find((c) => c.mic_id === mic_id);
  const div = document.getElementById('name_' + mic_id);
  if (!ch || div.querySelector('input')) return;
  const small = ch.port_label || ch.src_label || '';
  const inp = document.createElement('input');
  inp.type = 'text'; inp.className = 'name-edit'; inp.value = ch.name;
  div.innerHTML = ''; div.appendChild(inp); inp.focus(); inp.select();
  let done = false;
  const finish = async (save) => {
    if (done) return; done = true;
    const v = save ? (inp.value.trim() || ch.name) : ch.name;
    div.innerHTML = `<strong>${esc(v)}</strong><small>${esc(small)}</small>`;
    if (save && v !== ch.name) { ch.name = v; try { await api('rename', { mic_id, name: v }); } catch (_) {} }
  };
  inp.onblur = () => finish(true);
  inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } if (e.key === 'Escape') finish(false); };
}

async function setEngine(active) {
  const btn = document.getElementById(active ? 'btnRun' : 'btnStop');
  await withSpin(btn, async () => {
    try {
      const r = await api('engine', { active });
      channels = r.channels; renderAll();
    } catch (e) { toast('Error: ' + e.message, 'err'); }
  });
}

// ⏻ Quit — show a styled confirmation (also invoked by the native window's close
// button via desktop.py → window.confirmQuit()). Exposed on window for that.
function confirmQuit() { document.getElementById('quitModal').classList.add('open'); }
function closeQuitModal() { document.getElementById('quitModal').classList.remove('open'); }

// Actually quit. In the packaged window we close the window (process exits);
// the lightweight pw-loopback mics stay alive so other apps don't drop. In a
// plain browser there's no window to close, so we stop the server + show the
// "stopped" screen.
async function doQuit() {
  closeQuitModal();
  const pv = window.pywebview;
  if (packaged && pv && pv.api && typeof pv.api.quit === 'function') {
    pv.api.quit();                 // desktop.py closes the window → process exits
    return;
  }
  await withSpin(document.getElementById('btnPower'), async () => {
    try { await api('shutdown', {}); } catch (_) {}
    serverDown = true; clearInterval(levelTimer);
    const note = document.getElementById('dsNote');
    if (note) note.innerHTML = (packaged
      ? 'Relaunch <b>AudioMixer</b> from your app menu to control them again.'
      : 'Run <code>./run.sh</code> to control them again.')
      + ' To remove mics, use ⏹ Stop first.';
    document.getElementById('downscreen').classList.add('open');
  });
}

// Re-exec the server in place — no terminal needed (packaged build). Mics keep
// running; the connection watchdog shows "reconnecting…" and recovers on its own.
function restartServer() { document.getElementById('restartModal').classList.add('open'); }
function closeRestartModal() { document.getElementById('restartModal').classList.remove('open'); }
async function doRestart() {
  closeRestartModal();
  await withSpin(document.getElementById('btnRestart'), async () => {
    try { await api('restart', {}); } catch (_) {}
    toast('Restarting…');
  });
}

// ===== modal: device list + waveform ===================================== //
const WAVE_W = 120, WAVE_H = 40, WAVE_N = 56;
let probeState = {}, probePollTimer = null, probeRaf = null;

function waveSvgHtml() {
  return `<svg class="dev-wave" viewBox="0 0 ${WAVE_W} ${WAVE_H}" preserveAspectRatio="none">`
    + '<path class="wave-fill" fill="url(#waveGrad)"></path><path class="wave-line"></path></svg>';
}
function wavePath(energy, phase, closed) {
  const center = WAVE_H - (5 + energy * 24), amp = 1.4 + energy * 7.5;
  let d = '';
  for (let i = 0; i <= WAVE_N; i++) {
    const x = (i / WAVE_N) * WAVE_W;
    const y = center + amp * Math.sin(x * 0.16 + phase) * Math.sin(x * 0.05 + phase * 0.6);
    d += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ' ' + y.toFixed(1) + ' ';
  }
  if (closed) d += `L${WAVE_W} ${WAVE_H} L0 ${WAVE_H} Z`;
  return d;
}
function startProbe() {
  stopProbeTimers(); probeState = {}; let idx = 0;
  document.querySelectorAll('#devList .dev').forEach((item) => {
    const id = item.getAttribute('data-dev'); const svg = item.querySelector('.dev-wave');
    probeState[id] = { svg, fill: svg.querySelector('.wave-fill'), line: svg.querySelector('.wave-line'), target: 0, lvl: 0, phase: idx * 0.9 };
    idx++;
  });
  const ids = Object.keys(probeState); if (!ids.length) return;
  api('probe', { devices: ids }).catch(() => {});
  probePollTimer = setInterval(() => {
    api('probe').then((lv) => { for (const id in probeState) probeState[id].target = lv[id] || 0; }).catch(() => {});
  }, 120);
  probeRaf = requestAnimationFrame(animWave);
}
function animWave() {
  for (const id in probeState) {
    const s = probeState[id];
    s.lvl += (s.target - s.lvl) * 0.3;
    const energy = Math.max(0, Math.min(1, (s.lvl - 0.02) * 1.9));
    s.phase += 0.16 + energy * 0.5;
    s.svg.style.opacity = (0.08 + energy * 0.55).toFixed(3);
    s.fill.setAttribute('d', wavePath(energy, s.phase, true));
    s.line.setAttribute('d', wavePath(energy, s.phase, false));
  }
  probeRaf = requestAnimationFrame(animWave);
}
function stopProbeTimers() { if (probePollTimer) clearInterval(probePollTimer), probePollTimer = null; if (probeRaf) cancelAnimationFrame(probeRaf), probeRaf = null; }
function stopProbe() { stopProbeTimers(); probeState = {}; api('probe/stop', {}).catch(() => {}); }

// ===== modal: add / reassign ============================================= //
async function openAddModal() {
  modalMode = 'add'; reassignMic = null; selDevice = null;
  document.getElementById('modalTitle').innerHTML = 'Add channel <button class="x" onclick="closeModal()">✕</button>';
  await renderDeviceList(); goStep(1); document.getElementById('modal').classList.add('open');
}
async function openReassign(mic_id) {
  modalMode = 'reassign'; reassignMic = mic_id; selDevice = null;
  const ch = channels.find((c) => c.mic_id === mic_id);
  document.getElementById('modalTitle').innerHTML = `Reassign “${esc(ch?.name)}” <button class="x" onclick="closeModal()">✕</button>`;
  document.getElementById('reassignName').textContent = ch?.name || '—';
  await renderDeviceList(); goStep(1); document.getElementById('modal').classList.add('open');
}
async function renderDeviceList() {
  const list = document.getElementById('devList');
  list.innerHTML = '<div class="hint-row">loading devices…</div>';
  try { devices = await api('devices'); }
  catch (e) { list.innerHTML = '<div class="hint-row">failed to load</div>'; return; }
  if (!devices.length) { list.innerHTML = '<div class="hint-row">no devices found</div>'; return; }
  list.innerHTML = devices.map((d, i) => `
    <div class="dev" data-dev="${esc(d.id)}" onclick="selectDevice(${i})">
      ${waveSvgHtml()}
      <div class="dev-main"><div class="dev-name">${esc(d.name)}</div><div class="dev-sub">${esc(d.sub)}</div></div>
      <span class="dev-arrow">›</span>
    </div>`).join('');
  startProbe();
}
function selectDevice(i) { selDevice = devices[i]; if (modalMode === 'add') buildAddPorts(); else buildReassignPorts(); }

function suggestName(dev, port, i) { return dev.ports.length === 1 ? dev.name : dev.name + ' ' + (port.channel || (i + 1)); }

function buildAddPorts() {
  document.getElementById('portList').innerHTML = selDevice.ports.map((p, i) => `
    <div class="port">
      <div class="port-head">
        <input type="checkbox" value="${esc(p.id)}" id="pc_${esc(p.id)}" ${selDevice.ports.length === 1 || i < 2 ? 'checked' : ''}>
        <label class="port-info" for="pc_${esc(p.id)}">${esc(p.label)}<small>${esc(selDevice.name)} · ${esc(p.id)}</small></label>
      </div>
      <input type="text" class="name-input" placeholder="display name" data-port="${esc(p.id)}" data-label="${esc(p.label)}" value="${esc(suggestName(selDevice, p, i))}">
    </div>`).join('');
  goStep(2);
}
function buildReassignPorts() {
  document.getElementById('reassignPortList').innerHTML = selDevice.ports.map((p, i) => `
    <div class="port">
      <div class="port-head">
        <input type="radio" name="rport" value="${esc(p.id)}" id="rp_${esc(p.id)}" data-label="${esc(p.label)}" ${i === 0 ? 'checked' : ''}>
        <label class="port-info" for="rp_${esc(p.id)}">${esc(p.label)}<small>${esc(selDevice.name)} · ${esc(p.id)}</small></label>
      </div>
    </div>`).join('');
  goStep('2r');
}
async function confirmAdd() {
  if (!selDevice) return;
  const chans = [];
  document.querySelectorAll('#portList .port').forEach((row) => {
    const cb = row.querySelector('input[type=checkbox]'); if (!cb || !cb.checked) return;
    const txt = row.querySelector('.name-input');
    chans.push({ port: cb.value, port_label: txt.dataset.label, name: txt.value.trim() });
  });
  if (!chans.length) { toast('Select at least one channel', 'warn'); return; }
  await withSpin(document.getElementById('addConfirm'), async () => {
    try {
      const r = await api('start', { device: selDevice.id, device_name: selDevice.name, channels: chans });
      r.created.forEach((c) => channels.push(c));
      closeModal(); renderAll();
    } catch (e) { toast('Routing error: ' + e.message, 'err'); }
  });
}
async function confirmReassign() {
  if (!reassignMic || !selDevice) return;
  const sel = document.querySelector('input[name=rport]:checked'); if (!sel) return;
  await withSpin(document.getElementById('reassignConfirm'), async () => {
    try {
      const r = await api('reassign', { mic_id: reassignMic, new_device: selDevice.id, new_device_name: selDevice.name, new_port: sel.value, new_port_label: sel.dataset.label });
      const i = channels.findIndex((c) => c.mic_id === reassignMic);
      if (i >= 0) channels[i] = r.channel;
      closeModal(); renderAll();
    } catch (e) { toast('Reassign error: ' + e.message, 'err'); }
  });
}
function goStep(n) { ['1', '2', '2r'].forEach((s) => document.getElementById('step' + s).classList.toggle('active', s === String(n))); }
function closeModal() { document.getElementById('modal').classList.remove('open'); stopProbe(); selDevice = null; reassignMic = null; }

// ===== toasts ============================================================= //
function toast(msg, kind) {
  const t = document.createElement('div');
  t.className = 'toast' + (kind ? ' ' + kind : '');
  t.innerHTML = `<span class="tdot"></span><span>${esc(msg)}</span>`;
  document.getElementById('toasts').appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 250); }, 2400);
}

// ===== presets (scenes) ================================================== //
// A preset stores the FULL mix scene. Forward/backward compatible: every field
// is optional and read defensively (a newer build adds fields older ones ignore;
// an older preset just misses the new fields). `v` marks the schema version.
const PRESET_V = 1;
let presets = [];
let activePreset = null;

function uid() { return 'p' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36); }

function captureScene() {
  const ch = {};
  channels.forEach((c) => {
    ch[c.mic_id] = {
      gain: c.gain, muted: !!c.muted, solo: !!c.solo, gate: c.gate || 0, name: c.name,
      ga: c.gate_attack, gh: c.gate_hold, gr: c.gate_release, ghy: c.gate_hyst,
    };
  });
  return { v: PRESET_V, master, links: [...linked], ch };
}
function neutralScene() {
  const ch = {};
  channels.forEach((c) => { ch[c.mic_id] = { gain: 1, muted: false, solo: false, gate: 0 }; });
  return { v: PRESET_V, master: 1, links: [], ch };
}
function savePresets() {
  try { localStorage.setItem('am_presets', JSON.stringify(presets)); } catch (_) {}
  api('presets', presets).catch(() => {});
}
async function loadPresets() {
  let list = [];
  try { list = await api('presets'); } catch (_) {}
  if (!Array.isArray(list) || !list.length) {
    try { list = JSON.parse(localStorage.getItem('am_presets') || '[]'); } catch (_) { list = []; }
  }
  presets = Array.isArray(list) ? list : [];
  renderPresets();
}
function renderPresets() {
  const bar = document.getElementById('presetbar');
  if (!bar) return;
  bar.innerHTML = '<span class="pb-label">Scenes</span>'
    + presets.map((p, i) => `<div class="preset${activePreset === p.id ? ' active' : ''}">
        <button class="preset-name" onclick="applyPreset('${p.id}')" title="Load scene${i < 9 ? ' (key ' + (i + 1) + ')' : ''}">${i < 9 ? `<span class="preset-num">${i + 1}</span>` : ''}${esc(p.name)}</button>
        <button class="preset-menu" onclick="togglePresetMenu(event,'${p.id}')">▾</button>
        <div class="preset-pop" id="pop_${p.id}">
          <button onclick="savePresetCurrent('${p.id}')">Save current state</button>
          <button onclick="renamePreset('${p.id}')">Rename</button>
          <button onclick="clearPreset('${p.id}')">Set to default (0 dB)</button>
          <button onclick="exportPreset('${p.id}')">Export…</button>
          <button class="danger" onclick="deletePreset('${p.id}')">Delete</button>
        </div></div>`).join('')
    + '<button class="preset-add" onclick="addPreset()" title="Save current mix as a new scene">+ Preset</button>';
}
// any manual change means the live mix no longer matches the loaded scene
function deactivatePreset() { if (activePreset !== null) { activePreset = null; renderPresets(); } }

function togglePresetMenu(e, id) {
  e.stopPropagation();
  const el = document.getElementById('pop_' + id);
  const open = el.classList.contains('open');
  document.querySelectorAll('.preset-pop.open').forEach((x) => x.classList.remove('open'));
  if (!open) {
    // The popup is position:fixed but lives inside the (possibly zoomed) .app, so
    // its top/right are interpreted in the zoomed coordinate space — divide the
    // screen-space rect by the zoom factor so it still lands under the trigger.
    const Z = uiZoom || 1;
    const r = e.currentTarget.getBoundingClientRect();   // fixed-position to escape overflow clipping
    el.style.top = (r.bottom / Z + 5) + 'px';
    el.style.right = ((window.innerWidth - r.right) / Z) + 'px';
    el.style.left = 'auto';
    el.classList.add('open');
  }
}
document.addEventListener('click', () => document.querySelectorAll('.preset-pop.open').forEach((x) => x.classList.remove('open')));

function addPreset() { presets.push({ id: uid(), name: 'Scene ' + (presets.length + 1), scene: captureScene() }); savePresets(); renderPresets(); }
function savePresetCurrent(id) { const p = presets.find((x) => x.id === id); if (!p) return; p.scene = captureScene(); savePresets(); renderPresets(); toast(`“${p.name}” updated`); }
function renamePreset(id) { const p = presets.find((x) => x.id === id); if (!p) return; const n = prompt('Scene name:', p.name); if (n !== null) { p.name = n.trim() || p.name; savePresets(); renderPresets(); } }
function clearPreset(id) { const p = presets.find((x) => x.id === id); if (!p) return; p.scene = neutralScene(); savePresets(); renderPresets(); toast(`“${p.name}” set to default`); }
function deletePreset(id) { presets = presets.filter((x) => x.id !== id); if (activePreset === id) activePreset = null; savePresets(); renderPresets(); }
function exportPreset(id) {
  const p = presets.find((x) => x.id === id); if (!p) return;
  const blob = new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (p.name || 'preset').replace(/[^a-z0-9]+/gi, '_') + '.json';
  a.click();
}
function glideFrom(id, fromVal) {                 // motorized-fader glide to current value
  const f = id === 'master' ? document.getElementById('faderMaster') : document.getElementById('fader_' + id);
  if (!f) return;
  const to = +f.value;
  if (Math.abs(to - fromVal) < 0.5) return;
  let t0 = null; const dur = 380;
  const step = (now) => {
    if (t0 === null) t0 = now;
    const k = Math.min(1, (now - t0) / dur);
    const e = 1 - Math.pow(1 - k, 3);             // easeOutCubic
    f.value = fromVal + (to - fromVal) * e;
    if (k < 1) requestAnimationFrame(step); else f.value = to;
  };
  requestAnimationFrame(step);
}
function glideGate(mic_id, fromPct) {              // motorized glide for the NG marker/knob
  const ch = channels.find((c) => c.mic_id === mic_id); if (!ch) return;
  const toPct = ch.gate > 0 ? rmsToPct(ch.gate) : 0;
  if (Math.abs(toPct - fromPct) < 0.5) return;
  const line = document.getElementById('gate_' + mic_id);
  const kn = document.getElementById('knob_' + mic_id);
  const lbl = document.getElementById('ngval_' + mic_id);
  if (line) line.classList.remove('off');
  if (kn) kn.classList.remove('off');
  let t0 = null; const dur = 380;
  const step = (now) => {
    if (t0 === null) t0 = now;
    const k = Math.min(1, (now - t0) / dur);
    const pct = fromPct + (toPct - fromPct) * (1 - Math.pow(1 - k, 3));
    if (line) line.style.setProperty('--gate', pct.toFixed(1) + '%');
    if (kn) kn.style.setProperty('--knob', ((pct / 100) * 270 - 135).toFixed(0) + 'deg');
    if (lbl) { const r = pctToRms(pct); lbl.textContent = r <= 0.00003 ? 'NG (off)' : 'NG (' + Math.round(20 * Math.log10(r)) + ')'; }
    if (k < 1) requestAnimationFrame(step); else setGateVisual(mic_id);
  };
  requestAnimationFrame(step);
}
function applyPreset(id) {
  const p = presets.find((x) => x.id === id); if (!p) return;
  const sc = p.scene || {};
  // remember current fader + gate positions so we can glide from them after re-render
  const prev = {}; const prevGate = {};
  channels.forEach((c) => {
    const f = document.getElementById('fader_' + c.mic_id); if (f) prev[c.mic_id] = +f.value;
    prevGate[c.mic_id] = c.gate > 0 ? rmsToPct(c.gate) : 0;
  });
  const fm = document.getElementById('faderMaster'); const prevMaster = fm ? +fm.value : null;

  if (typeof sc.master === 'number') { master = Math.max(0, Math.min(FADER_MAX_GAIN, sc.master)); api('master', { gain: master }).catch(() => {}); }
  if (Array.isArray(sc.links)) { linked.clear(); sc.links.forEach((m) => { if (channels.some((c) => c.mic_id === m)) linked.add(m); }); saveLinks(); }
  channels.forEach((ch) => {
    const cs = sc.ch && sc.ch[ch.mic_id]; if (!cs) return;
    if (typeof cs.gain === 'number') { ch.gain = cs.gain; faderPrev[ch.mic_id] = gainToSlider(cs.gain); api('volume', { mic_id: ch.mic_id, gain: cs.gain }).catch(() => {}); }
    if (typeof cs.gate === 'number') {
      ch.gate = cs.gate;
      const gb = { mic_id: ch.mic_id, threshold: cs.gate };
      if (typeof cs.ga === 'number') { ch.gate_attack = cs.ga; gb.attack = cs.ga; }
      if (typeof cs.gh === 'number') { ch.gate_hold = cs.gh; gb.hold = cs.gh; }
      if (typeof cs.gr === 'number') { ch.gate_release = cs.gr; gb.release = cs.gr; }
      if (typeof cs.ghy === 'number') { ch.gate_hyst = cs.ghy; gb.hyst = cs.ghy; }
      api('gate', gb).catch(() => {});
    }
    if (typeof cs.muted === 'boolean') { ch.muted = cs.muted; api('mute', { mic_id: ch.mic_id, muted: cs.muted }).catch(() => {}); }
    if (typeof cs.solo === 'boolean') { ch.solo = cs.solo; }
  });
  // push solo as two batched calls (solo also clears mute server-side)
  const soloOn = channels.filter((c) => c.solo).map((c) => c.mic_id);
  const soloOff = channels.filter((c) => !c.solo).map((c) => c.mic_id);
  if (soloOn.length) api('solo', { ids: soloOn, solo: true }).catch(() => {});
  if (soloOff.length) api('solo', { ids: soloOff, solo: false }).catch(() => {});
  activePreset = id;
  renderAll();        // reflects gains/mutes/links from the loaded scene
  renderPresets();
  // glide the faders + NG markers from their old positions to the new targets
  channels.forEach((c) => {
    if (c.mic_id in prev) glideFrom(c.mic_id, prev[c.mic_id]);
    if (c.mic_id in prevGate) glideGate(c.mic_id, prevGate[c.mic_id]);
  });
  if (prevMaster !== null) glideFrom('master', prevMaster);
}

// ===== go ================================================================= //
boot();
