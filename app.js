/* INFLUENCER XL v1 — UI (app.js)
 * Importa Storage y Engine desde ./js/ (otro agente). Como js/ aún no
 * estaba entregado al escribir esta UI, la carga es dinámica con
 * try/catch y con implementaciones de reserva honestas: si falta un
 * módulo, la pantalla carga igual y cada acción del motor muestra el
 * error real en vez de fingir que funciona.
 */
const VERSION = 'v1';

/* ---------- Carga de módulos ---------- */
let Storage = null;
let Engine = null;
let OpenCode = null;
let storageSource = 'fallback';
let engineSource = 'fallback';
let opencodeSource = 'fallback';

async function loadModules() {
  try {
    const m = await import('./js/storage.js');
    Storage = m.Storage || m.default;
    if (Storage && typeof Storage.init === 'function') storageSource = 'contract';
  } catch (e) {
    console.warn('[ixl] js/storage.js no disponible, uso reserva local:', e);
  }
  try {
    const m = await import('./js/engine.js');
    Engine = m.Engine || m.default;
    if (Engine && typeof Engine.load === 'function') engineSource = 'contract';
  } catch (e) {
    console.warn('[ixl] js/engine.js no disponible, uso reserva local:', e);
  }
  try {
    const m = await import('./js/opencode.js');
    OpenCode = m.OpenCode || m.default;
    if (OpenCode && typeof OpenCode.ping === 'function') opencodeSource = 'contract';
  } catch (e) {
    console.warn('[ixl] js/opencode.js no disponible, el motor de PC no conecta:', e);
  }
  if (!Storage) Storage = createFallbackStorage();
  if (!Engine) Engine = createFallbackEngine();
  if (!OpenCode) OpenCode = createFallbackOpenCode();
}

// Reserva honesta de OpenCode: sin el módulo no hay motor de PC; cada
// acción explica que falta js/opencode.js en vez de fingir que conecta.
function createFallbackOpenCode() {
  const err = () => { throw new Error('El motor de PC (js/opencode.js) no está disponible en esta compilación.'); };
  return {
    PC_WORKDIR: 'C:\\Users\\arti\\ixl-work',
    PC_DOWNLOADS: 'C:\\Users\\arti\\Downloads',
    WHISPER_SCRIPT: 'C:\\Users\\arti\\ixl-whisper.py',
    getSettings: () => ({ serverUrl: 'http://100.93.202.6:4096', password: '', whisperModel: 'tiny' }),
    saveSettings: () => { throw new Error('El motor de PC (js/opencode.js) no está disponible en esta compilación.'); },
    configure: () => { throw new Error('El motor de PC (js/opencode.js) no está disponible en esta compilación.'); },
    ping: err, uploadFile: err, downloadFile: err, runShell: err, ask: err, whisper: err, stabilizeVidstab: err,
    pcWorkPath: (n) => 'C:\\Users\\arti\\ixl-work\\' + String(n || 'medio'),
    pcDownloadsPath: (n) => 'C:\\Users\\arti\\Downloads\\' + String(n || 'medio'),
  };
}

/* ---------- Reserva de Storage (IndexedDB, misma API §2) ---------- */
function createFallbackStorage() {
  const DB = 'influencer-xl';
  let dbp = null;
  let dbObj = null;
  // Mismo arreglo que en js/storage.js (error real 11 nov 2026): si el
  // navegador cierra la conexión, la promesa cacheada quedaba inservible
  // y todo guardado fallaba con "The database connection is closing".
  const isClosed = (e) => e && (e.name === 'InvalidStateError' || /connection is closing/i.test(String(e.message || e)));
  function db() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('media', { keyPath: 'id' });
        req.result.createObjectStore('projects', { keyPath: 'id' });
      };
      req.onsuccess = () => {
        dbObj = req.result;
        const mine = dbp;
        dbObj.onclose = () => { if (dbObj === req.result) dbObj = null; if (dbp === mine) dbp = null; };
        dbObj.onversionchange = () => { try { dbObj.close(); } catch {} if (dbObj === req.result) dbObj = null; if (dbp === mine) dbp = null; };
        resolve(req.result);
      };
      req.onerror = () => reject(req.error);
    });
    dbp.catch(() => { dbp = null; });
    return dbp;
  }
  const tx = (store, mode, fn, _retried) => db().then(d => new Promise((res, rej) => {
    let t;
    try { t = d.transaction(store, mode); } catch (e) {
      if (!_retried && isClosed(e)) { dbp = null; tx(store, mode, fn, true).then(res, rej); return; }
      rej(e); return;
    }
    let out;
    try { out = fn(t.objectStore(store)); } catch (e) { rej(e); return; }
    out.onsuccess = () => res(out.result);
    out.onerror = () => {
      if (!_retried && isClosed(out.error)) { dbp = null; tx(store, mode, fn, true).then(res, rej); }
      else rej(out.error);
    };
  }));
  const all = (store, _retried) => db().then(d => new Promise((res, rej) => {
    let r;
    try { r = d.transaction(store, 'readonly').objectStore(store).getAll(); } catch (e) {
      if (!_retried && isClosed(e)) { dbp = null; all(store, true).then(res, rej); return; }
      rej(e); return;
    }
    r.onsuccess = () => res(r.result || []);
    r.onerror = () => {
      if (!_retried && isClosed(r.error)) { dbp = null; all(store, true).then(res, rej); }
      else rej(r.error);
    };
  }));
  const SETTINGS_KEY = 'ixl.settings';
  return {
    async init() { await db(); },
    async saveMedia(blob, { name, kind }) {
      const id = crypto.randomUUID();
      const meta = { id, name: name || 'medio', kind, size: blob.size, mime: blob.type, createdAt: Date.now() };
      await tx('media', 'readwrite', s => s.put({ ...meta, blob }));
      return id;
    },
    async getMedia(id) {
      const rec = await tx('media', 'readonly', s => s.get(id));
      return rec ? rec.blob : null;
    },
    async getMediaMeta(id) {
      const rec = await tx('media', 'readonly', s => s.get(id));
      if (!rec) return null;
      const { blob, ...meta } = rec;
      return meta;
    },
    async listMedia(kind) {
      const items = await all('media');
      return items.map(({ blob, ...m }) => m)
        .filter(m => !kind || m.kind === kind)
        .sort((a, b) => b.createdAt - a.createdAt);
    },
    async deleteMedia(id) { await tx('media', 'readwrite', s => s.delete(id)); },
    async saveProject(p) { p.updatedAt = Date.now(); await tx('projects', 'readwrite', s => s.put(p)); },
    async getProject(id) { return (await tx('projects', 'readonly', s => s.get(id))) || null; },
    async listProjects() {
      return (await all('projects')).sort((a, b) => b.updatedAt - a.updatedAt);
    },
    async deleteProject(id) { await tx('projects', 'readwrite', s => s.delete(id)); },
    getSettings() {
      try { return { hfToken: '', pollinationsKey: '', theme: 'dark', ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; }
      catch { return { hfToken: '', pollinationsKey: '', theme: 'dark' }; }
    },
    setSettings(patch) {
      const cur = this.getSettings();
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...cur, ...patch }));
    },
  };
}

/* ---------- Reserva de Engine ---------- */
function createFallbackEngine() {
  return {
    mode: isNativeApp() ? 'native' : 'web',
    ready: false,
    async load() { throw new Error('El motor de vídeo (js/engine.js) aún no está disponible en esta compilación.'); },
    async getCapabilities() { throw new Error('El motor de vídeo (js/engine.js) aún no está disponible.'); },
    async probe(mediaId) { return probeWithElement(mediaId); },
    async trim() { throw new Error('Recortar necesita el motor de vídeo (js/engine.js), aún no disponible.'); },
    async setSpeed() { throw new Error('Cambiar la velocidad necesita el motor de vídeo (js/engine.js), aún no disponible.'); },
    async applyFilters() { throw new Error('Los filtros necesitan el motor de vídeo (js/engine.js), aún no disponible.'); },
    async applyComic() { throw new Error('El Cómic necesita el motor de vídeo (js/engine.js), aún no disponible.'); },
    async chromaKey() { throw new Error('El croma necesita el motor de vídeo (js/engine.js), aún no disponible.'); },
    async applyTransition() { throw new Error('Las transiciones necesitan el motor de vídeo (js/engine.js), aún no disponible.'); },
    async stabilize() { throw new Error('Estabilizar necesita el motor de vídeo (js/engine.js), aún no disponible.'); },
    async composeClone() { throw new Error('Componer el clon necesita el motor de vídeo (js/engine.js), aún no disponible.'); },
    async exportTimeline() { throw new Error('Exportar necesita el motor de vídeo (js/engine.js), aún no disponible.'); },
    async renderTextPNG() { throw new Error('Renderizar texto necesita el motor de vídeo (js/engine.js), aún no disponible.'); },
    cancel() { /* nada que cancelar sin motor */ },
  };
}

/* ---------- Utilidades ---------- */
const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2));
const clone = o => JSON.parse(JSON.stringify(o));
const fmtTime = s => {
  if (!isFinite(s) || s == null) s = 0;
  s = Math.max(0, s);
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return m + ':' + String(sec).padStart(2, '0');
};
const fmtSize = n => {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
};
const errMsg = e => (e && (e.message || e.code)) ? (e.message || String(e.code)) : String(e ?? 'Error desconocido');

function toast(msg, kind = 'info', ms = 6000) {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'success' ? ' success' : kind === 'error' ? ' error' : '');
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), ms);
}
const confirmDlg = msg => window.confirm(msg);

/* Lienzos por ratio (§4 del contrato) */
const CANVAS = {
  '9:16': { 720: [406, 720], 1080: [608, 1080] },
  '1:1': { 720: [720, 720], 1080: [1080, 1080] },
  '16:9': { 720: [1280, 720], 1080: [1920, 1080] },
  '3:4': { 720: [540, 720], 1080: [810, 1080] },
  '4:3': { 720: [960, 720], 1080: [1440, 1080] },
  '4:5': { 720: [576, 720], 1080: [864, 1080] },
  '21:9': { 720: [1680, 720], 1080: [2520, 1080] },
};
const RATIO_LABELS = {
  '9:16': '9:16 — vertical', '1:1': '1:1 — cuadrado', '16:9': '16:9 — horizontal',
  '3:4': '3:4', '4:3': '4:3', '4:5': '4:5', '21:9': '21:9 — ultrawide',
};
function canvasSize(ratio, height) {
  const row = CANVAS[ratio] || CANVAS['9:16'];
  return row[height] || row[720];
}
function ratioWH(ratio) {
  const [w, h] = ratio.split(':').map(Number);
  return { w, h };
}
/* Tamaño de generación de imagen: lado largo L, ratio dado, pares */
function genSize(ratio, longSide) {
  const { w, h } = ratioWH(ratio);
  let W, H;
  if (w >= h) { W = longSide; H = Math.round(longSide * h / w); }
  else { H = longSide; W = Math.round(longSide * w / h); }
  return { width: W - (W % 2), height: H - (H % 2) };
}

/* URLs de objeto con caché (se revocan al recargar la lista) */
const urlCache = new Map();
async function mediaURL(mediaId) {
  if (urlCache.has(mediaId)) return urlCache.get(mediaId);
  const blob = await Storage.getMedia(mediaId);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  urlCache.set(mediaId, url);
  return url;
}
function clearURLCache() {
  for (const u of urlCache.values()) URL.revokeObjectURL(u);
  urlCache.clear();
}

/* Probe con elemento <video>/<img>/<audio> (fallback y caché) */
const probeCache = new Map();
async function probeWithElement(mediaId) {
  if (probeCache.has(mediaId)) return probeCache.get(mediaId);
  const meta = await Storage.getMediaMeta(mediaId);
  const blob = await Storage.getMedia(mediaId);
  if (!blob) throw new Error('Medio no encontrado en la galería.');
  const url = URL.createObjectURL(blob);
  const p = new Promise((resolve, reject) => {
    const done = v => { URL.revokeObjectURL(url); resolve(v); };
    if (blob.type.startsWith('image/')) {
      const img = new Image();
      img.onload = () => done({ duration: 3, width: img.naturalWidth, height: img.naturalHeight, fps: 30, hasAudio: false, codec: blob.type, size: blob.size });
      img.onerror = () => reject(new Error('No se pudo leer la imagen.'));
      img.src = url;
    } else {
      const el = document.createElement(blob.type.startsWith('audio/') ? 'audio' : 'video');
      el.preload = 'metadata';
      el.onloadedmetadata = () => done({ duration: el.duration || 0, width: el.videoWidth || 0, height: el.videoHeight || 0, fps: 30, hasAudio: blob.type.startsWith('audio/') || !!el.mozHasAudio, codec: blob.type, size: blob.size });
      el.onerror = () => reject(new Error('No se pudo leer el medio.'));
      el.src = url;
    }
  });
  const out = await p;
  probeCache.set(mediaId, out);
  return out;
}
async function probe(mediaId) {
  if (probeCache.has(mediaId)) return probeCache.get(mediaId);
  try {
    const r = await Engine.probe(mediaId);
    if (r && typeof r.duration === 'number') { probeCache.set(mediaId, r); return r; }
  } catch (e) { console.warn('[ixl] Engine.probe falló, uso elemento:', e); }
  return probeWithElement(mediaId);
}

/* ---------- Estado global ---------- */
const state = {
  screen: 'projects',
  project: null,            // proyecto abierto
  selection: null,          // {track:'video'|'texts'|'audio', id}
  galleryFilter: '',
  playhead: 0,              // segundos en la línea de tiempo
  playing: false,
  clipDurations: new Map(), // clipId -> duración calculada
  capabilities: null,
  engineLoading: false,
  exporting: false,
  pollinationsBlockedUntil: 0,
  cloneA: null,             // {mediaId, name}
  cloneB: null,
  lastExportBlob: null,
};

const app = {
  get project() { return state.project; },
  get selection() { return state.selection; },
  get playhead() { return state.playhead; },
  get playing() { return state.playing; },
  renderInspector,
  updatePreview,
  showScreen,
  saveProject,
  refreshAll,
};

/* ---------- Navegación ---------- */
function showScreen(name) {
  state.screen = name;
  $$('.screen').forEach(s => s.classList.toggle('active', s.id === 'screen-' + name));
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.screen === name));
  if (name === 'projects') renderProjects();
  if (name === 'editor') { renderEditor(); }
  if (name === 'images') renderImages();
  if (name === 'clone') renderClone();
  if (name === 'settings') renderSettings();
}
$$('.nav-btn').forEach(b => b.addEventListener('click', () => showScreen(b.dataset.screen)));

/* ---------- Motor: carga perezosa + capacidades ---------- */
function setEngineBadge(text, cls) {
  const b = $('#engine-badge');
  b.textContent = text;
  b.className = 'engine-badge' + (cls ? ' ' + cls : '');
}
async function ensureEngine() {
  if (Engine.ready) return true;
  if (state.engineLoading) return false;
  state.engineLoading = true;
  setEngineBadge('Motor: cargando…');
  try {
    await Engine.load(p => {
      const pct = p && typeof p === 'number' ? Math.round(p * 100) : null;
      setEngineBadge(pct != null ? `Motor: cargando… ${pct}%` : 'Motor: cargando…');
    });
    setEngineBadge('Motor: listo (' + (Engine.mode || 'web') + ')', 'ready');
    try {
      state.capabilities = await Engine.getCapabilities();
      if (state.capabilities && state.capabilities.vidstab === false) {
        toast('Tu motor de vídeo no incluye estabilización (vidstab). El botón Estabilizar queda desactivado.', 'info', 8000);
      }
    } catch (e) { console.warn('[ixl] getCapabilities falló:', e); }
    return true;
  } catch (e) {
    setEngineBadge('Motor: error', 'error');
    toast('No se pudo cargar el motor de vídeo: ' + errMsg(e) + ' Puedes reintentarlo pulsando de nuevo.', 'error', 9000);
    return false;
  } finally {
    state.engineLoading = false;
  }
}

/* ---------- Persistencia del proyecto ---------- */
async function saveProject(silent, opts = {}) {
  if (!state.project) return;
  state.project.updatedAt = Date.now();
  try {
    await Storage.saveProject(state.project);
    if (!opts.skipHistory) pushHistory();
    if (!silent) toast('Proyecto guardado.', 'success', 3000);
  } catch (e) { toast('No se pudo guardar el proyecto: ' + errMsg(e), 'error'); }
}

// Deshacer/Rehacer (ola 2): historial de estados JSON del proyecto. Cada
// guardado empuja una copia si cambió y pasó ~1 s desde la última (para
// no llenar el historial con cada movimiento de un deslizador). Máx. 50.
let _historyPast = [];
let _historyFuture = [];
let _historyLastPush = 0;
let _historyLastJson = '';
function seedHistory() {
  _historyPast = [];
  _historyFuture = [];
  _historyLastJson = state.project ? JSON.stringify(state.project) : '';
  _historyLastPush = 0;
  updateUndoRedoButtons();
}
function pushHistory() {
  if (!state.project) return;
  const now = Date.now();
  const json = JSON.stringify(state.project);
  if (json === _historyLastJson) return;
  if (now - _historyLastPush < 300 && _historyPast.length) {
    // Ráfaga (deslizador): el paso de deshacer sigue siendo el estado
    // anterior a la ráfaga; solo se actualiza el "actual". La ventana es
    // 300 ms (no 1 s): un deslizador dispara cada ~16-100 ms al arrastrar
    // y se fusiona, pero un clic discreto (efecto, girar, añadir clip)
    // casi nunca cae dentro de 300 ms del anterior; con 1 s, un Sepia
    // rápido tras añadir el clip se fusionaba y el deshacer borraba el
    // clip entero (volvía al estado semilla sin clips).
    _historyLastJson = json;
    _historyLastPush = now;
    return;
  }
  // El paso de deshacer es el estado ANTES de este cambio.
  if (_historyLastJson) _historyPast.push(_historyLastJson);
  if (_historyPast.length > 50) _historyPast.shift();
  _historyFuture = [];
  _historyLastJson = json;
  _historyLastPush = now;
  updateUndoRedoButtons();
}
function updateUndoRedoButtons() {
  const u = $('#btn-undo'), r = $('#btn-redo');
  if (u) u.disabled = _historyPast.length === 0;
  if (r) r.disabled = _historyFuture.length === 0;
}
async function undoProject() {
  if (!_historyPast.length || !state.project) return;
  const prevSel = state.selection;
  _historyFuture.push(JSON.stringify(state.project));
  const json = _historyPast.pop();
  state.project = JSON.parse(json);
  _historyLastJson = json;
  _historyLastPush = 0;
  // La selección se conserva si el elemento sigue existiendo: antes se
  // perdía siempre y el inspector saltaba al panel del proyecto.
  state.selection = restoreSelection(prevSel);
  state.clipDurations.clear();
  await saveProject(true, { skipHistory: true });
  await renderEditor();
  updateUndoRedoButtons();
}
async function redoProject() {
  if (!_historyFuture.length || !state.project) return;
  const prevSel = state.selection;
  _historyPast.push(JSON.stringify(state.project));
  const json = _historyFuture.pop();
  state.project = JSON.parse(json);
  _historyLastJson = json;
  _historyLastPush = 0;
  state.selection = restoreSelection(prevSel);
  state.clipDurations.clear();
  await saveProject(true, { skipHistory: true });
  await renderEditor();
  updateUndoRedoButtons();
}
function restoreSelection(prevSel) {
  if (!prevSel || !state.project) return null;
  const arr = prevSel.track === 'video' ? state.project.clips
    : prevSel.track === 'texts' ? state.project.texts : state.project.audios;
  return (arr || []).some(x => x.id === prevSel.id) ? prevSel : null;
}
$('#btn-undo').addEventListener('click', undoProject);
$('#btn-redo').addEventListener('click', redoProject);
async function refreshAll() {
  if (state.screen === 'projects') await renderProjects();
  if (state.screen === 'editor') await renderEditor();
  if (state.screen === 'images') await renderImages();
}

/* ================= PROYECTOS ================= */
async function renderProjects() {
  const listEl = $('#projects-list');
  const emptyEl = $('#projects-empty');
  listEl.innerHTML = '';
  let projects = [];
  try { projects = await Storage.listProjects(); }
  catch (e) { toast('No se pudieron leer los proyectos: ' + errMsg(e), 'error'); }
  emptyEl.hidden = projects.length > 0;
  for (const p of projects) {
    const card = document.createElement('div');
    card.className = 'project-card';
    const clips = (p.clips || []).length, texts = (p.texts || []).length, audios = (p.audios || []).length;
    card.innerHTML =
      '<h3></h3>' +
      '<p class="project-meta"></p>' +
      '<div class="project-actions">' +
      '<button type="button" class="btn primary small" data-act="open">Abrir</button>' +
      '<button type="button" class="btn small" data-act="dup">Duplicar</button>' +
      '<button type="button" class="btn small danger" data-act="del">Eliminar</button>' +
      '</div>';
    card.querySelector('h3').textContent = p.name || 'Sin nombre';
    card.querySelector('.project-meta').textContent =
      (RATIO_LABELS[p.ratio] || p.ratio) + ' · ' + clips + ' clip' + (clips === 1 ? '' : 's') +
      ' · ' + texts + ' texto' + (texts === 1 ? '' : 's') + ' · ' + audios + ' audio' + (audios === 1 ? '' : 's') +
      ' · actualizado ' + new Date(p.updatedAt || p.createdAt || Date.now()).toLocaleString('es-419');
    card.querySelector('[data-act="open"]').addEventListener('click', () => openProject(p.id));
    if (p.coverMediaId) {
      const img = document.createElement('img');
      img.className = 'project-cover'; img.alt = '';
      card.prepend(img);
      mediaURL(p.coverMediaId).then(u => { if (u) img.src = u; }).catch(() => {});
    }
    card.querySelector('[data-act="dup"]').addEventListener('click', async () => {
      const copy = clone(p);
      copy.id = uid();
      copy.name = (p.name || 'Proyecto') + ' (copia)';
      copy.createdAt = Date.now(); copy.updatedAt = Date.now();
      try { await Storage.saveProject(copy); toast('Proyecto duplicado.', 'success', 3000); renderProjects(); }
      catch (e) { toast('No se pudo duplicar: ' + errMsg(e), 'error'); }
    });
    card.querySelector('[data-act="del"]').addEventListener('click', async () => {
      if (!confirmDlg('¿Eliminar el proyecto «' + (p.name || 'Sin nombre') + '»? Esta acción no se puede deshacer.')) return;
      try {
        await Storage.deleteProject(p.id);
        if (state.project && state.project.id === p.id) { state.project = null; state.selection = null; }
        toast('Proyecto eliminado.', 'success', 3000); renderProjects();
      } catch (e) { toast('No se pudo eliminar: ' + errMsg(e), 'error'); }
    });
    listEl.appendChild(card);
  }
}

function newProjectObject(name, ratio) {
  const now = Date.now();
  return { id: uid(), name, createdAt: now, updatedAt: now, ratio, fps: 30, exportHeight: 720, clips: [], texts: [], audios: [], overlays: [], stickers: [], coverMediaId: null, characterBlock: { heroMediaId: null, base: '', seed: 0, style: 'jk', trigger: '' } };
}

async function openProject(id) {
  let p = null;
  try { p = await Storage.getProject(id); } catch (e) { toast('No se pudo abrir el proyecto: ' + errMsg(e), 'error'); return; }
  if (!p) { toast('Ese proyecto ya no existe.', 'error'); renderProjects(); return; }
  // Migración: proyectos creados antes de InShot no tienen overlays/stickers.
  if (!Array.isArray(p.overlays)) p.overlays = [];
  if (!Array.isArray(p.stickers)) p.stickers = [];
  if (!p.characterBlock) p.characterBlock = { heroMediaId: null, base: '', seed: 0, style: 'jk', trigger: '' };
  state.project = p;
  state.selection = null;
  state.playhead = 0;
  state.playing = false;
  state.clipDurations.clear();
  seedHistory();
  showScreen('editor');
}

/* ================= EDITOR ================= */
function projectDuration() {
  if (!state.project) return 0;
  let total = 0;
  for (const c of state.project.clips) total += clipDuration(c);
  return total;
}
function clipDuration(c) {
  if (state.clipDurations.has(c.id)) return state.clipDurations.get(c.id);
  // Hueco de la Plantilla J'K: sin medio aún, su duración es la del hueco.
  if (c.placeholder) return Math.max(0.1, ((c.trimEnd ?? 3) - (c.trimStart || 0)) / (c.speed || 1));
  // Sin probe aún: imagen 3 s, vídeo 3 s provisional hasta que el probe lo corrija.
  const d = c.kind === 'image' ? (((c.trimEnd ?? 3) - (c.trimStart || 0)) / (c.speed || 1)) : 3;
  return Math.max(0.1, d);
}
async function refreshClipDurations() {
  if (!state.project) return;
  for (const c of state.project.clips) {
    // Hueco de la Plantilla J'K: sin medio que probar; duración del hueco.
    if (c.placeholder) {
      const end = c.trimEnd ?? 3;
      state.clipDurations.set(c.id, Math.max(0.1, (end - (c.trimStart || 0)) / (c.speed || 1)));
      continue;
    }
    try {
      const pr = await probe(c.mediaId);
      const base = c.kind === 'image' ? 3 : (pr.duration || 3);
      const end = c.trimEnd ?? base;
      state.clipDurations.set(c.id, Math.max(0.1, (end - (c.trimStart || 0)) / (c.speed || 1)));
    } catch { /* se queda el valor provisional */ }
  }
}

async function renderEditor() {
  const has = !!state.project;
  $('#editor-no-project').hidden = has;
  $('#editor-layout').hidden = !has;
  $('#export-bar').hidden = !has;
  if (!has) { $('#editor-project-name').textContent = 'Editor'; $('#editor-project-meta').textContent = 'Sin proyecto abierto'; return; }
  const p = state.project;
  $('#editor-project-name').textContent = p.name;
  const ratioSel = $('#editor-ratio');
  ratioSel.innerHTML = Object.keys(RATIO_LABELS).map(r => '<option value="' + r + '"' + (r === p.ratio ? ' selected' : '') + '>' + RATIO_LABELS[r] + '</option>').join('');
  const [w, h] = canvasSize(p.ratio, 720);
  $('#editor-project-meta').textContent = RATIO_LABELS[p.ratio] + ' · lienzo ' + w + '×' + h + ' (720p) · ' + fmtTime(projectDuration()) + ' en total';
  const stage = $('#preview-stage');
  stage.style.aspectRatio = w + ' / ' + h;
  await refreshClipDurations();
  await renderGallery();
  renderTimeline();
  renderInspector();
  updatePreview();
}

$('#editor-ratio').addEventListener('change', async e => {
  if (!state.project) return;
  state.project.ratio = e.target.value;
  await saveProject(true);
  renderEditor();
  toast('Formato cambiado a ' + state.project.ratio + '. El lienzo de exportación cambia con él.', 'success', 3000);
});
$('#btn-save-project').addEventListener('click', () => saveProject(false));
$('#btn-back-projects').addEventListener('click', async () => { await saveProject(true); showScreen('projects'); });

/* ---------- Galería / subir ---------- */
async function renderGallery() {
  const listEl = $('#gallery-list');
  const emptyEl = $('#gallery-empty');
  listEl.innerHTML = '';
  let items = [];
  try { items = await Storage.listMedia(state.galleryFilter || undefined); }
  catch (e) { toast('No se pudo leer la galería: ' + errMsg(e), 'error'); }
  emptyEl.hidden = items.length > 0;
  $('#gallery-hint').textContent = items.length ? 'Haz clic en un medio para añadirlo a la línea de tiempo.' : 'Sube un vídeo, una imagen o un audio para empezar.';
  for (const m of items) {
    const row = document.createElement('div');
    row.className = 'gallery-item';
    const thumb = document.createElement(m.kind === 'audio' ? 'span' : m.kind);
    if (m.kind === 'audio') { thumb.className = 'gi-audio'; thumb.textContent = '♪'; }
    else { thumb.muted = true; thumb.preload = 'metadata'; }
    const url = await mediaURL(m.id).catch(() => null);
    if (url && m.kind !== 'audio') thumb.src = url;
    const info = document.createElement('div');
    const nm = document.createElement('div'); nm.className = 'gi-name'; nm.textContent = m.name || 'Sin nombre';
    const mt = document.createElement('div'); mt.className = 'gi-meta';
    mt.textContent = (m.kind === 'video' ? 'Vídeo' : m.kind === 'image' ? 'Imagen' : 'Audio') + ' · ' + fmtSize(m.size) +
      (m.duration ? ' · ' + fmtTime(m.duration) : '');
    info.append(nm, mt);
    const del = document.createElement('button');
    del.type = 'button'; del.className = 'icon-btn'; del.textContent = '🗑'; del.title = 'Eliminar de la galería';
    del.addEventListener('click', async ev => {
      ev.stopPropagation();
      if (!confirmDlg('¿Eliminar «' + (m.name || 'este medio') + '» de la galería? Los clips que lo usen dejarán de tener imagen.')) return;
      try { await Storage.deleteMedia(m.id); probeCache.delete(m.id); urlCache.delete(m.id); toast('Medio eliminado.', 'success', 3000); renderGallery(); }
      catch (e) { toast('No se pudo eliminar: ' + errMsg(e), 'error'); }
    });
    const acts = document.createElement('div'); acts.className = 'gi-actions'; acts.appendChild(del);
    row.append(thumb, info, acts);
    row.addEventListener('click', () => addMediaToTimeline(m));
    listEl.appendChild(row);
  }
}
$$('.chip[data-kind]').forEach(ch => ch.addEventListener('click', () => {
  $$('.chip[data-kind]').forEach(c => c.classList.remove('active'));
  ch.classList.add('active');
  state.galleryFilter = ch.dataset.kind;
  renderGallery();
}));

$('#btn-upload-media').addEventListener('click', () => $('#file-upload').click());
// Sube archivos a la galería y devuelve sus metas. La usa tanto el botón
// «Subir archivo» del editor como el selector de medios del inicio.
async function uploadFiles(files, { quiet = false } = {}) {
  const saved = [];
  for (const f of files) {
    const kind = f.type.startsWith('video/') ? 'video' : f.type.startsWith('image/') ? 'image' : f.type.startsWith('audio/') ? 'audio' : null;
    if (!kind) { toast('«' + f.name + '» no es vídeo, imagen ni audio.', 'error'); continue; }
    try {
      const id = await Storage.saveMedia(f, { name: f.name, kind });
      try {
        const pr = await probeWithElement(id);
        probeCache.set(id, pr);
        await Storage.updateMediaMeta(id, {
          width: pr.width || null,
          height: pr.height || null,
          duration: kind === 'image' ? null : (pr.duration || null),
        });
      } catch { /* meta opcional */ }
      const meta = await Storage.getMediaMeta(id).catch(() => null);
      saved.push(meta || { id, name: f.name, kind });
      if (!quiet) toast('«' + f.name + '» subido a la galería.', 'success', 3000);
    } catch (err) { toast('No se pudo subir «' + f.name + '»: ' + errMsg(err), 'error'); }
  }
  clearURLCache();
  return saved;
}
$('#file-upload').addEventListener('change', async e => {
  const files = [...(e.target.files || [])];
  e.target.value = '';
  if (!files.length) return;
  await uploadFiles(files);
  await renderGallery();
  if (state.screen === 'images') renderImages();
});

async function addMediaToTimeline(m) {
  if (!state.project) { toast('Abre primero un proyecto en el Editor.', 'error'); return; }
  // Rellenar o cambiar un hueco de la Plantilla J'K: si el clip seleccionado
  // es un hueco (vacío o ya rellenado — lleva el marcador slot 'bts'/'final'),
  // el medio elegido lo rellena o lo cambia en vez de añadirse como clip
  // nuevo. El look y la duración del hueco se conservan.
  if (m.kind !== 'audio' && state.selection && state.selection.track === 'video') {
    const sel = selectedItem();
    if (sel && sel.item && (sel.item.placeholder || sel.item.slot)) {
      const c = sel.item;
      const wasPlaceholder = !!c.placeholder;
      const slotName = c.slot === 'bts' ? '① Crudo / BTS' : c.slot === 'final' ? '② Final' : (c.name || 'hueco');
      c.mediaId = m.id;
      c.kind = m.kind;
      c.name = m.name;
      c.placeholder = false;
      state.clipDurations.delete(c.id);
      await saveProject(true);
      await renderEditor();
      toast(wasPlaceholder
        ? 'Hueco «' + slotName + '» rellenado con «' + m.name + '».'
        : 'Hueco «' + slotName + '» cambiado a «' + m.name + '».', 'success', 3000);
      return;
    }
  }
  if (m.kind === 'audio') {
    state.project.audios.push({ id: uid(), mediaId: m.id, name: m.name, trimStart: 0, trimEnd: null, volume: 1, start: state.playhead, keyframes: [] });
    toast('Audio añadido en ' + fmtTime(state.playhead) + '.', 'success', 3000);
  } else {
    const clip = {
      id: uid(), kind: m.kind, mediaId: m.id, name: m.name, trimStart: 0, trimEnd: null, speed: 1,
      filters: { brightness: 0, contrast: 1, saturation: 1, preset: 'none' },
      chroma: null, transition: { type: 'none', duration: 0.5 }, keyframes: [], volume: 1,
      // InShot (12 nov 2026): efecto, giro/volteo, recorte, fondo/lona,
      // opacidad y máscara. Los proyectos viejos sin estos campos se
      // tratan como valores por defecto en el motor.
      effect: 'none', rotate: 0, flipH: false, flipV: false,
      crop: null, fit: 'cover', bg: 'black', bgColor: '#000000',
      opacity: 1, mask: null,
    };
    state.project.clips.push(clip);
    state.selection = { track: 'video', id: clip.id };
    toast((m.kind === 'image' ? 'Imagen' : 'Vídeo') + ' añadido a la línea de tiempo.', 'success', 3000);
  }
  await saveProject(true);
  await renderEditor();
}
$('#btn-generate-image').addEventListener('click', () => showScreen('images'));

/* ---------- Línea de tiempo ---------- */
function trackItemEls(track, items, clsFn, labelFn, durFn) {
  const lane = $('#track-' + track);
  lane.innerHTML = '';
  // Tile Portada (ola 2, estilo InShot): primer hueco de la pista de vídeo.
  // Al pulsarlo, el fotograma del cursor se guarda como portada del proyecto
  // (se ve en la lista de Proyectos). La portada no es un clip: no suena ni
  // se exporta; solo es la miniatura del proyecto.
  if (track === 'video') {
    const tile = document.createElement('button');
    tile.type = 'button'; tile.className = 'cover-tile';
    tile.title = 'Portada: guarda el fotograma del cursor como miniatura del proyecto';
    tile.innerHTML = '<span aria-hidden="true">🖼</span><span>Portada</span>';
    tile.addEventListener('click', async () => {
      const p = state.project;
      if (!p) return;
      const { clip: cur, start } = clipAtTime(state.playhead);
      if (!cur || cur.kind !== 'video' || cur.placeholder || !cur.mediaId) {
        toast('La portada se saca de un clip de vídeo: mueve el cursor sobre un vídeo.', 'error');
        return;
      }
      try {
        const id = await Engine.captureFrame(cur.mediaId, Math.max(0, state.playhead - start));
        p.coverMediaId = id;
        await saveProject(true);
        renderTimeline(); renderProjects();
        toast('Portada actualizada con el fotograma del cursor.', 'success');
      } catch (e) { toast('No se pudo guardar la portada: ' + errMsg(e), 'error'); }
    });
    lane.appendChild(tile);
    if (state.project && state.project.coverMediaId) {
      mediaURL(state.project.coverMediaId).then(url => {
        if (!url || !tile.isConnected) return;
        const img = document.createElement('img');
        img.src = url; img.alt = '';
        tile.prepend(img);
      }).catch(() => {});
    }
  }
  const total = Math.max(projectDuration(), 0.1);
  for (const it of items) {
    const el = document.createElement('div');
    el.className = 'clip ' + clsFn(it);
    const lab = document.createElement('span');
    lab.className = 'clip-label';
    lab.textContent = labelFn(it);
    el.appendChild(lab);
    const dur = durFn(it);
    el.style.width = Math.max(64, Math.round((dur / total) * 100)) + '%';
    const ds = document.createElement('span'); ds.className = 'clip-dur'; ds.textContent = fmtTime(dur);
    el.appendChild(ds);
    if (state.selection && state.selection.track === track && state.selection.id === it.id) el.classList.add('selected');
    // 'mousedown' (no 'click'): renderTimeline() reconstruye la pista en
    // cada edición y puede resolver entre el mousedown y el mouseup de un
    // clic, con lo que el nodo bajo el cursor se destruye y el 'click'
    // nunca llega (el clip no se selecciona). Al seleccionar en el
    // mousedown, la selección ya está hecha aunque el nodo se reconstruya
    // después.
    el.addEventListener('mousedown', () => {
      state.selection = { track, id: it.id };
      renderTimeline(); renderInspector();
    });
    lane.appendChild(el);
  }
  if (!items.length) {
    const ph = document.createElement('span');
    ph.className = 'muted small';
    ph.style.cssText = 'align-self:center;padding-left:.5rem';
    ph.textContent = track === 'video' ? 'Sin clips — añade medios desde la galería.' : track === 'texts' ? 'Sin textos — pulsa «+ Texto».' : 'Sin audios — añade un audio desde la galería.';
    lane.appendChild(ph);
  }
  // marcador del cursor
  const marker = document.createElement('div');
  marker.className = 'playhead-marker';
  marker.style.left = (total > 0 ? Math.min(100, (state.playhead / total) * 100) : 0) + '%';
  lane.appendChild(marker);
}
function renderTimeline() {
  if (!state.project) return;
  const p = state.project;
  trackItemEls('video', p.clips, c => c.kind + (c.placeholder ? ' placeholder' : ''), c => c.name || 'Clip', c => clipDuration(c));
  trackItemEls('texts', p.texts, () => 'text', t => t.text || 'Texto', t => Math.max(0.1, (t.end - t.start)));
  trackItemEls('audio', p.audios, () => 'audio', a => a.name || 'Audio', a => {
    const end = a.trimEnd ?? 3; return Math.max(0.1, end - (a.trimStart || 0));
  });
  // Tira de película: fotogramas reales dentro de cada clip de vídeo.
  $$('#track-video .clip').forEach((el, i) => { if (p.clips[i]) attachFilmstrip(el, p.clips[i]); });
  renderRuler();
  updatePlayheadUI();
}

// Solo mueve el cursor de reproducción (etiqueta de tiempo, barra de
// progreso y marcadores de cada pista). Antes tickPreview() llamaba a
// renderTimeline() 30 veces por segundo mientras reproducía, lo que
// destruía y recreaba todos los clips — imposible tocar un clip en la
// línea de tiempo mientras suena la vista previa, y la tira de película
// parpadeaba. Ahora la estructura solo se reconstruye al editar.
function updatePlayheadUI() {
  if (!state.project) return;
  $('#time-label').textContent = fmtTime(state.playhead) + ' / ' + fmtTime(projectDuration());
  const total = Math.max(projectDuration(), 0.1);
  const pct = Math.min(100, (state.playhead / total) * 100);
  $('#progress-fill').style.width = pct + '%';
  $('#progress-cursor').style.left = pct + '%';
  $$('.playhead-marker').forEach(m => { m.style.left = pct + '%'; });
  const bar = $('#progress-bar');
  bar.setAttribute('aria-valuemax', String(Math.round(total)));
  bar.setAttribute('aria-valuenow', String(Math.round(state.playhead)));
}

// Miniaturas de tira de película (ola 2): 3 fotogramas reales por clip de
// vídeo, extraídos con <video> + canvas y cacheados por mediaId.
const thumbCache = new Map(); // mediaId -> Promise<[dataURL, ...]>
async function clipThumbs(mediaId) {
  if (thumbCache.has(mediaId)) return thumbCache.get(mediaId);
  const p = (async () => {
    const blob = await Storage.getMedia(mediaId).catch(() => null);
    if (!blob) return [];
    const url = URL.createObjectURL(blob);
    try {
      const video = document.createElement('video');
      video.muted = true;
      video.preload = 'auto';
      video.src = url;
      await new Promise((res) => { video.onloadedmetadata = res; video.onerror = res; setTimeout(res, 5000); });
      const dur = video.duration || 0;
      if (!(dur > 0)) return [];
      const out = [];
      const cv = document.createElement('canvas');
      cv.width = 96; cv.height = 54;
      const cx = cv.getContext('2d');
      for (const frac of [0.2, 0.5, 0.8]) {
        try {
          video.currentTime = Math.min(dur - 0.05, Math.max(0, dur * frac));
          await new Promise((res) => { video.onseeked = res; setTimeout(res, 2000); });
          cx.drawImage(video, 0, 0, cv.width, cv.height);
          out.push(cv.toDataURL('image/jpeg', 0.6));
        } catch { /* un fotograma menos */ }
      }
      return out;
    } finally {
      URL.revokeObjectURL(url);
    }
  })();
  thumbCache.set(mediaId, p);
  return p;
}
function attachFilmstrip(clipEl, clip) {
  if (clip.kind !== 'video' || clip.placeholder || !clip.mediaId) return;
  clipThumbs(clip.mediaId).then(urls => {
    if (!urls.length || !clipEl.isConnected) return;
    const strip = document.createElement('div');
    strip.className = 'filmstrip';
    for (const u of urls) {
      const img = document.createElement('img');
      img.src = u;
      img.alt = '';
      strip.appendChild(img);
    }
    clipEl.prepend(strip);
  }).catch(() => {});
}

// Regla de tiempo (ola 2): marcas cada 2 s + duración total.
function renderRuler() {
  const ruler = $('#time-ruler');
  ruler.innerHTML = '';
  const total = projectDuration();
  if (!(total > 0)) return;
  for (let t = 0; t < total; t += 2) {
    const s = document.createElement('span');
    s.style.left = (t / total * 100) + '%';
    s.textContent = fmtTime(t);
    ruler.appendChild(s);
  }
  const end = document.createElement('span');
  end.style.left = '100%';
  end.textContent = fmtTime(total);
  ruler.appendChild(end);
}

function selectedItem() {
  if (!state.project || !state.selection) return null;
  const { track, id } = state.selection;
  const arr = track === 'video' ? state.project.clips : track === 'texts' ? state.project.texts : state.project.audios;
  return { item: (arr || []).find(x => x.id === id) || null, arr };
}
function clipStartTime(clipId) {
  let t = 0;
  for (const c of state.project.clips) { if (c.id === clipId) return t; t += clipDuration(c); }
  return t;
}

$('#btn-add-text').addEventListener('click', async () => {
  if (!state.project) return;
  const t = { id: uid(), text: 'Escribe aquí', size: 64, color: '#ffffff', bg: null, stroke: null, bold: true, italic: false, x: 0, y: 0, start: state.playhead, end: state.playhead + 3, keyframes: [] };
  state.project.texts.push(t);
  state.selection = { track: 'texts', id: t.id };
  await saveProject(true);
  renderTimeline(); renderInspector(); updatePreview();
  toast('Texto añadido. Edítalo en el inspector.', 'success', 3000);
});
$('#btn-autocaptions').addEventListener('click', () => { autoCaptions(); });

$('#btn-split').addEventListener('click', async () => {
  if (!state.project) return;
  const sel = selectedItem();
  if (!sel || !sel.item || state.selection.track !== 'video') { toast('Selecciona primero un clip de vídeo en la línea de tiempo.', 'error'); return; }
  const c = sel.item;
  const start = clipStartTime(c.id);
  const local = state.playhead - start; // segundos dentro del clip (ya con velocidad)
  if (local <= 0.05 || local >= clipDuration(c) - 0.05) { toast('Mueve el cursor dentro del clip para dividirlo (no en los extremos).', 'error'); return; }
  const mediaPoint = (c.trimStart || 0) + local * (c.speed || 1);
  const second = clone(c);
  second.id = uid();
  second.trimStart = mediaPoint;
  second.name = (c.name || 'Clip') + ' (2)';
  c.trimEnd = mediaPoint;
  c.name = (c.name || 'Clip') + ' (1)';
  const idx = state.project.clips.findIndex(x => x.id === c.id);
  state.project.clips.splice(idx + 1, 0, second);
  state.clipDurations.delete(c.id); state.clipDurations.delete(second.id);
  state.selection = { track: 'video', id: second.id };
  await saveProject(true);
  await renderEditor();
  toast('Clip dividido en el cursor.', 'success', 3000);
});

$('#btn-duplicate-clip').addEventListener('click', async () => {
  const sel = selectedItem();
  if (!sel || !sel.item) { toast('Selecciona primero un clip, texto o audio.', 'error'); return; }
  const copy = clone(sel.item);
  copy.id = uid();
  if (copy.name) copy.name += ' (copia)';
  if (copy.text) copy.text += ' (copia)';
  const idx = sel.arr.findIndex(x => x.id === sel.item.id);
  sel.arr.splice(idx + 1, 0, copy);
  state.selection = { track: state.selection.track, id: copy.id };
  await saveProject(true);
  await renderEditor();
  toast('Duplicado.', 'success', 3000);
});

$('#btn-delete-clip').addEventListener('click', async () => {
  const sel = selectedItem();
  if (!sel || !sel.item) { toast('Selecciona primero un clip, texto o audio.', 'error'); return; }
  const label = sel.item.name || sel.item.text || 'este elemento';
  if (!confirmDlg('¿Eliminar «' + label + '» de la línea de tiempo? El medio seguirá en la galería.')) return;
  const idx = sel.arr.findIndex(x => x.id === sel.item.id);
  sel.arr.splice(idx, 1);
  state.clipDurations.delete(sel.item.id);
  state.selection = null;
  state.playhead = Math.min(state.playhead, Math.max(0, projectDuration() - 0.01));
  await saveProject(true);
  await renderEditor();
  toast('Eliminado de la línea de tiempo.', 'success', 3000);
});

function moveSelected(dir) {
  const sel = selectedItem();
  if (!sel || !sel.item) { toast('Selecciona primero un clip, texto o audio.', 'error'); return; }
  const idx = sel.arr.findIndex(x => x.id === sel.item.id);
  const to = idx + dir;
  if (to < 0 || to >= sel.arr.length) { toast('Ya está en ese extremo.', 'info', 2500); return; }
  [sel.arr[idx], sel.arr[to]] = [sel.arr[to], sel.arr[idx]];
  saveProject(true).then(() => renderEditor());
}
$('#btn-move-left').addEventListener('click', () => moveSelected(-1));
$('#btn-move-right').addEventListener('click', () => moveSelected(1));

// Silenciar de un toque (ola 2): volumen 0 en el clip seleccionado.
$('#btn-mute-clip').addEventListener('click', async () => {
  const sel = selectedItem();
  if (!sel || !sel.item || state.selection.track !== 'video') { toast('Selecciona primero un clip de vídeo.', 'error'); return; }
  const c = sel.item;
  c.volume = (c.volume ?? 1) === 0 ? 1 : 0;
  await saveProject(true);
  renderTimeline(); renderInspector(); updatePreview();
  toast(c.volume === 0 ? 'Clip silenciado.' : 'Sonido del clip restaurado.', 'success', 2500);
});

// Botón ＋ rojo (ola 2): añadir medios de la galería a la línea de tiempo.
$('#btn-add-media').addEventListener('click', async () => {
  if (!state.project) { toast('Abre primero un proyecto en el Editor.', 'error'); return; }
  const picked = await openMediaPicker({ kind: 'video', title: 'Añadir medios a la línea de tiempo' });
  if (!picked) return;
  for (const m of picked) await addMediaToTimeline(m);
});

// Pantalla completa en la vista previa (ola 2).
$('#btn-fullscreen').addEventListener('click', () => {
  const stage = $('#preview-stage');
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else stage.requestFullscreen().catch(() => toast('Este navegador no permite pantalla completa aquí.', 'error'));
});

/* ---------- Vista previa ---------- */
let previewRaf = null;
let previewClipId = null;
let previewLastTick = 0;
// El usuario mueve el cursor (barra de progreso / flechas): la vista previa
// debe saltar al nuevo punto aunque esté reproduciendo.
let previewForceSeek = false;

/* Filtro CSS en vivo para la vista previa: aproxima el eq de FFmpeg
   (brillo -1..1 como desplazamiento, contraste y saturación como
   multiplicadores, 1 = neutro) y los looks J'K. El Cómic no tiene
   equivalente exacto en CSS (no hay detección de bordes): la vista previa
   muestra colores planos e intensos y el efecto completo con contornos se
   aplica al exportar. */
function previewFilterCSS(c) {
  const f = (c && c.filters) || {};
  const parts = [];
  const preset = f.preset || 'none';
  if (preset === 'bw') parts.push('grayscale(1)', 'contrast(1.08)');
  else if (preset === 'color') parts.push('saturate(1.55)', 'contrast(1.08)');
  else if (preset === 'comic') parts.push('contrast(1.25)', 'saturate(1.9)', 'brightness(1.02)');
  // Efectos (ola 1): aproximación CSS honesta; Glitch y Sacudida no tienen
  // equivalente en CSS y se ven solo al exportar (el inspector lo dice).
  const eff = (c && c.effect) || 'none';
  if (eff === 'vintage') parts.push('sepia(0.5)', 'contrast(0.95)', 'brightness(1.03)');
  else if (eff === 'sepia') parts.push('sepia(1)');
  else if (eff === 'blur') parts.push('blur(3px)');
  else if (eff === 'neon') parts.push('saturate(1.8)', 'contrast(1.15)');
  const b = f.brightness ?? 0, ct = f.contrast ?? 1, st = f.saturation ?? 1;
  if (b) parts.push('brightness(' + (1 + b).toFixed(2) + ')');
  if (ct !== 1) parts.push('contrast(' + ct.toFixed(2) + ')');
  if (st !== 1) parts.push('saturate(' + st.toFixed(2) + ')');
  return parts.join(' ');
}
// Máscara en la vista previa: clip-path aproximado (la pluma solo se ve
// al exportar). x/y/w/h son fracciones del lienzo.
function previewMaskCSS(c) {
  const m = c && c.mask;
  if (!m || !m.shape || m.shape === 'none') return '';
  if (m.shape === 'circle') {
    const cx = ((m.x ?? 0.25) + (m.w ?? 0.5) / 2) * 100;
    const cy = ((m.y ?? 0.25) + (m.h ?? 0.5) / 2) * 100;
    const r = Math.min(m.w ?? 0.5, m.h ?? 0.5) * 50;
    return `circle(${r.toFixed(1)}% at ${cx.toFixed(1)}% ${cy.toFixed(1)}%)`;
  }
  const x = (m.x ?? 0.1) * 100, y = (m.y ?? 0.1) * 100;
  const w = (m.w ?? 0.8) * 100, h = (m.h ?? 0.8) * 100;
  return `inset(${y.toFixed(1)}% ${(100 - x - w).toFixed(1)}% ${(100 - y - h).toFixed(1)}% ${x.toFixed(1)}%)`;
}
// Clip activo según el cursor + su instante de inicio en la línea.
function clipAtTime(t) {
  const p = state.project;
  let cur = p.clips[0], start = 0;
  for (const c of p.clips) {
    const d = clipDuration(c);
    if (t < start + d || c === p.clips[p.clips.length - 1]) return { clip: c, start };
    start += d;
  }
  return { clip: cur, start };
}
async function updatePreview() {
  const p = state.project;
  const videoEl = $('#preview-video');
  const imgEl = $('#preview-image');
  const emptyEl = $('#preview-empty');
  if (!p || !p.clips.length) {
    videoEl.removeAttribute('src'); videoEl.load();
    videoEl.style.filter = ''; imgEl.style.filter = '';
    videoEl.style.transform = ''; imgEl.style.transform = '';
    videoEl.style.opacity = ''; imgEl.style.opacity = '';
    videoEl.style.clipPath = ''; imgEl.style.clipPath = '';
    $('#preview-badge').hidden = true;
    imgEl.hidden = true; videoEl.hidden = true;
    emptyEl.textContent = 'Añade un clip desde la galería para verlo aquí.';
    emptyEl.style.display = 'flex';
    $('#preview-texts').innerHTML = '';
    renderPreviewOverlays();
    return;
  }
  emptyEl.style.display = 'none';
  const { clip: cur, start } = clipAtTime(state.playhead);
  const offset = Math.max(0, state.playhead - start);
  // El filtro se aplica al instante, antes de cargar el medio: así los
  // deslizadores y el look se ven en vivo aunque el medio tarde.
  const cssFilter = previewFilterCSS(cur);
  videoEl.style.filter = cssFilter; imgEl.style.filter = cssFilter;
  // Transformaciones seguras en la vista previa (el volteo y el giro 180°
  // no cambian el marco; el giro 90°/270° solo se ve al exportar).
  const tf = [];
  if (cur.rotate === 180) tf.push('rotate(180deg)');
  if (cur.flipH) tf.push('scaleX(-1)');
  if (cur.flipV) tf.push('scaleY(-1)');
  const transform = tf.join(' ');
  videoEl.style.transform = transform; imgEl.style.transform = transform;
  videoEl.style.opacity = imgEl.style.opacity = String(cur.opacity ?? 1);
  // Máscara: clip-path aproximado (la pluma solo se ve al exportar).
  const clipPath = previewMaskCSS(cur);
  videoEl.style.clipPath = clipPath; imgEl.style.clipPath = clipPath;
  // Fondo de la lona en la vista previa (el desenfocado es negro aquí).
  $('#preview-stage').style.background = (cur.fit === 'contain' && cur.bg === 'color') ? (cur.bgColor || '#000000') : '#000';
  // Aviso de lo que solo se ve al exportar.
  const badge = $('#preview-badge');
  const badgeParts = [];
  if (cur.rotate === 90) badgeParts.push('↻ 90°');
  if (cur.rotate === 270) badgeParts.push('↺ 90°');
  if (cur.effect === 'glitch') badgeParts.push('Efecto Glitch');
  if (cur.effect === 'shake') badgeParts.push('Efecto Sacudida');
  if (cur.fit === 'contain' && cur.bg === 'blur') badgeParts.push('Fondo desenfocado');
  if (badgeParts.length) { badge.textContent = badgeParts.join(' · ') + ' — se ve al exportar'; badge.hidden = false; }
  else badge.hidden = true;
  // Hueco de la Plantilla J'K: no hay medio que mostrar, solo el aviso
  // (las letras y la cuenta atrás sí se ven encima del hueco).
  if (cur.placeholder) {
    videoEl.pause(); videoEl.hidden = true;
    imgEl.hidden = true;
    emptyEl.textContent = 'Hueco «' + (cur.name || 'sin rellenar') + '» — elige un medio de la galería para rellenarlo.';
    emptyEl.style.display = 'flex';
    renderPreviewTexts();
    renderPreviewOverlays();
    return;
  }
  const url = await mediaURL(cur.mediaId).catch(() => null);
  if (!url) { toast('No se pudo cargar el medio del clip «' + (cur.name || '') + '».', 'error'); return; }
  if (cur.kind === 'image') {
    videoEl.pause(); videoEl.hidden = true;
    imgEl.src = url; imgEl.hidden = false;
  } else {
    imgEl.hidden = true; videoEl.hidden = false;
    if (previewClipId !== cur.id || videoEl.getAttribute('src') !== url) {
      videoEl.src = url;
      previewClipId = cur.id;
      await new Promise(res => { videoEl.onloadedmetadata = res; setTimeout(res, 1500); });
    }
    // Mientras reproduce, el vídeo manda y no se le rebusca: el cursor
    // sigue su reloj (ver tickPreview). Solo se busca al pausar o cuando
    // el usuario mueve el cursor a propósito.
    const mediaTime = (cur.trimStart || 0) + offset * (cur.speed || 1);
    if ((!state.playing || previewForceSeek) && Math.abs(videoEl.currentTime - mediaTime) > 0.4) {
      videoEl.currentTime = Math.min(mediaTime, (videoEl.duration || mediaTime) - 0.05);
    }
    previewForceSeek = false;
    videoEl.playbackRate = cur.speed || 1;
    videoEl.volume = Math.min(1, cur.volume ?? 1);
    if (state.playing) videoEl.play().catch(() => {});
    else videoEl.pause();
  }
  renderPreviewTexts();
  renderPreviewOverlays();
}
function renderPreviewTexts() {
  const box = $('#preview-texts');
  box.innerHTML = '';
  const p = state.project;
  if (!p) return;
  const [W, H] = canvasSize(p.ratio, 720);
  const stage = $('#preview-stage');
  const scaleX = stage.clientWidth / W, scaleY = stage.clientHeight / H;
  for (const t of p.texts) {
    if (state.playhead < t.start || state.playhead > t.end) continue;
    const d = document.createElement('div');
    d.className = 'preview-text';
    d.textContent = t.text;
    d.style.left = (50 + (t.x / W) * 100) + '%';
    d.style.top = (50 + (t.y / H) * 100) + '%';
    d.style.fontSize = Math.max(8, (t.size || 64) * scaleX) + 'px';
    d.style.color = t.color || '#ffffff';
    d.style.fontWeight = t.bold ? '800' : '400';
    d.style.fontStyle = t.italic ? 'italic' : 'normal';
    if (t.stroke) d.style.webkitTextStroke = (t.stroke.width || 4) * scaleX + 'px ' + t.stroke.color;
    if (t.bg) d.style.background = t.bg.color, d.style.padding = '0.1em 0.3em', d.style.borderRadius = '0.2em';
    if (t.bg && t.bg.alpha != null) d.style.opacity = String(t.bg.alpha);
    box.appendChild(d);
  }
}

// PIP y adhesivos en la vista previa (ola 2): se dibujan sobre el
// escenario en su posición y tamaño, solo mientras están activos. El DOM
// solo se reconstruye cuando cambia el conjunto activo (si no, el vídeo
// del PIP se reiniciaría en cada fotograma); entre tanto solo se sincroniza
// su tiempo con el cursor.
const _stickerUrlCache = new Map(); // sticker id -> {url, w, h}
let _previewOvSig = '';
let _previewOvToken = 0;
async function renderPreviewOverlays() {
  const box = $('#preview-overlays');
  const p = state.project;
  if (!p) { box.innerHTML = ''; _previewOvSig = ''; return; }
  const t = state.playhead;
  const activeOv = (p.overlays || []).filter(o => t >= (o.start || 0) && t < (o.end ?? (o.start || 0) + 3));
  const activeSt = (p.stickers || []).filter(s => t >= (s.start || 0) && t < (s.end ?? (s.start || 0) + 3));
  // Sincronizar los PIP de vídeo que ya están en pantalla.
  for (const v of box.querySelectorAll('video[data-ov]')) {
    const o = activeOv.find(x => x.id === v.dataset.ov);
    if (!o) continue;
    const want = Math.max(0, t - (o.start || 0));
    if (Math.abs(v.currentTime - want) > 0.5) v.currentTime = want;
    if (state.playing) v.play().catch(() => {});
    else v.pause();
  }
  const sig = p.id + '|' + activeOv.map(o => o.id).join(',') + '|' + activeSt.map(s => s.id).join(',');
  if (sig === _previewOvSig) return;
  _previewOvSig = sig;
  const token = ++_previewOvToken;
  box.innerHTML = '';
  const [W, H] = canvasSize(p.ratio, 720);
  const stage = $('#preview-stage');
  const scaleX = stage.clientWidth / W, scaleY = stage.clientHeight / H;
  for (const o of activeOv) {
    const url = await mediaURL(o.mediaId).catch(() => null);
    if (token !== _previewOvToken) return;
    if (!url) continue;
    const meta = await Storage.getMediaMeta(o.mediaId).catch(() => null);
    if (token !== _previewOvToken) return;
    // El alto del PIP sale de su aspecto (no se estira al lienzo).
    const aspect = (meta && meta.width && meta.height) ? meta.height / meta.width : 1;
    const ow = (o.w ?? 0.25) * W * scaleX;
    const oh = ow * aspect;
    const left = ((o.x ?? 0.8) * W * scaleX) - ow / 2;
    const top = ((o.y ?? 0.2) * H * scaleY) - oh / 2;
    let el;
    if (meta && meta.kind === 'video') {
      el = document.createElement('video');
      el.src = url; el.muted = true; el.loop = true; el.playsInline = true;
      el.dataset.ov = o.id;
      el.currentTime = Math.max(0, t - (o.start || 0));
      if (state.playing) el.play().catch(() => {});
    } else {
      el = document.createElement('img');
      el.src = url; el.alt = '';
    }
    el.style.cssText = `left:${left.toFixed(1)}px;top:${top.toFixed(1)}px;width:${ow.toFixed(1)}px;height:${oh.toFixed(1)}px;opacity:${o.opacity ?? 1}`;
    box.appendChild(el);
  }
  for (const s of activeSt) {
    let url = null;
    let dispW = 0, dispH = 0;
    if (s.emoji) {
      if (!_stickerUrlCache.has(s.id)) {
        try {
          const png = await Engine.renderEmojiPNG(s.emoji, 256);
          const size = await new Promise((res, rej) => {
            const u = URL.createObjectURL(png);
            const img = new Image();
            img.onload = () => { URL.revokeObjectURL(u); res({ w: img.naturalWidth, h: img.naturalHeight }); };
            img.onerror = () => { URL.revokeObjectURL(u); rej(new Error('PNG')); };
            img.src = u;
          });
          _stickerUrlCache.set(s.id, { url: URL.createObjectURL(png), w: size.w / 2, h: size.h / 2 });
        } catch { continue; }
      }
      const c = _stickerUrlCache.get(s.id);
      url = c.url; dispW = c.w; dispH = c.h;
    } else if (s.mediaId) {
      url = await mediaURL(s.mediaId).catch(() => null);
      const meta = await Storage.getMediaMeta(s.mediaId).catch(() => null);
      dispW = meta && meta.width ? Math.min(meta.width, 400) : 200;
      dispH = meta && meta.height ? Math.min(meta.height, 400) : 200;
      if (!url) continue;
    } else continue;
    if (token !== _previewOvToken) return;
    const sc = s.scale ?? 1;
    const w = dispW * sc * scaleX;
    const h = dispH * sc * scaleY;
    const img = document.createElement('img');
    img.src = url; img.alt = '';
    img.style.cssText = `left:${((s.x ?? 0.5) * W * scaleX - w / 2).toFixed(1)}px;top:${((s.y ?? 0.5) * H * scaleY - h / 2).toFixed(1)}px;width:${w.toFixed(1)}px;height:${h.toFixed(1)}px`;
    box.appendChild(img);
  }
}
function tickPreview() {
  if (!state.playing || !state.project) { previewRaf = null; previewLastTick = 0; return; }
  const total = projectDuration();
  const now = performance.now();
  const videoEl = $('#preview-video');
  const { clip: cur, start } = clipAtTime(state.playhead);
  // El vídeo manda: el cursor sigue el reloj del propio elemento <video>,
  // no un temporizador aparte (el temporizador se retrasaba y el vídeo se
  // rebuscaba cada poco, por eso iba lento y a trompicones).
  const isVideo = cur && cur.kind === 'video' && !cur.placeholder && videoEl.getAttribute('src') && !videoEl.hidden;
  if (isVideo) {
    if (videoEl.ended) state.playhead = Math.min(total, start + clipDuration(cur));
    else state.playhead = Math.min(total, start + Math.max(0, (videoEl.currentTime - (cur.trimStart || 0)) / (cur.speed || 1)));
  } else if (previewLastTick) {
    // Imagen o hueco: no hay reloj de vídeo; avanzar por tiempo real.
    state.playhead = Math.min(total, state.playhead + (now - previewLastTick) / 1000);
  }
  previewLastTick = now;
  if (state.playhead >= total) {
    state.playing = false; state.playhead = total; previewLastTick = 0;
    $('#btn-play-pause').textContent = '▶';
  }
  updatePlayheadUI();
  updatePreview();
  previewRaf = setTimeout(() => requestAnimationFrame(tickPreview), 1000 / 30);
}
$('#btn-play-pause').addEventListener('click', () => {
  if (!state.project || !state.project.clips.length) { toast('Añade un clip para reproducir.', 'error'); return; }
  if (state.playhead >= projectDuration()) state.playhead = 0;
  state.playing = !state.playing;
  $('#btn-play-pause').textContent = state.playing ? '⏸' : '▶';
  if (state.playing) { previewLastTick = 0; tickPreview(); }
  else { if (previewRaf) clearTimeout(previewRaf); $('#preview-video').pause(); }
});
$('#progress-bar').addEventListener('click', e => {
  const rect = e.currentTarget.getBoundingClientRect();
  const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  state.playhead = frac * projectDuration();
  previewForceSeek = true;
  renderTimeline(); updatePreview();
});
$('#progress-bar').addEventListener('keydown', e => {
  if (e.key === 'ArrowLeft') state.playhead = Math.max(0, state.playhead - 1);
  if (e.key === 'ArrowRight') state.playhead = Math.min(projectDuration(), state.playhead + 1);
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { previewForceSeek = true; renderTimeline(); updatePreview(); }
});

/* ---------- Inspector ---------- */
function numField(label, value, step, min, max, onChange) {
  const lab = document.createElement('label');
  lab.textContent = label;
  const inp = document.createElement('input');
  inp.type = 'number'; inp.step = step; inp.value = value ?? '';
  if (min != null) inp.min = min;
  if (max != null) inp.max = max;
  inp.addEventListener('change', () => { onChange(parseFloat(inp.value)); });
  lab.appendChild(inp);
  return lab;
}
function sliderField(label, value, min, max, step, fmt, onChange) {
  const lab = document.createElement('label');
  const val = document.createElement('span');
  const update = v => { val.textContent = label + ': ' + fmt(v); };
  update(value);
  const inp = document.createElement('input');
  inp.type = 'range'; inp.min = min; inp.max = max; inp.step = step; inp.value = value;
  inp.addEventListener('input', () => { update(parseFloat(inp.value)); onChange(parseFloat(inp.value)); });
  lab.append(val, inp);
  return lab;
}
function refreshEditorAfterEdit() {
  saveProject(true).then(async () => {
    await refreshClipDurations();
    renderTimeline(); updatePreview();
    const meta = $('#editor-project-meta');
    if (state.project) meta.textContent = RATIO_LABELS[state.project.ratio] + ' · ' + fmtTime(projectDuration()) + ' en total';
  });
}

function renderInspector() {
  const body = $('#inspector-body');
  const actions = $('#inspector-actions');
  body.innerHTML = ''; actions.innerHTML = '';
  const sel = selectedItem();
  if (!sel || !sel.item) {
    if (state.project) return renderProjectInspector(body, actions);
    body.innerHTML = '<p class="muted">Selecciona un clip, un texto o un audio en la línea de tiempo para editarlo.</p>';
    return;
  }
  const it = sel.item;
  if (state.selection.track === 'video') return renderClipInspector(body, actions, it);
  if (state.selection.track === 'texts') return renderTextInspector(body, actions, it);
  return renderAudioInspector(body, actions, it);
}

// Panel del proyecto (ola 2): PIP y adhesivos viven sobre toda la línea
// de tiempo, no en un clip; se gestionan aquí cuando no hay nada
// seleccionado (la barra de herramientas PIP/Adhesivo abre este panel).
function renderProjectInspector(body, actions) {
  const p = state.project;
  const h = document.createElement('h3'); h.textContent = 'Proyecto: ' + p.name; body.appendChild(h);
  const n = document.createElement('p'); n.className = 'note';
  n.textContent = 'PIP y adhesivos viven sobre toda la línea de tiempo. Pulsa en un clip para editarlo, o gestiona aquí los PIP y adhesivos.';
  body.appendChild(n);

  const hp = document.createElement('h3'); hp.textContent = 'PIP (imagen/vídeo encima)'; body.appendChild(hp);
  const pn = document.createElement('p'); pn.className = 'note';
  pn.textContent = 'El PIP va en silencio y se coloca en una esquina o donde elijas. Útil para el flyer sobre el vídeo o un vídeo sobre otro.';
  body.appendChild(pn);
  const addPip = document.createElement('button');
  addPip.type = 'button'; addPip.className = 'btn small';
  addPip.textContent = '＋ Añadir PIP de la galería';
  addPip.addEventListener('click', async () => {
    const picked = await openMediaPicker({ kind: 'video', title: 'PIP — elige un vídeo o una foto' });
    if (!picked || !picked.length) return;
    const m = picked[0];
    const D = projectDuration();
    p.overlays.push({
      id: uid(), mediaId: m.id, name: m.name, kind: m.kind,
      x: 0.8, y: 0.2, w: 0.25, h: 0.25,
      start: state.playhead, end: Math.min(D, state.playhead + 3) || state.playhead + 3,
      opacity: 1,
    });
    await saveProject(true);
    renderTimeline(); renderInspector(); updatePreview();
    toast('PIP añadido en la esquina superior derecha.', 'success', 3000);
  });
  body.appendChild(addPip);
  for (const o of p.overlays) {
    const row = document.createElement('div'); row.className = 'pip-row';
    const nm = document.createElement('span'); nm.className = 'pip-name'; nm.textContent = o.name || 'PIP';
    row.appendChild(nm);
    const posSel = document.createElement('select');
    [['0.2|0.2', '↖ Arriba izq.'], ['0.8|0.2', '↗ Arriba der.'], ['0.2|0.8', '↙ Abajo izq.'], ['0.8|0.8', '↘ Abajo der.'], ['0.5|0.5', 'Centro']].forEach(([v, label]) => {
      const op = document.createElement('option'); op.value = v; op.textContent = label;
      if (Math.abs(o.x - parseFloat(v.split('|')[0])) < 0.01 && Math.abs(o.y - parseFloat(v.split('|')[1])) < 0.01) op.selected = true;
      posSel.appendChild(op);
    });
    posSel.addEventListener('change', () => {
      const [x, y] = posSel.value.split('|').map(Number);
      o.x = x; o.y = y;
      refreshEditorAfterEdit();
    });
    row.appendChild(posSel);
    const sizeSel = document.createElement('select');
    [['0.25', 'Pequeño'], ['0.4', 'Mediano'], ['0.6', 'Grande']].forEach(([v, label]) => {
      const op = document.createElement('option'); op.value = v; op.textContent = label;
      if (Math.abs((o.w ?? 0.25) - parseFloat(v)) < 0.01) op.selected = true;
      sizeSel.appendChild(op);
    });
    sizeSel.addEventListener('change', () => {
      o.w = parseFloat(sizeSel.value);
      refreshEditorAfterEdit();
    });
    row.appendChild(sizeSel);
    const del = document.createElement('button'); del.type = 'button'; del.className = 'icon-btn'; del.textContent = '🗑';
    del.addEventListener('click', async () => {
      p.overlays = p.overlays.filter(x => x.id !== o.id);
      await saveProject(true); renderTimeline(); renderInspector(); updatePreview();
    });
    row.appendChild(del);
    body.appendChild(row);
    const og = document.createElement('div'); og.className = 'field-grid';
    og.append(
      numField('Inicio (s)', o.start || 0, 0.1, 0, null, v => { o.start = Math.max(0, v || 0); refreshEditorAfterEdit(); }),
      numField('Fin (s)', o.end ?? 3, 0.1, 0, null, v => { o.end = v || 3; refreshEditorAfterEdit(); }),
    );
    body.appendChild(og);
  }

  const hs = document.createElement('h3'); hs.textContent = 'Adhesivos'; body.appendChild(hs);
  const sn = document.createElement('p'); sn.className = 'note';
  sn.textContent = 'Emojis gratis (se dibujan a PNG, sin descargar nada) o cualquier imagen de la galería como adhesivo.';
  body.appendChild(sn);
  const pack = document.createElement('div'); pack.className = 'sticker-pack';
  for (const emoji of ['🔥', '😂', '❤️', '⭐', '🎉', '💥', '👀', '😎', '🎵', '💯', '🙌', '😍', '⚡', '👑', '🎬', '💃', '🕺', '🍾', '🎤', '✨']) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'sticker-btn'; b.textContent = emoji;
    b.addEventListener('click', async () => {
      const D = projectDuration();
      p.stickers.push({
        id: uid(), emoji, x: 0.5, y: 0.5, scale: 1,
        start: state.playhead, end: Math.min(D, state.playhead + 3) || state.playhead + 3,
      });
      await saveProject(true);
      renderTimeline(); renderInspector(); updatePreview();
      toast('Adhesivo ' + emoji + ' añadido en el centro.', 'success', 3000);
    });
    pack.appendChild(b);
  }
  body.appendChild(pack);
  const addImgSt = document.createElement('button');
  addImgSt.type = 'button'; addImgSt.className = 'btn small';
  addImgSt.textContent = '＋ Usar una imagen de la galería como adhesivo';
  addImgSt.addEventListener('click', async () => {
    const picked = await openMediaPicker({ kind: 'image', title: 'Adhesivo — elige una imagen' });
    if (!picked || !picked.length) return;
    const m = picked[0];
    const D = projectDuration();
    p.stickers.push({
      id: uid(), mediaId: m.id, name: m.name, x: 0.5, y: 0.5, scale: 1,
      start: state.playhead, end: Math.min(D, state.playhead + 3) || state.playhead + 3,
    });
    await saveProject(true);
    renderTimeline(); renderInspector(); updatePreview();
    toast('Adhesivo añadido en el centro.', 'success', 3000);
  });
  body.appendChild(addImgSt);
  for (const s of p.stickers) {
    const row = document.createElement('div'); row.className = 'sticker-row';
    const nm = document.createElement('span'); nm.className = 'sticker-name'; nm.textContent = s.emoji || s.name || 'Adhesivo';
    row.appendChild(nm);
    row.appendChild(sliderField('Tamaño', s.scale ?? 1, 0.2, 3, 0.1, v => v.toFixed(1) + '×', v => { s.scale = v; refreshEditorAfterEdit(); }));
    const del = document.createElement('button'); del.type = 'button'; del.className = 'icon-btn'; del.textContent = '🗑';
    del.addEventListener('click', async () => {
      p.stickers = p.stickers.filter(x => x.id !== s.id);
      _stickerUrlCache.delete(s.id);
      await saveProject(true); renderTimeline(); renderInspector(); updatePreview();
    });
    row.appendChild(del);
    body.appendChild(row);
  }
}

// Presets de animación (ola 1): insertan keyframes de un toque. Cada
// preset dura 1 s (entrada/salida) o la duración del clip. Los keyframes
// son {t, x, y, scale, rotation, opacity} con t en segundos locales.
const ANIM_PRESETS = {
  fadeIn: { label: 'Entrada suave', kfs: (D) => [{ t: 0, opacity: 0 }, { t: Math.min(1, D), opacity: 1 }] },
  slideIn: { label: 'Deslizar', kfs: (D) => [{ t: 0, x: -400, opacity: 1 }, { t: Math.min(1, D), x: 0, opacity: 1 }] },
  zoomIn: { label: 'Zoom', kfs: (D) => [{ t: 0, scale: 1 }, { t: Math.min(1, D), scale: 1.2 }] },
  fadeOut: { label: 'Salida', kfs: (D) => [{ t: Math.max(0, D - 1), opacity: 1 }, { t: D, opacity: 0 }] },
  bounce: { label: 'Rebote', kfs: (D) => [{ t: 0, scale: 0.8 }, { t: Math.min(0.5, D / 2), scale: 1.05 }, { t: Math.min(1, D), scale: 1 }] },
};
function applyAnimationPreset(item, presetKey, duration) {
  const preset = ANIM_PRESETS[presetKey];
  if (!preset) return;
  const D = Math.max(0.5, duration || 3);
  item.keyframes = item.keyframes || [];
  for (const kf of preset.kfs(D)) {
    item.keyframes.push({ x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, ...kf });
  }
  item.keyframes.sort((a, b) => a.t - b.t);
}
function animationPresetButtons(item, duration) {
  const row = document.createElement('div'); row.className = 'fx-row';
  Object.entries(ANIM_PRESETS).forEach(([key, preset]) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn small'; b.textContent = preset.label;
    b.addEventListener('click', () => {
      applyAnimationPreset(item, key, duration);
      refreshEditorAfterEdit(); renderInspector();
      toast('Animación «' + preset.label + '» aplicada (keyframes).', 'success', 3000);
    });
    row.appendChild(b);
  });
  return row;
}

function renderClipInspector(body, actions, c) {
  const h = document.createElement('h3'); h.textContent = 'Clip: ' + (c.name || 'sin nombre'); body.appendChild(h);
  // Hueco de la Plantilla J'K: sin medio, solo duración y el aviso.
  if (c.placeholder) {
    const p = document.createElement('p'); p.className = 'note';
    p.textContent = 'Este hueco es un marcador de la Plantilla J\'K. Elige un vídeo o una imagen de la galería (a la izquierda) y se rellenará con él. El look y la duración del hueco ya están puestos.';
    body.appendChild(p);
    const grid = document.createElement('div'); grid.className = 'field-grid';
    grid.append(
      numField('Recorte — inicio (s)', c.trimStart || 0, 0.1, 0, null, v => { c.trimStart = Math.max(0, v || 0); state.clipDurations.delete(c.id); refreshEditorAfterEdit(); }),
      numField('Duración del hueco (s)', c.trimEnd ?? 3, 0.1, 0.1, null, v => { c.trimEnd = v || 3; state.clipDurations.delete(c.id); refreshEditorAfterEdit(); }),
    );
    body.appendChild(grid);
    return;
  }
  const grid = document.createElement('div'); grid.className = 'field-grid';
  grid.append(
    numField('Recorte — inicio (s)', c.trimStart || 0, 0.1, 0, null, v => { c.trimStart = Math.max(0, v || 0); state.clipDurations.delete(c.id); refreshEditorAfterEdit(); }),
    numField('Recorte — fin (s, vacío = hasta el final)', c.trimEnd ?? '', 0.1, 0, null, v => { c.trimEnd = (v === '' || isNaN(v)) ? null : v; state.clipDurations.delete(c.id); refreshEditorAfterEdit(); }),
  );
  body.appendChild(grid);
  body.appendChild(sliderField('Velocidad', c.speed || 1, 0.25, 4, 0.25, v => v.toFixed(2) + '×', v => { c.speed = v; state.clipDurations.delete(c.id); refreshEditorAfterEdit(); }));
  body.appendChild(sliderField('Volumen', c.volume ?? 1, 0, 2, 0.05, v => v.toFixed(2), v => { c.volume = v; refreshEditorAfterEdit(); }));

  const hf = document.createElement('h3'); hf.textContent = 'Filtros'; body.appendChild(hf);
  body.appendChild(sliderField('Brillo', c.filters.brightness ?? 0, -1, 1, 0.05, v => v.toFixed(2), v => { c.filters.brightness = v; refreshEditorAfterEdit(); }));
  body.appendChild(sliderField('Contraste', c.filters.contrast ?? 1, 0, 3, 0.05, v => v.toFixed(2), v => { c.filters.contrast = v; refreshEditorAfterEdit(); }));
  body.appendChild(sliderField('Saturación', c.filters.saturation ?? 1, 0, 3, 0.05, v => v.toFixed(2), v => { c.filters.saturation = v; refreshEditorAfterEdit(); }));

  const lookLab = document.createElement('label'); lookLab.textContent = 'Look (Estilo J\'K)';
  const lookSel = document.createElement('select');
  [['none', 'Ninguno'], ['bw', 'Blanco y negro'], ['color', 'Color intenso'], ['comic', 'Cómic']].forEach(([v, label]) => {
    const o = document.createElement('option'); o.value = v; o.textContent = label;
    if (((c.filters && c.filters.preset) || 'none') === v) o.selected = true;
    lookSel.appendChild(o);
  });
  const lookNote = document.createElement('p'); lookNote.className = 'note';
  const lookNotes = {
    none: 'Sin look: el clip se ve tal cual.',
    bw: 'Blanco y negro con contraste: plano exterior desaturado, estilo J\'K.',
    color: 'Color intenso y saturado: plano cercano con punch, estilo J\'K.',
    comic: 'Cómic: colores planos + contornos negros. En la vista previa se ve una aproximación (color plano e intenso, sin contornos); el efecto completo se aplica al exportar.',
  };
  lookNote.textContent = lookNotes[(c.filters && c.filters.preset) || 'none'] || lookNotes.none;
  lookSel.addEventListener('change', () => {
    c.filters = c.filters || { brightness: 0, contrast: 1, saturation: 1 };
    c.filters.preset = lookSel.value;
    lookNote.textContent = lookNotes[lookSel.value] || lookNotes.none;
    refreshEditorAfterEdit();
  });
  lookLab.appendChild(lookSel); body.appendChild(lookLab); body.appendChild(lookNote);

  // Efectos (ola 1): presets de un toque.
  const he = document.createElement('h3'); he.textContent = 'Efectos'; body.appendChild(he);
  const fxRow = document.createElement('div'); fxRow.className = 'fx-row';
  [['none', 'Ninguno'], ['vintage', 'Vintage'], ['sepia', 'Sepia'], ['blur', 'Desenfoque'], ['glitch', 'Glitch'], ['shake', 'Sacudida'], ['neon', 'Neón']].forEach(([v, label]) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn small' + ((c.effect || 'none') === v ? ' active' : '');
    b.textContent = label;
    b.addEventListener('click', () => { c.effect = v; refreshEditorAfterEdit(); renderInspector(); });
    fxRow.appendChild(b);
  });
  body.appendChild(fxRow);
  const fxNote = document.createElement('p'); fxNote.className = 'note';
  fxNote.textContent = 'Glitch y Sacudida no tienen equivalente en la vista previa: se ven solo al exportar. El resto se ve en vivo.';
  body.appendChild(fxNote);

  // Girar y voltear (ola 1).
  const hr = document.createElement('h3'); hr.textContent = 'Girar y voltear'; body.appendChild(hr);
  const rotRow = document.createElement('div'); rotRow.className = 'fx-row';
  const rotBtn = (label, fn) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn small'; b.textContent = label;
    b.addEventListener('click', () => { fn(); refreshEditorAfterEdit(); renderInspector(); });
    rotRow.appendChild(b);
  };
  rotBtn('↻ 90°', () => { c.rotate = ((c.rotate || 0) + 90) % 360; });
  rotBtn('↺ 90°', () => { c.rotate = ((c.rotate || 0) + 270) % 360; });
  rotBtn('180°', () => { c.rotate = ((c.rotate || 0) + 180) % 360; });
  rotBtn('↔ Voltear', () => { c.flipH = !c.flipH; });
  rotBtn('↕ Voltear', () => { c.flipV = !c.flipV; });
  rotBtn('Restablecer', () => { c.rotate = 0; c.flipH = false; c.flipV = false; });
  body.appendChild(rotRow);
  const rotNote = document.createElement('p'); rotNote.className = 'note';
  rotNote.textContent = 'El giro de 90° cambia el marco (vertical ↔ horizontal) y se ve al exportar. El volteo y el giro de 180° se ven en vivo.';
  body.appendChild(rotNote);

  // Opacidad (ola 3): slider simple por clip.
  body.appendChild(sliderField('Opacidad', c.opacity ?? 1, 0, 1, 0.05, v => Math.round(v * 100) + '%', v => { c.opacity = v; refreshEditorAfterEdit(); }));

  // Fondo y lona (ola 2).
  const hb = document.createElement('h3'); hb.textContent = 'Fondo y lona'; body.appendChild(hb);
  const fitLab = document.createElement('label'); fitLab.textContent = 'Ajuste del clip al lienzo';
  const fitSel = document.createElement('select');
  [['cover', 'Cubrir (recorta los lados)'], ['contain', 'Contener (se ve entero)']].forEach(([v, label]) => {
    const o = document.createElement('option'); o.value = v; o.textContent = label;
    if ((c.fit || 'cover') === v) o.selected = true;
    fitSel.appendChild(o);
  });
  fitSel.addEventListener('change', () => { c.fit = fitSel.value; refreshEditorAfterEdit(); renderInspector(); });
  fitLab.appendChild(fitSel); body.appendChild(fitLab);
  if ((c.fit || 'cover') === 'contain') {
    const bgLab = document.createElement('label'); bgLab.textContent = 'Fondo de los bordes';
    const bgSel = document.createElement('select');
    [['black', 'Negro'], ['color', 'Color'], ['blur', 'Desenfocado (el propio clip borroso)']].forEach(([v, label]) => {
      const o = document.createElement('option'); o.value = v; o.textContent = label;
      if ((c.bg || 'black') === v) o.selected = true;
      bgSel.appendChild(o);
    });
    bgSel.addEventListener('change', () => { c.bg = bgSel.value; refreshEditorAfterEdit(); renderInspector(); });
    bgLab.appendChild(bgSel); body.appendChild(bgLab);
    if ((c.bg || 'black') === 'color') {
      const colLab = document.createElement('label'); colLab.textContent = 'Color del fondo';
      const colInp = document.createElement('input'); colInp.type = 'color'; colInp.value = c.bgColor || '#000000';
      colInp.addEventListener('change', () => { c.bgColor = colInp.value; refreshEditorAfterEdit(); });
      colLab.appendChild(colInp); body.appendChild(colLab);
    }
    if ((c.bg || 'black') === 'blur') {
      const n = document.createElement('p'); n.className = 'note';
      n.textContent = 'Con fondo desenfocado, los keyframes de zoom no se aplican (el marco pequeño no se puede re-escalar). La rotación sí.';
      body.appendChild(n);
    }
  }

  // Cortar (encuadre, ola 2): presets + x/y/w/h en %.
  const hcr = document.createElement('h3'); hcr.textContent = 'Cortar (encuadre)'; body.appendChild(hcr);
  const cropRow = document.createElement('div'); cropRow.className = 'fx-row';
  const cropPreset = (label, crop) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn small' + ((crop === null && !c.crop) ? ' active' : '');
    b.textContent = label;
    b.addEventListener('click', () => { c.crop = crop; refreshEditorAfterEdit(); renderInspector(); });
    cropRow.appendChild(b);
  };
  cropPreset('Original', null);
  cropPreset('Centro (mitad)', { x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
  cropPreset('Tercio superior', { x: 0, y: 0, w: 1, h: 0.5 });
  cropPreset('Tercio inferior', { x: 0, y: 0.5, w: 1, h: 0.5 });
  body.appendChild(cropRow);
  if (c.crop) {
    const cg = document.createElement('div'); cg.className = 'field-grid';
    cg.append(
      numField('X (%)', Math.round((c.crop.x || 0) * 100), 1, 0, 100, v => { c.crop.x = (v || 0) / 100; refreshEditorAfterEdit(); }),
      numField('Y (%)', Math.round((c.crop.y || 0) * 100), 1, 0, 100, v => { c.crop.y = (v || 0) / 100; refreshEditorAfterEdit(); }),
      numField('Ancho (%)', Math.round((c.crop.w || 1) * 100), 1, 1, 100, v => { c.crop.w = Math.max(0.05, (v || 100) / 100); refreshEditorAfterEdit(); }),
      numField('Alto (%)', Math.round((c.crop.h || 1) * 100), 1, 1, 100, v => { c.crop.h = Math.max(0.05, (v || 100) / 100); refreshEditorAfterEdit(); }),
    );
    body.appendChild(cg);
  }

  // Máscara (ola 2): forma con pluma.
  const hm = document.createElement('h3'); hm.textContent = 'Máscara'; body.appendChild(hm);
  const maskLab = document.createElement('label'); maskLab.textContent = 'Forma';
  const maskSel = document.createElement('select');
  [['none', 'Ninguna'], ['circle', 'Círculo'], ['rect', 'Rectángulo']].forEach(([v, label]) => {
    const o = document.createElement('option'); o.value = v; o.textContent = label;
    if (((c.mask && c.mask.shape) || 'none') === v) o.selected = true;
    maskSel.appendChild(o);
  });
  maskSel.addEventListener('change', () => {
    c.mask = maskSel.value === 'none' ? null : { shape: maskSel.value, x: 0.25, y: 0.25, w: 0.5, h: 0.5, feather: 12 };
    refreshEditorAfterEdit(); renderInspector();
  });
  maskLab.appendChild(maskSel); body.appendChild(maskLab);
  if (c.mask) {
    body.appendChild(sliderField('Pluma (px)', c.mask.feather ?? 12, 0, 60, 1, v => v + ' px', v => { c.mask.feather = v; refreshEditorAfterEdit(); }));
    const mg = document.createElement('div'); mg.className = 'field-grid';
    mg.append(
      numField('X (%)', Math.round((c.mask.x ?? 0.25) * 100), 1, 0, 100, v => { c.mask.x = (v || 0) / 100; refreshEditorAfterEdit(); }),
      numField('Y (%)', Math.round((c.mask.y ?? 0.25) * 100), 1, 0, 100, v => { c.mask.y = (v || 0) / 100; refreshEditorAfterEdit(); }),
      numField('Ancho (%)', Math.round((c.mask.w ?? 0.5) * 100), 1, 5, 100, v => { c.mask.w = Math.max(0.05, (v || 50) / 100); refreshEditorAfterEdit(); }),
      numField('Alto (%)', Math.round((c.mask.h ?? 0.5) * 100), 1, 5, 100, v => { c.mask.h = Math.max(0.05, (v || 50) / 100); refreshEditorAfterEdit(); }),
    );
    body.appendChild(mg);
    const mn = document.createElement('p'); mn.className = 'note';
    mn.textContent = 'La forma se ve en la vista previa; la pluma suave solo se ve al exportar. Fuera de la forma el clip es transparente (fondo negro al exportar).';
    body.appendChild(mn);
  }

  // Animación (ola 1): presets que insertan keyframes.
  const ha = document.createElement('h3'); ha.textContent = 'Animación'; body.appendChild(ha);
  body.appendChild(animationPresetButtons(c, clipDuration(c)));
  const an = document.createElement('p'); an.className = 'note';
  an.textContent = 'Cada preset añade keyframes al clip (se ven en «Keyframes» abajo y se pueden borrar uno a uno).';
  body.appendChild(an);

  const hc = document.createElement('h3'); hc.textContent = 'Croma (quitar fondo verde/azul)'; body.appendChild(hc);
  const chromaRow = document.createElement('label'); chromaRow.className = 'check-row';
  const chromaChk = document.createElement('input'); chromaChk.type = 'checkbox'; chromaChk.checked = !!c.chroma;
  chromaChk.addEventListener('change', () => {
    c.chroma = chromaChk.checked ? { color: '#00ff00', similarity: 0.15, blend: 0.1 } : null;
    refreshEditorAfterEdit(); renderInspector();
  });
  chromaRow.append(chromaChk, document.createTextNode('Activar croma'));
  body.appendChild(chromaRow);
  if (c.chroma) {
    const cg = document.createElement('div'); cg.className = 'field-grid';
    const colorLab = document.createElement('label'); colorLab.textContent = 'Color del fondo';
    const colorInp = document.createElement('input'); colorInp.type = 'color'; colorInp.value = c.chroma.color || '#00ff00';
    colorInp.addEventListener('change', () => { c.chroma.color = colorInp.value; refreshEditorAfterEdit(); });
    colorLab.appendChild(colorInp); cg.appendChild(colorLab);
    cg.appendChild(numField('Similitud (0–1)', c.chroma.similarity ?? 0.15, 0.01, 0, 1, v => { c.chroma.similarity = v; refreshEditorAfterEdit(); }));
    body.appendChild(cg);
  }

  const ht = document.createElement('h3'); ht.textContent = 'Transición (hacia el siguiente clip)'; body.appendChild(ht);
  const tgrid = document.createElement('div'); tgrid.className = 'field-grid';
  const tLab = document.createElement('label'); tLab.textContent = 'Tipo';
  const tSel = document.createElement('select');
  ['none', 'fade', 'wipeleft', 'wiperight', 'wipeup', 'wipedown', 'dissolve', 'circleopen', 'smoothleft', 'zoom'].forEach(t => {
    const o = document.createElement('option'); o.value = t; o.textContent = t === 'none' ? 'Ninguna' : t; if ((c.transition?.type || 'none') === t) o.selected = true; tSel.appendChild(o);
  });
  tSel.addEventListener('change', () => { c.transition = { type: tSel.value, duration: c.transition?.duration || 0.5 }; refreshEditorAfterEdit(); });
  tLab.appendChild(tSel); tgrid.appendChild(tLab);
  tgrid.appendChild(numField('Duración (s)', c.transition?.duration || 0.5, 0.1, 0.1, 2, v => { c.transition.duration = v; refreshEditorAfterEdit(); }));
  body.appendChild(tgrid);

  const hk = document.createElement('h3'); hk.textContent = 'Keyframes (movimiento)'; body.appendChild(hk);
  const kfList = document.createElement('div'); kfList.className = 'kf-list';
  (c.keyframes || []).forEach((kf, i) => {
    const row = document.createElement('div'); row.className = 'kf-item';
    row.innerHTML = '<span></span>';
    row.querySelector('span').textContent = 't=' + kf.t.toFixed(2) + 's · x=' + kf.x + ' y=' + kf.y + ' · escala ' + kf.scale + ' · rot ' + kf.rotation + '° · op ' + kf.opacity;
    const del = document.createElement('button'); del.type = 'button'; del.className = 'icon-btn'; del.textContent = '✕';
    del.addEventListener('click', () => { c.keyframes.splice(i, 1); refreshEditorAfterEdit(); renderInspector(); });
    row.appendChild(del); kfList.appendChild(row);
  });
  if (!(c.keyframes || []).length) kfList.innerHTML = '<p class="muted small">Sin keyframes. El clip se queda fijo.</p>';
  body.appendChild(kfList);
  const kfGrid = document.createElement('div'); kfGrid.className = 'field-grid';
  const kfVals = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };
  kfGrid.append(
    numField('X (px)', 0, 1, null, null, v => { kfVals.x = v || 0; }),
    numField('Y (px)', 0, 1, null, null, v => { kfVals.y = v || 0; }),
    numField('Escala (1–3)', 1, 0.1, 1, 3, v => { kfVals.scale = v || 1; }),
    numField('Rotación (°)', 0, 1, null, null, v => { kfVals.rotation = v || 0; }),
    numField('Opacidad (0–1)', 1, 0.05, 0, 1, v => { kfVals.opacity = v ?? 1; }),
  );
  body.appendChild(kfGrid);
  const addKf = document.createElement('button');
  addKf.type = 'button'; addKf.className = 'btn small';
  addKf.textContent = '＋ Añadir keyframe en el cursor (' + fmtTime(state.playhead) + ')';
  addKf.addEventListener('click', () => {
    const start = clipStartTime(c.id);
    const tLocal = Math.max(0, state.playhead - start);
    c.keyframes = c.keyframes || [];
    c.keyframes.push({ t: Math.round(tLocal * 100) / 100, ...kfVals });
    c.keyframes.sort((a, b) => a.t - b.t);
    refreshEditorAfterEdit(); renderInspector();
    toast('Keyframe añadido en t=' + tLocal.toFixed(2) + ' s.', 'success', 3000);
  });
  body.appendChild(addKf);

  // Acciones rápidas con el motor (guardan el resultado en la galería)
  const hq = document.createElement('h3'); hq.textContent = 'Acciones con el motor'; actions.appendChild(hq);
  const note = document.createElement('p'); note.className = 'note';
  note.textContent = 'Cada acción procesa el medio con FFmpeg y guarda el resultado como un medio nuevo en la galería.';
  actions.appendChild(note);
  const mkBtn = (label, fn, disabled, disabledNote) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn small'; b.textContent = label; b.disabled = !!disabled;
    b.addEventListener('click', fn);
    actions.appendChild(b);
    if (disabled && disabledNote) { const n = document.createElement('p'); n.className = 'note'; n.textContent = disabledNote; actions.appendChild(n); }
    return b;
  };
  // Solo vídeo: estas acciones no tienen sentido en una foto fija (el botón
  // ni se muestra; antes se mostraba y fallaba con un error al pulsarlo).
  const mkVideoBtn = (label, fn) => { if (c.kind === 'video') mkBtn(label, fn); };
  // El clip se convierte en la versión transformada (el medio nuevo queda
  // también en la galería). Antes estas acciones solo guardaban en la
  // galería y el clip no cambiaba, lo que no se notaba en la línea de tiempo.
  const swapClipMedia = async (id) => {
    const meta = await Storage.getMediaMeta(id);
    c.mediaId = id;
    c.name = (meta && meta.name) || c.name;
    c.trimStart = 0; c.trimEnd = null;
    state.clipDurations.delete(c.id);
    await saveProject(true);
    await renderEditor();
  };
  mkBtn('✂ Aplicar recorte', async () => {
    if (!(await ensureEngine())) return;
    const end = c.trimEnd;
    if (end == null) { toast('Pon un fin de recorte (s) antes de aplicar.', 'error'); return; }
    try { const id = await Engine.trim(c.mediaId, c.trimStart || 0, end); toast('Recorte guardado en la galería.', 'success'); clearURLCache(); renderGallery(); }
    catch (e) { toast('Recorte falló: ' + errMsg(e), 'error'); }
  });
  mkBtn('⏩ Aplicar velocidad (' + (c.speed || 1) + '×)', async () => {
    if (!(await ensureEngine())) return;
    try { await Engine.setSpeed(c.mediaId, c.speed || 1); toast('Velocidad aplicada y guardada en la galería.', 'success'); clearURLCache(); renderGallery(); }
    catch (e) { toast('Velocidad falló: ' + errMsg(e), 'error'); }
  });
  mkBtn('🎨 Aplicar filtros', async () => {
    if (!(await ensureEngine())) return;
    try { await Engine.applyFilters(c.mediaId, c.filters); toast('Filtros aplicados y guardados en la galería.', 'success'); clearURLCache(); renderGallery(); }
    catch (e) { toast('Filtros fallaron: ' + errMsg(e), 'error'); }
  });
  mkBtn('🖍 Aplicar cómic', async () => {
    if (!(await ensureEngine())) return;
    try { await Engine.applyComic(c.mediaId); toast('Cómic aplicado y guardado en la galería.', 'success'); clearURLCache(); renderGallery(); }
    catch (e) {
      if (e && e.code === 'unsupported') toast('Tu motor de vídeo no incluye los filtros del Cómic.', 'error');
      else toast('Cómic falló: ' + errMsg(e), 'error');
    }
  });
  if (c.chroma) mkBtn('🟢 Aplicar croma', async () => {
    if (!(await ensureEngine())) return;
    try { await Engine.chromaKey(c.mediaId, c.chroma); toast('Croma aplicado y guardado en la galería.', 'success'); clearURLCache(); renderGallery(); }
    catch (e) { toast('Croma falló: ' + errMsg(e), 'error'); }
  });
  // Estabilizar: vidstab si el motor lo trae; si no, deshake (básico, una
  // pasada, recorta un poco los bordes). El botón solo se desactiva cuando
  // YA se sabe que el motor no trae ninguna de las dos.
  const useDeshake = !state.capabilities || state.capabilities.vidstab === false;
  const stabMissing = state.capabilities && !state.capabilities.vidstab && !state.capabilities.deshake;
  mkVideoBtn(useDeshake ? '🛟 Estabilizar (básico)' : '🛟 Estabilizar', async () => {
    if (!(await ensureEngine())) return;
    try {
      const id = useDeshake ? await Engine.stabilizeDeshake(c.mediaId) : await Engine.stabilize(c.mediaId);
      await swapClipMedia(id);
      toast('Vídeo estabilizado.', 'success'); clearURLCache(); renderGallery();
    }
    catch (e) {
      if (e && e.code === 'unsupported') toast('Tu motor de vídeo no incluye estabilización.', 'error');
      else toast('Estabilizar falló: ' + errMsg(e), 'error');
    }
  }, stabMissing, stabMissing ? 'Tu motor de vídeo no incluye estabilización (ni vidstab ni deshake).' : (useDeshake ? 'Básico (deshake): recorta un poco los bordes; la estabilización completa (vidstab) llega con el motor nativo.' : null));

  // InShot (olas 1-3): capturar, congelar, inverso, corte automático,
  // mejorar voz, efecto de voz, suavizar, mejorar.
  mkVideoBtn('📸 Capturar fotograma (en el cursor)', async () => {
    if (!(await ensureEngine())) return;
    try {
      const start = clipStartTime(c.id);
      const local = Math.max(0, state.playhead - start);
      const mediaTime = (c.trimStart || 0) + local * (c.speed || 1);
      await Engine.captureFrame(c.mediaId, mediaTime);
      toast('Fotograma guardado en la galería.', 'success');
      clearURLCache(); renderGallery();
    } catch (e) { toast('Capturar falló: ' + errMsg(e), 'error'); }
  });
  mkVideoBtn('🖼 Congelar en el cursor (2 s)', async () => {
    if (!(await ensureEngine())) return;
    try {
      const start = clipStartTime(c.id);
      const local = Math.max(0, state.playhead - start);
      const mediaTime = (c.trimStart || 0) + local * (c.speed || 1);
      const id = await Engine.captureFrame(c.mediaId, mediaTime);
      const meta = await Storage.getMediaMeta(id);
      const frozen = {
        id: uid(), kind: 'image', mediaId: id, name: (meta && meta.name) || 'Congelado',
        trimStart: 0, trimEnd: 2, speed: 1,
        filters: { brightness: 0, contrast: 1, saturation: 1, preset: 'none' },
        chroma: null, transition: { type: 'none', duration: 0.5 }, keyframes: [], volume: 1,
        effect: 'none', rotate: 0, flipH: false, flipV: false,
        crop: null, fit: 'cover', bg: 'black', bgColor: '#000000', opacity: 1, mask: null,
      };
      const idx = state.project.clips.findIndex(x => x.id === c.id);
      state.project.clips.splice(idx + 1, 0, frozen);
      state.clipDurations.delete(frozen.id);
      state.selection = { track: 'video', id: frozen.id };
      await saveProject(true);
      await renderEditor();
      toast('Foto fija de 2 s insertada después del clip.', 'success');
      clearURLCache(); renderGallery();
    } catch (e) { toast('Congelar falló: ' + errMsg(e), 'error'); }
  });
  mkVideoBtn('🔄 Inverso (clip al revés)', async () => {
    if (!(await ensureEngine())) return;
    try {
      const dur = clipDuration(c);
      if (dur > 30 && !confirmDlg('El clip dura ' + fmtTime(dur) + '. El inverso re-codifica todo el clip y puede tardar un rato. ¿Seguir?')) return;
      const id = await Engine.reverseClip(c.mediaId);
      await swapClipMedia(id);
      toast('Clip invertido.', 'success');
      clearURLCache(); renderGallery();
    } catch (e) { toast('Inverso falló: ' + errMsg(e), 'error'); }
  });
  mkVideoBtn('✂ Corte automático (silencios)', async () => {
    if (!(await ensureEngine())) return;
    try {
      const id = await Engine.autoCut(c.mediaId);
      const meta = await Storage.getMediaMeta(id);
      c.mediaId = id;
      c.name = (meta && meta.name) || c.name;
      c.trimStart = 0; c.trimEnd = null;
      state.clipDurations.delete(c.id);
      await saveProject(true);
      await renderEditor();
      toast('Silencios eliminados: el clip ahora es la versión cortada.', 'success');
      clearURLCache(); renderGallery();
    } catch (e) { toast('Corte automático: ' + errMsg(e), 'error'); }
  });
  mkVideoBtn('🎙 Mejorar voz (limpieza + nivel)', async () => {
    if (!(await ensureEngine())) return;
    try { const id = await Engine.enhanceVoice(c.mediaId); await swapClipMedia(id); toast('Voz mejorada.', 'success'); clearURLCache(); renderGallery(); }
    catch (e) { toast('Mejorar voz: ' + errMsg(e), 'error'); }
  });
  if (c.kind === 'video') {
  const vh = document.createElement('h3'); vh.textContent = 'Efecto de voz'; actions.appendChild(vh);
  const vRow = document.createElement('div'); vRow.className = 'fx-row';
  [['high', 'Aguda'], ['low', 'Grave'], ['robot', 'Robot'], ['echo', 'Eco']].forEach(([preset, label]) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn small'; b.textContent = label;
    b.addEventListener('click', async () => {
      if (!(await ensureEngine())) return;
      try {
        const id = await Engine.voiceEffect(c.mediaId, preset);
        await swapClipMedia(id);
        toast('Voz ' + label.toLowerCase() + ' aplicada.' + ((preset === 'high' || preset === 'low') ? ' El cambio de tono también cambia la duración.' : ''), 'success');
        clearURLCache(); renderGallery();
      } catch (e) { toast('Efecto de voz: ' + errMsg(e), 'error'); }
    });
    vRow.appendChild(b);
  });
  actions.appendChild(vRow);
  const vn = document.createElement('p'); vn.className = 'note';
  vn.textContent = 'Aguda y Grave cambian el tono con asetrate: la duración también cambia (no hay rubberband en este motor). Robot y Eco no cambian la duración.';
  actions.appendChild(vn);
  }
  mkBtn('✨ Suavizar (reduce ruido)', async () => {
    if (!(await ensureEngine())) return;
    try { const id = await Engine.smoothClip(c.mediaId); await swapClipMedia(id); toast('Clip suavizado.', 'success'); clearURLCache(); renderGallery(); }
    catch (e) { toast('Suavizar: ' + errMsg(e), 'error'); }
  });
  mkBtn('💎 Mejorar (nitidez + color)', async () => {
    if (!(await ensureEngine())) return;
    try { const id = await Engine.enhanceClip(c.mediaId); await swapClipMedia(id); toast('Clip mejorado.', 'success'); clearURLCache(); renderGallery(); }
    catch (e) { toast('Mejorar: ' + errMsg(e), 'error'); }
  });
  mkBtn('🔄 Cambiar medio (mantiene ajustes)', async () => {
    const picked = await openMediaPicker({ kind: c.kind, title: 'Cambiar medio — elige el nuevo' });
    if (!picked || !picked.length) return;
    const m = picked[0];
    c.mediaId = m.id;
    c.kind = m.kind;
    c.name = m.name;
    c.trimStart = 0; c.trimEnd = null;
    state.clipDurations.delete(c.id);
    await saveProject(true);
    await renderEditor();
    toast('Medio cambiado a «' + m.name + '». Recorte, filtros y velocidad se mantienen.', 'success');
  });
}

function renderTextInspector(body, actions, t) {
  const h = document.createElement('h3'); h.textContent = 'Texto'; body.appendChild(h);
  const yb = document.createElement('button');
  yb.type = 'button'; yb.className = 'btn small';
  yb.textContent = '★ Aplicar estilo Letras amarillas';
  yb.addEventListener('click', () => {
    t.color = '#ffe600'; t.size = 80; t.bold = true; t.italic = false;
    t.stroke = { color: '#000000', width: 6 }; t.bg = null; t.x = 0; t.y = 180;
    refreshEditorAfterEdit(); renderInspector();
    toast('Estilo Letras amarillas aplicado.', 'success', 3000);
  });
  body.appendChild(yb);
  const textLab = document.createElement('label'); textLab.textContent = 'Texto';
  const textInp = document.createElement('input'); textInp.type = 'text'; textInp.value = t.text || '';
  textInp.addEventListener('input', () => { t.text = textInp.value; refreshEditorAfterEdit(); renderTimeline(); });
  textInp.addEventListener('change', () => { t.text = textInp.value; refreshEditorAfterEdit(); renderTimeline(); });
  textLab.appendChild(textInp); body.appendChild(textLab);
  const grid = document.createElement('div'); grid.className = 'field-grid';
  grid.append(
    numField('Tamaño (px)', t.size || 64, 1, 8, 400, v => { t.size = v || 64; refreshEditorAfterEdit(); }),
    numField('Inicio (s)', t.start ?? 0, 0.1, 0, null, v => { t.start = Math.max(0, v || 0); refreshEditorAfterEdit(); }),
    numField('Fin (s)', t.end ?? 3, 0.1, 0, null, v => { t.end = v || 3; refreshEditorAfterEdit(); }),
    numField('X (px desde el centro)', t.x || 0, 1, null, null, v => { t.x = v || 0; refreshEditorAfterEdit(); }),
    numField('Y (px desde el centro)', t.y || 0, 1, null, null, v => { t.y = v || 0; refreshEditorAfterEdit(); }),
  );
  body.appendChild(grid);
  const colorLab = document.createElement('label'); colorLab.textContent = 'Color del texto';
  const colorInp = document.createElement('input'); colorInp.type = 'color'; colorInp.value = t.color || '#ffffff';
  colorInp.addEventListener('change', () => { t.color = colorInp.value; refreshEditorAfterEdit(); });
  colorLab.appendChild(colorInp); body.appendChild(colorLab);
  const boldRow = document.createElement('label'); boldRow.className = 'check-row';
  const boldChk = document.createElement('input'); boldChk.type = 'checkbox'; boldChk.checked = !!t.bold;
  boldChk.addEventListener('change', () => { t.bold = boldChk.checked; refreshEditorAfterEdit(); });
  boldRow.append(boldChk, document.createTextNode('Negrita')); body.appendChild(boldRow);
  const itRow = document.createElement('label'); itRow.className = 'check-row';
  const itChk = document.createElement('input'); itChk.type = 'checkbox'; itChk.checked = !!t.italic;
  itChk.addEventListener('change', () => { t.italic = itChk.checked; refreshEditorAfterEdit(); });
  itRow.append(itChk, document.createTextNode('Cursiva')); body.appendChild(itRow);
  const hk = document.createElement('h3'); hk.textContent = 'Keyframes del texto'; body.appendChild(hk);
  const ha = document.createElement('h3'); ha.textContent = 'Animación'; body.appendChild(ha);
  body.appendChild(animationPresetButtons(t, Math.max(0.5, (t.end ?? 3) - (t.start || 0))));
  const an = document.createElement('p'); an.className = 'note';
  an.textContent = 'Cada preset añade keyframes al texto (se ven en «Keyframes del texto» y se pueden borrar uno a uno).';
  body.appendChild(an);
  const kfList = document.createElement('div'); kfList.className = 'kf-list';
  (t.keyframes || []).forEach((kf, i) => {
    const row = document.createElement('div'); row.className = 'kf-item';
    row.innerHTML = '<span></span>';
    row.querySelector('span').textContent = 't=' + kf.t.toFixed(2) + 's · x=' + kf.x + ' y=' + kf.y + ' · op ' + kf.opacity;
    const del = document.createElement('button'); del.type = 'button'; del.className = 'icon-btn'; del.textContent = '✕';
    del.addEventListener('click', () => { t.keyframes.splice(i, 1); refreshEditorAfterEdit(); renderInspector(); });
    row.appendChild(del); kfList.appendChild(row);
  });
  if (!(t.keyframes || []).length) kfList.innerHTML = '<p class="muted small">Sin keyframes.</p>';
  body.appendChild(kfList);
  const addKf = document.createElement('button');
  addKf.type = 'button'; addKf.className = 'btn small';
  addKf.textContent = '＋ Añadir keyframe en el cursor (' + fmtTime(state.playhead) + ')';
  addKf.addEventListener('click', () => {
    t.keyframes = t.keyframes || [];
    t.keyframes.push({ t: Math.round(Math.max(0, state.playhead - t.start) * 100) / 100, x: t.x || 0, y: t.y || 0, opacity: 1 });
    t.keyframes.sort((a, b) => a.t - b.t);
    refreshEditorAfterEdit(); renderInspector();
  });
  body.appendChild(addKf);
}

function renderAudioInspector(body, actions, a) {
  const h = document.createElement('h3'); h.textContent = 'Audio: ' + (a.name || 'sin nombre'); body.appendChild(h);
  const grid = document.createElement('div'); grid.className = 'field-grid';
  grid.append(
    numField('Inicio en la línea (s)', a.start ?? 0, 0.1, 0, null, v => { a.start = Math.max(0, v || 0); refreshEditorAfterEdit(); }),
    numField('Recorte — inicio (s)', a.trimStart || 0, 0.1, 0, null, v => { a.trimStart = Math.max(0, v || 0); refreshEditorAfterEdit(); }),
    numField('Recorte — fin (s, vacío = final)', a.trimEnd ?? '', 0.1, 0, null, v => { a.trimEnd = (v === '' || isNaN(v)) ? null : v; refreshEditorAfterEdit(); }),
  );
  body.appendChild(grid);
  body.appendChild(sliderField('Volumen', a.volume ?? 1, 0, 2, 0.05, v => v.toFixed(2), v => { a.volume = v; refreshEditorAfterEdit(); }));
}

/* ---------- Guardar en el teléfono (solo APK) ---------- */
// Capacitor inyecta window.Capacitor con isNativePlatform() en el WebView
// del APK. En el navegador no existe y el modo es 'web'.
function isNativeApp() {
  try {
    return !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
  } catch { return false; }
}
// En el WebView de Android un enlace <a download> con un blob: no guarda
// el archivo, así que en la app nativa se escribe con el plugin
// @capacitor/filesystem (caché de la app, sin permisos) y se abre la
// ventana de compartir para que el usuario elija dónde guardarlo
// (Archivos, Galería, WhatsApp…). En la web no hace nada: ahí sigue el
// enlace de descarga normal.
function nativeFilesystem() {
  try { return (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Filesystem) || null; } catch { return null; }
}
function blobToBase64(blob) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => { const s = String(r.result || ''); res(s.indexOf(',') >= 0 ? s.slice(s.indexOf(',') + 1) : s); };
    r.onerror = () => rej(r.error || new Error('No se pudo leer el vídeo.'));
    r.readAsDataURL(blob);
  });
}
// Escribe el blob en el teléfono y abre compartir. Devuelve 'shared' si se
// abrió la ventana de compartir, 'saved' si solo quedó en el caché,
// o null si no hay plugin nativo (web).
async function saveBlobNative(blob, filename) {
  const fs = nativeFilesystem();
  if (!fs || !isNativeApp()) return null;
  const dir = (window.Capacitor && window.Capacitor.FilesystemDirectory && window.Capacitor.FilesystemDirectory.Cache) || 'CACHE';
  const data = await blobToBase64(blob);
  await fs.writeFile({ path: filename, data, directory: dir });
  const share = (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Share) || null;
  if (share) {
    try {
      const uri = await fs.getUri({ path: filename, directory: dir });
      if (uri && uri.uri) {
        await share.share({ title: filename, files: [uri.uri], dialogTitle: 'Guardar vídeo' });
        return 'shared';
      }
    } catch (e) { console.warn('Compartir no disponible:', e); }
  }
  return 'saved';
}
function showExportDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const dl = $('#btn-download-export');
  dl.href = url;
  dl.download = filename;
  dl.hidden = false;
  $('#export-status').textContent = 'Listo: ' + fmtSize(blob.size) + ' — pulsa «Descargar vídeo exportado».';
}

/* ---------- Exportar ---------- */
$('#btn-export').addEventListener('click', async () => {
  if (!state.project || !state.project.clips.length) { toast('Añade al menos un clip antes de exportar.', 'error'); return; }
  const pending = state.project.clips.filter(c => c.placeholder);
  if (pending.length) {
    toast('La plantilla tiene huecos sin rellenar: ' + pending.map(c => '«' + (c.name || 'hueco') + '»').join(', ') + '. Elige un medio de la galería para cada hueco.', 'error', 9000);
    return;
  }
  if (!(await ensureEngine())) return;
  state.project.exportHeight = parseInt($('#export-quality').value, 10) || 720;
  await saveProject(true);
  state.exporting = true;
  $('#btn-export').disabled = true;
  $('#btn-cancel-export').hidden = false;
  $('#export-progress').hidden = false;
  $('#export-status').textContent = 'Exportando… 0%';
  $('#btn-download-export').hidden = true;
  try {
    const blob = await Engine.exportTimeline(state.project, p => {
      const pct = Math.round((typeof p === 'number' ? p : 0) * 100);
      $('#export-progress-fill').style.width = pct + '%';
      $('#export-status').textContent = 'Exportando… ' + pct + '%';
    });
    if (!blob || blob.size === 0) throw new Error('La exportación devolvió un archivo vacío.');
    state.lastExportBlob = blob;
    const filename = (state.project.name || 'influencer-xl').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') + '.mp4';
    if (isNativeApp() && nativeFilesystem()) {
      // En el teléfono el enlace <a download> no guarda: se escribe el
      // archivo y se abre la ventana de compartir.
      $('#export-status').textContent = 'Listo: ' + fmtSize(blob.size) + ' — guardando en el teléfono…';
      const saved = await saveBlobNative(blob, filename).catch(e => { console.warn('Guardado nativo falló:', e); return null; });
      if (saved === 'shared') {
        $('#export-status').textContent = 'Listo: ' + fmtSize(blob.size) + ' — elige dónde guardarlo en la ventana que se abrió.';
      } else if (saved === 'saved') {
        $('#export-status').textContent = 'Listo: ' + fmtSize(blob.size) + ' — guardado en el caché de la app.';
      } else {
        showExportDownload(blob, filename);
      }
      toast('Exportación lista (' + fmtSize(blob.size) + ').', 'success');
      return;
    }
    showExportDownload(blob, filename);
    toast('Exportación lista (' + fmtSize(blob.size) + ').', 'success');
  } catch (e) {
    $('#export-status').textContent = 'Exportación fallida: ' + errMsg(e);
    toast('La exportación falló: ' + errMsg(e), 'error', 9000);
  } finally {
    state.exporting = false;
    $('#btn-export').disabled = false;
    $('#btn-cancel-export').hidden = true;
  }
});
$('#btn-cancel-export').addEventListener('click', () => {
  try { Engine.cancel(); } catch (e) { console.warn(e); }
  $('#export-status').textContent = 'Exportación cancelada. El motor se recargará en el próximo uso.';
  toast('Exportación cancelada.', 'info', 4000);
});
$('#export-quality').addEventListener('change', async e => {
  if (!state.project) return;
  state.project.exportHeight = parseInt(e.target.value, 10) || 720;
  await saveProject(true);
});

/* ================= IMÁGENES ================= */
// «Foto realista»: la descripción del usuario se conserva tal cual como
// sujeto, y se le añaden en inglés los calificadores fotográficos que el
// modelo entiende mejor (luz natural, enfoque, anatomía realista). Verificado
// con el caso real «Un perro surfeando arriba de una ola»: con la descripción
// cruda el perro salía deforme; con el refuerzo sale coherente y realista
// (perro nítido, patas sobre la tabla, ola bien definida).
const PHOTO_REALISTIC_SUFFIX = 'photorealistic photo, natural light, sharp focus, realistic anatomy, detailed textures, true-to-life colors, high detail, coherent composition';
function buildImagePrompt(userText, realistic) {
  const t = (userText || '').trim();
  if (!realistic || !t) return t;
  if (/photorealistic/i.test(t)) return t;
  return t + ', ' + PHOTO_REALISTIC_SUFFIX;
}
let pollinationsTimer = null;
function pollinationsCountdown() {
  const btn = $('#btn-generate');
  const update = () => {
    const left = Math.ceil((state.pollinationsBlockedUntil - Date.now()) / 1000);
    if (left <= 0) {
      clearInterval(pollinationsTimer); pollinationsTimer = null;
      btn.disabled = false; btn.textContent = '✦ Generar imagen';
      $('#img-status').textContent = '';
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Espera ' + left + ' s…';
    $('#img-status').textContent = 'Pollinations pide esperar ~45 s entre imágenes. Quedan ' + left + ' s.';
  };
  update();
  pollinationsTimer = setInterval(update, 1000);
}

async function generateImage() {
  const prompt = $('#img-prompt').value.trim();
  if (!prompt) { toast('Escribe primero una descripción para la imagen.', 'error'); return; }
  const ratio = $('#img-ratio').value;
  const model = $('#img-model').value;
  const realistic = document.getElementById('img-realistic')?.checked !== false;
  const finalPrompt = buildImagePrompt(prompt, realistic) + characterBlockText(state.project);
  const blockSeed = state.project && state.project.characterBlock && state.project.characterBlock.seed > 0
    ? state.project.characterBlock.seed : null;
  const settings = await getSettingsSafe();
  if (model === 'hf' && !settings.hfToken) {
    toast('Para FLUX.1-schnell necesitas tu token de Hugging Face — ponlo en Ajustes. Ojo: el nivel gratis de Hugging Face ya no existe, es de pago o con créditos.', 'error', 8000);
    return;
  }
  if (model === 'cloudflare') {
    // FLUX.1-schnell en Workers AI necesita el Worker proxy (se despliega
    // con el token nuevo de Cloudflare) — la llamada directa desde el
    // navegador la bloquea CORS. No se finge: mientras no haya Worker, la
    // app lo dice y ofrece Sana o AI Horde.
    toast('Cloudflare FLUX necesita el Worker proxy (pendiente de desplegar con tu token nuevo). Mientras tanto usa Pollinations (Sana) o AI Horde.', 'error', 9000);
    return;
  }
  if (model === 'pollinations' && Date.now() < state.pollinationsBlockedUntil) { pollinationsCountdown(); return; }
  const btn = $('#btn-generate');
  btn.disabled = true; btn.textContent = 'Generando…';
  $('#img-status').textContent = 'Generando imagen…';
  try {
    let blob;
    if (model === 'pollinations') {
      // Lado largo 1024 también sin clave (verificado: el endpoint anónimo
      // lo acepta y da más detalle). El endpoint anónimo
      // image.pollinations.ai sirve SIEMPRE su modelo por defecto (hoy
      // Sana) e ignora cualquier parámetro model — por eso no se pasa
      // model=flux: sería mentir. gen.pollinations.ai exige clave (401).
      const longSide = 1024;
      const { width, height } = genSize(ratio, longSide);
      const url = 'https://image.pollinations.ai/prompt/' + encodeURIComponent(finalPrompt) +
        '?width=' + width + '&height=' + height + '&nologo=true&seed=' + (blockSeed || Math.floor(Math.random() * 1e9)) +
        (settings.pollinationsKey ? '&key=' + encodeURIComponent(settings.pollinationsKey) : '');
      const res = await fetch(url);
      if (res.status === 429) {
        state.pollinationsBlockedUntil = Date.now() + 45000;
        pollinationsCountdown();
        toast('Pollinations pide esperar ~45 s entre imágenes.', 'error', 8000);
        return;
      }
      if (!res.ok) throw new Error('Pollinations devolvió HTTP ' + res.status + '.');
      const ct = res.headers.get('content-type') || '';
      if (!ct.startsWith('image/')) throw new Error('Pollinations no devolvió una imagen (content-type: ' + ct + ').');
      blob = await res.blob();
    } else if (model === 'horde') {
      blob = await hordeImage(finalPrompt, ratio);
    } else {
      const { width, height } = genSize(ratio, 1024);
      blob = await hfImage(finalPrompt, width, height, settings.hfToken);
    }
    const modelLabel = { pollinations: 'Pollinations (Sana)', horde: 'AI Horde', hf: 'FLUX.1-schnell', cloudflare: 'Cloudflare FLUX' }[model] || model;
    const id = await Storage.saveMedia(blob, { name: prompt.slice(0, 80) + ' — ' + modelLabel, kind: 'image' });
    try {
      const pr = await probeWithElement(id);
      await Storage.updateMediaMeta(id, { width: pr.width || null, height: pr.height || null, duration: null });
    } catch { /* meta opcional: la imagen queda guardada igualmente */ }
    clearURLCache();
    $('#img-status').textContent = 'Imagen generada y guardada en la galería. Si no te gusta, pulsa «Generar imagen» otra vez para otra variante.';
    toast('Imagen generada y guardada en la galería.', 'success');
    // La descripción NO se borra: así puedes generar otra variante sin reescribirla.
    await renderImages();
    return id;
  } catch (e) {
    $('#img-status').textContent = '';
    toast('No se pudo generar la imagen: ' + errMsg(e), 'error', 9000);
    return null;
  } finally {
    if (!pollinationsTimer) { btn.disabled = false; btn.textContent = '✦ Generar imagen'; }
  }
}
async function hfImage(prompt, width, height, token) {
  const urls = [
    'https://router.huggingface.co/hf-inference/models/black-forest-labs/FLUX.1-schnell',
    'https://api-inference.huggingface.co/models/black-forest-labs/FLUX.1-schnell',
  ];
  let lastErr = null;
  for (const url of urls) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: prompt, parameters: { width, height } }),
    });
    if (res.ok) {
      const ct = res.headers.get('content-type') || '';
      if (!ct.startsWith('image/')) throw new Error('Hugging Face no devolvió una imagen (content-type: ' + ct + ').');
      return await res.blob();
    }
    const text = await res.text().catch(() => '');
    lastErr = new Error('Hugging Face devolvió HTTP ' + res.status + (text ? ': ' + text.slice(0, 200) : '') + '.');
    if (res.status !== 404) throw lastErr; // solo el 404 prueba el endpoint legado
  }
  throw lastErr || new Error('Hugging Face no respondió.');
}

// AI Horde (stablehorde.net) — gratis y anónimo (clave '0000000000').
// Cola compartida: ~50 s por imagen; el anónimo llega hasta ~512 px de lado
// largo. POST /generate/async -> {id}; se sondea /generate/status/{id}
// hasta done y la imagen llega en base64 (data URL webp) o por URL.
async function hordeImage(prompt, ratio) {
  const { width, height } = genSize(ratio, 512);
  const headers = { apikey: '0000000000', 'Content-Type': 'application/json' };
  const res = await fetch('https://stablehorde.net/api/v2/generate/async', {
    method: 'POST', headers,
    body: JSON.stringify({
      prompt,
      params: { width, height, steps: 20, sampler: 'k_euler_a', cfg_scale: 7, n: 1 },
      nsfw: false, censor_nsfw: true, trusted_workers: false,
    }),
  });
  if (!res.ok) throw new Error('AI Horde devolvió HTTP ' + res.status + '.');
  const j = await res.json();
  const id = j && j.id;
  if (!id) throw new Error('AI Horde no devolvió id de trabajo.');
  const t0 = Date.now();
  for (;;) {
    await new Promise(r => setTimeout(r, 5000));
    const st = await fetch('https://stablehorde.net/api/v2/generate/status/' + encodeURIComponent(id), { headers });
    if (!st.ok) throw new Error('AI Horde devolvió HTTP ' + st.status + ' al consultar el estado.');
    const sj = await st.json();
    if (sj.done && (sj.generations || []).length) {
      const g = sj.generations[0];
      const img = g.img || '';
      $('#img-status').textContent = 'Imagen lista (modelo ' + (g.model || 'Horde') + ').';
      if (img.startsWith('data:')) {
        const b64 = img.split(',', 2)[1] || '';
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new Blob([bytes], { type: 'image/webp' });
      }
      if (/^https?:\/\//.test(img)) {
        const r2 = await fetch(img);
        if (!r2.ok) throw new Error('AI Horde devolvió HTTP ' + r2.status + ' al bajar la imagen.');
        return await r2.blob();
      }
      if (img) {
        const bin = atob(img);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new Blob([bytes], { type: 'image/webp' });
      }
      throw new Error('AI Horde terminó sin imagen.');
    }
    if (sj.faulted) throw new Error('AI Horde no pudo generar la imagen.');
    const wait = sj.wait_time != null ? Math.max(0, Math.round(sj.wait_time)) : null;
    const pos = sj.queue_position != null ? sj.queue_position : null;
    $('#img-status').textContent = 'AI Horde: en cola' + (pos != null ? ' (puesto ' + pos + ')' : '') + (wait != null ? ' — espera ~' + wait + ' s' : '') + '…';
    if (Date.now() - t0 > 300000) throw new Error('AI Horde tardó más de 5 minutos.');
  }
}

// Nota visible del modelo elegido (límites honestos).
const IMG_MODEL_NOTES = {
  pollinations: 'Con «Foto realista» tu descripción se completa sola con luz natural, enfoque nítido y anatomía realista, para que la foto salga coherente y parezca real. Pollinations es gratis y sin clave (modelo Sana, no FLUX). Si pide esperar, te avisaremos con una cuenta atrás de ~45 s entre imágenes.',
  horde: 'AI Horde es gratis y anónimo (sin clave): la imagen tarda ~50 s y sale hasta 512 px de lado largo. Es una cola compartida — si hay mucha gente, tarda más y la app te dice el puesto en la cola.',
  cloudflare: 'FLUX.1-schnell en la nube de Cloudflare (~57 imágenes/día gratis). Necesita un token NUEVO con permiso de Workers AI + el Worker proxy (pendiente de desplegar). Mientras tanto usa Sana o AI Horde.',
  hf: 'FLUX.1-schnell con tu token de Hugging Face. El nivel gratis ya no existe (gratis = nada): es de pago o con créditos. Lado largo 1024.',
};
function updateImgModelNote() {
  const m = $('#img-model') && $('#img-model').value;
  const n = $('#img-model-note');
  if (n) n.textContent = IMG_MODEL_NOTES[m] || '';
}

/* ================= GENERAR: pestañas por tipo ================= */
// Imagen (Pollinations Sana / AI Horde / Cloudflare FLUX / HF FLUX),
// Vídeo (imagen→vídeo por atajos web, siempre desde una foto hero),
// Texto (agente OpenCode gratis o Groq gratis con clave),
// Voz (sintetizador de Windows en la PC, por OpenCode).
$$('.gen-tab').forEach(b => b.addEventListener('click', () => {
  $$('.gen-tab').forEach(x => x.classList.toggle('active', x === b));
  const tab = b.dataset.genTab;
  $('#gen-panel-image').hidden = tab !== 'image';
  $('#gen-panel-video').hidden = tab !== 'video';
  $('#gen-panel-text').hidden = tab !== 'text';
  $('#gen-panel-voice').hidden = tab !== 'voice';
  if (tab === 'video') renderVideoShortcuts();
  if (tab === 'text' || tab === 'voice') { /* nada que precargar */ }
  renderCharacterBlock();
}));

// ---- Personaje fijo (CHARACTER_BLOCK por proyecto) -----------------
function characterBlockText(p) {
  const b = p && p.characterBlock;
  if (!b || (!b.base && !b.heroMediaId && !b.trigger)) return '';
  const parts = [];
  if (b.base) parts.push(b.base);
  parts.push('same person, same face, same outfit as the reference image');
  if (b.style === 'jk') parts.push("cinematic J'K style: high contrast, filmic color, dynamic");
  if (b.trigger) parts.push('character: ' + b.trigger);
  return ', ' + parts.join(', ');
}
function renderCharacterBlock() {
  const p = state.project;
  const emptyEl = $('#character-block-empty');
  const formEl = $('#character-block-form');
  if (!p) { emptyEl.hidden = false; formEl.hidden = true; return; }
  emptyEl.hidden = true; formEl.hidden = false;
  const b = p.characterBlock || { heroMediaId: null, base: '', seed: 0, style: 'jk', trigger: '' };
  $('#character-base').value = b.base || '';
  $('#character-seed').value = b.seed || 0;
  $('#character-style').value = b.style || 'jk';
  $('#character-trigger').value = b.trigger || '';
  $('#character-status').textContent = '';
  const heroName = $('#character-hero-name');
  if (b.heroMediaId) {
    Storage.getMediaMeta(b.heroMediaId).then(m => { heroName.textContent = 'Foto hero: ' + ((m && m.name) || 'elegida'); }).catch(() => { heroName.textContent = 'Foto hero elegida.'; });
  } else heroName.textContent = 'Sin foto hero.';
}
$('#btn-character-hero').addEventListener('click', async () => {
  if (!state.project) { toast('Abre primero un proyecto.', 'error'); return; }
  const picked = await openMediaPicker({ kind: 'image', title: 'Foto hero — la cara que no debe cambiar' });
  if (!picked || !picked.length) return;
  state.project.characterBlock = state.project.characterBlock || { heroMediaId: null, base: '', seed: 0, style: 'jk', trigger: '' };
  state.project.characterBlock.heroMediaId = picked[0].id;
  await saveProject(true);
  renderCharacterBlock();
  toast('Foto hero fijada para este proyecto.', 'success', 4000);
});
$('#btn-save-character').addEventListener('click', async () => {
  if (!state.project) { toast('Abre primero un proyecto.', 'error'); return; }
  state.project.characterBlock = {
    heroMediaId: (state.project.characterBlock && state.project.characterBlock.heroMediaId) || null,
    base: $('#character-base').value.trim(),
    seed: Math.max(0, parseInt($('#character-seed').value, 10) || 0),
    style: $('#character-style').value,
    trigger: $('#character-trigger').value.trim(),
  };
  await saveProject(true);
  $('#character-status').textContent = 'Personaje guardado: se añade solo a cada prompt de este proyecto.';
  toast('Personaje del proyecto guardado.', 'success', 4000);
});

// ---- Vídeo: atajos web (sin API pública) ---------------------------
const VIDEO_SHORTCUTS = [
  { name: 'Flick', url: 'https://flick.art', note: 'Tus 100 créditos (vencen 15 nov 2026) · Pruna/Auto/MiniMax H3 gratis' },
  { name: 'fal.ai sandbox', url: 'https://fal.ai', note: '5 vídeos MiniMax H3 al día, gratis' },
  { name: 'Dola (Seedance)', url: 'https://dola.com', note: 'Seedance 2.0/2.5 · ~10–12 vídeos por cuenta de Google · con marca de agua' },
  { name: 'Dreamina', url: 'https://dreamina.capcut.com', note: '120 créditos/día · Seedance' },
  { name: 'Kling', url: 'https://klingai.com', note: 'Créditos diarios gratis' },
  { name: 'Hailuo (MiniMax)', url: 'https://hailuoai.video', note: 'Créditos diarios gratis' },
  { name: 'Wan', url: 'https://wan.video', note: 'Alibaba Wan · créditos gratis' },
  { name: 'Runway', url: 'https://runwayml.com', note: 'Créditos gratis limitados' },
  { name: 'Pika', url: 'https://pika.art', note: 'Créditos diarios gratis' },
];
let videoHeroMediaId = null;
let videoHeroName = '';
function buildVideoPrompt() {
  const action = ($('#video-prompt').value || '').trim();
  const dur = $('#video-duration').value || '5';
  const parts = [];
  if (action) parts.push(action);
  parts.push('video from a still image, keep the same face and outfit, smooth natural motion, ' + dur + ' seconds, vertical 9:16');
  if (state.project) parts.push(characterBlockText(state.project).replace(/^, /, ''));
  return parts.filter(Boolean).join(', ');
}
function renderVideoShortcuts() {
  const root = $('#video-shortcuts');
  if (!root || root.children.length) return;
  for (const s of VIDEO_SHORTCUTS) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn small';
    b.textContent = s.name;
    b.title = s.note;
    b.addEventListener('click', async () => {
      const prompt = buildVideoPrompt();
      try { await navigator.clipboard.writeText(prompt); } catch { /* portapapeles no disponible */ }
      $('#video-status').textContent = 'Prompt copiado al portapapeles. Pega la foto hero y el prompt en ' + s.name + '.';
      window.open(s.url, '_blank', 'noopener');
    });
    const wrap = document.createElement('span');
    wrap.className = 'shortcut-item';
    wrap.appendChild(b);
    const note = document.createElement('span');
    note.className = 'muted small';
    note.textContent = s.note;
    wrap.appendChild(note);
    root.appendChild(wrap);
  }
}
$('#btn-video-hero').addEventListener('click', async () => {
  const picked = await openMediaPicker({ kind: 'image', title: 'Foto hero — primer fotograma del vídeo' });
  if (!picked || !picked.length) return;
  videoHeroMediaId = picked[0].id;
  videoHeroName = picked[0].name || '';
  $('#video-hero-name').textContent = 'Foto hero: ' + videoHeroName + ' (súbela como primer fotograma en el servicio que elijas).';
});
$('#btn-video-copy').addEventListener('click', async () => {
  const prompt = buildVideoPrompt();
  try {
    await navigator.clipboard.writeText(prompt);
    $('#video-status').textContent = 'Prompt copiado.';
    toast('Prompt de vídeo copiado.', 'success', 3000);
  } catch { $('#video-status').textContent = 'No se pudo copiar: ' + prompt; }
});

// ---- Texto: agente OpenCode (gratis) o Groq (gratis con clave) -----
async function groqChat(text, key) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: text }],
      temperature: 0.7, max_tokens: 1200,
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error('Groq devolvió HTTP ' + res.status + (t ? ': ' + t.slice(0, 200) : '') + '.');
  }
  const j = await res.json();
  const out = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  if (!out) throw new Error('Groq no devolvió texto.');
  return String(out).trim();
}
$('#btn-ask-text').addEventListener('click', async () => {
  const text = ($('#text-prompt').value || '').trim();
  if (!text) { toast('Escribe primero la pregunta.', 'error'); return; }
  const model = $('#text-model').value;
  const btn = $('#btn-ask-text');
  const st = $('#text-status');
  const replyEl = $('#text-reply');
  btn.disabled = true; btn.textContent = 'Preguntando…';
  st.textContent = model === 'groq' ? 'Preguntando a Groq…' : 'Preguntando al agente OpenCode en la PC…';
  replyEl.hidden = true; replyEl.textContent = '';
  try {
    let reply;
    if (model === 'groq') {
      const s = await getSettingsSafe();
      if (!s.groqKey) { toast('Groq necesita su clave gratis (console.groq.com) — ponla en Ajustes. O usa el agente OpenCode, que no necesita clave.', 'error', 9000); return; }
      reply = await groqChat(text, s.groqKey);
    } else {
      const ping = await OpenCode.ping(10000).catch(() => ({ ok: false, error: 'sin conexión' }));
      if (!ping.ok) { toast('El agente necesita el motor de la PC (OpenCode): ' + (ping.error || 'sin conexión') + '. Revisa Ajustes → Motor OpenCode.', 'error', 9000); return; }
      reply = await OpenCode.ask(text, { onProgress: (p) => { st.textContent = 'El agente está pensando… ' + Math.round(p * 100) + '%'; } });
    }
    replyEl.textContent = reply;
    replyEl.hidden = false;
    st.textContent = 'Respuesta lista.';
  } catch (e) {
    st.textContent = '';
    toast('No se pudo preguntar: ' + errMsg(e), 'error', 9000);
  } finally {
    btn.disabled = false; btn.textContent = '✦ Preguntar';
  }
});
$('#btn-copy-text-reply').addEventListener('click', async () => {
  const t = $('#text-reply').textContent || '';
  if (!t) { toast('No hay respuesta que copiar.', 'error'); return; }
  try { await navigator.clipboard.writeText(t); toast('Respuesta copiada.', 'success', 3000); }
  catch { toast('No se pudo copiar al portapapeles.', 'error'); }
});

// ---- Voz: sintetizador de Windows en la PC (por OpenCode) ----------
$('#btn-tts').addEventListener('click', async () => {
  const text = ($('#voice-text').value || '').trim();
  if (!text) { toast('Escribe primero el texto para la voz.', 'error'); return; }
  const btn = $('#btn-tts');
  const st = $('#voice-status');
  btn.disabled = true; btn.textContent = 'Generando voz…';
  st.textContent = 'Conectando con la PC…';
  try {
    const ping = await OpenCode.ping(10000).catch(() => ({ ok: false, error: 'sin conexión' }));
    if (!ping.ok) { toast('La voz necesita el motor de la PC (OpenCode): ' + (ping.error || 'sin conexión') + '. Revisa Ajustes → Motor OpenCode.', 'error', 9000); return; }
    const stamp = Date.now();
    const pcPath = OpenCode.PC_WORKDIR + '\\tts-' + stamp + '.wav';
    // PowerShell: voz es-* si la hay instalada; si no, la predeterminada
    // (en Datar solo hay en-US: el español sonará con acento inglés).
    const safe = text.replace(/\s+/g, ' ').replace(/'/g, "''").slice(0, 900);
    const cmd = "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
      + "$v = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture -like 'es*' } | Select-Object -First 1; "
      + "if ($v) { $s.SelectVoice($v.VoiceInfo.Name) }; $s.Rate = 0; "
      + "$s.SetOutputToWaveFile('" + pcPath.replace(/'/g, "''") + "'); $s.Speak('" + safe + "'); $s.Dispose()";
    st.textContent = 'Generando la voz en la PC…';
    await OpenCode.runShell(cmd, { timeoutMs: 120000, onProgress: (p) => { st.textContent = 'Generando la voz en la PC… ' + Math.round(p * 100) + '%'; } });
    st.textContent = 'Bajando el audio de la PC…';
    const blob = await OpenCode.downloadFile(pcPath);
    const id = await Storage.saveMedia(blob, { name: 'Voz — ' + text.slice(0, 60), kind: 'audio' });
    try {
      const pr = await probeWithElement(id);
      await Storage.updateMediaMeta(id, { width: null, height: null, duration: pr.duration || null });
    } catch { /* meta opcional */ }
    const url = await mediaURL(id);
    const player = $('#voice-player');
    player.src = url; player.hidden = false;
    st.textContent = 'Voz lista y guardada en la galería (también se puede añadir a la línea de tiempo como audio).';
    toast('Voz generada y guardada en la galería.', 'success');
    clearURLCache();
  } catch (e) {
    st.textContent = '';
    toast('No se pudo generar la voz: ' + errMsg(e), 'error', 9000);
  } finally {
    btn.disabled = false; btn.textContent = '🎙 Generar voz (PC)';
  }
});

/* ================= SUBTÍTULOS AUTOMÁTICOS (Whisper, PC) ============ */
// Extrae el audio del clip con el motor local, lo sube a Datar, lo
// transcribe con faster-whisper (tiny/base en CPU) y añade cada segmento
// como texto en la línea de tiempo (tercio inferior, como las letras J'K).
async function autoCaptions() {
  const p = state.project;
  if (!p || !p.clips.length) { toast('Abre primero un proyecto con un vídeo en el Editor.', 'error'); return; }
  const sel = selectedItem();
  const clip = (sel && sel.item && sel.item.kind === 'video') ? sel.item : p.clips.find(c => c.kind === 'video');
  if (!clip || !clip.mediaId) { toast('El proyecto no tiene un clip de vídeo con medio.', 'error'); return; }
  if (typeof Engine.extractAudioWav !== 'function') { toast('Tu motor de vídeo no trae la extracción de audio (actualiza la app).', 'error'); return; }
  showScreen('editor');
  try {
    const ping = await OpenCode.ping(10000).catch(() => ({ ok: false, error: 'sin conexión' }));
    if (!ping.ok) { toast('Subtítulos automáticos necesitan el motor de la PC (OpenCode): ' + (ping.error || 'sin conexión') + '. Revisa Ajustes → Motor OpenCode.', 'error', 10000); return; }
    toast('Extrayendo el audio del clip…', 'info', 5000);
    if (!(await ensureEngine())) return;
    const wavId = await Engine.extractAudioWav(clip.mediaId);
    const wavBlob = await Storage.getMedia(wavId);
    const pcPath = OpenCode.pcWorkPath('subtitulos-' + String(clip.name || 'clip').replace(/[^\w.-]+/g, '_') + '.wav');
    toast('Subiendo el audio a la PC…', 'info', 5000);
    await OpenCode.uploadFile(wavBlob, pcPath);
    toast('Transcribiendo con Whisper en la PC (esto tarda unos segundos por clip)…', 'info', 10000);
    const result = await OpenCode.whisper(pcPath, { timeoutMs: 300000 });
    const segs = (result.segments || []).filter(s => (s.text || '').trim());
    if (!segs.length) { toast('Whisper no detectó voz en este clip.', 'error', 8000); return; }
    const start0 = clipStartTime(clip.id);
    const speed = clip.speed || 1;
    const trimStart = clip.trimStart || 0;
    const trimEnd = clip.trimEnd ?? null;
    const clipLen = (trimEnd != null ? trimEnd : (result.duration || 0)) - trimStart;
    let added = 0;
    for (const s of segs) {
      const t0 = (s.start - trimStart) / speed;
      const t1 = (s.end - trimStart) / speed;
      if (t1 <= 0) continue;
      if (trimEnd != null && t0 >= clipLen / speed) continue;
      p.texts.push({
        id: uid(), text: s.text.trim(), size: 56, color: '#ffffff', bg: null,
        stroke: { color: '#000000', width: 4 }, bold: true, italic: false,
        x: 0, y: 180, start: start0 + Math.max(0, t0), end: start0 + Math.max(0, t1), keyframes: [],
      });
      added++;
    }
    if (!added) { toast('Los segmentos quedaron fuera del recorte del clip.', 'error', 8000); return; }
    await saveProject(true);
    await renderEditor();
    toast('Subtítulos listos: ' + added + ' textos en la línea de tiempo (puedes moverlos o borrarlos uno a uno).', 'success', 8000);
  } catch (e) {
    toast('Subtítulos automáticos: ' + errMsg(e), 'error', 10000);
  }
}

async function renderImages() {
  const grid = $('#images-grid');
  const emptyEl = $('#images-empty');
  grid.innerHTML = '';
  let items = [];
  try { items = await Storage.listMedia('image'); } catch (e) { toast('No se pudo leer la galería: ' + errMsg(e), 'error'); }
  emptyEl.hidden = items.length > 0;
  for (const m of items) {
    const card = document.createElement('div');
    card.className = 'image-card';
    const img = document.createElement('img');
    img.alt = m.name || 'Imagen';
    img.src = await mediaURL(m.id).catch(() => '') || '';
    const body = document.createElement('div'); body.className = 'image-card-body';
    const nm = document.createElement('div'); nm.className = 'img-name'; nm.textContent = m.name || 'Sin nombre';
    const acts = document.createElement('div'); acts.className = 'image-card-actions';
    const bAdd = document.createElement('button'); bAdd.type = 'button'; bAdd.className = 'btn small primary'; bAdd.textContent = '＋ A la línea de tiempo';
    bAdd.addEventListener('click', async () => {
      if (!state.project) { toast('Abre primero un proyecto en el Editor para añadir la imagen.', 'error'); return; }
      await addMediaToTimeline(m);
      showScreen('editor');
    });
    const bDl = document.createElement('button'); bDl.type = 'button'; bDl.className = 'btn small'; bDl.textContent = 'Descargar';
    bDl.addEventListener('click', async () => {
      const url = await mediaURL(m.id).catch(() => null);
      if (!url) { toast('No se pudo leer la imagen.', 'error'); return; }
      const a = document.createElement('a'); a.href = url; a.download = (m.name || 'imagen').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') + '.png'; a.click();
    });
    const bBg = document.createElement('button'); bBg.type = 'button'; bBg.className = 'btn small'; bBg.textContent = 'Quitar fondo';
    bBg.addEventListener('click', () => removeBackground(m));
    const bDel = document.createElement('button'); bDel.type = 'button'; bDel.className = 'btn small danger'; bDel.textContent = 'Eliminar';
    bDel.addEventListener('click', async () => {
      if (!confirmDlg('¿Eliminar «' + (m.name || 'esta imagen') + '» de la galería?')) return;
      try { await Storage.deleteMedia(m.id); probeCache.delete(m.id); clearURLCache(); toast('Imagen eliminada.', 'success', 3000); renderImages(); }
      catch (e) { toast('No se pudo eliminar: ' + errMsg(e), 'error'); }
    });
    acts.append(bAdd, bDl, bBg, bDel);
    body.append(nm, acts);
    card.append(img, body);
    grid.appendChild(card);
  }
}
$('#btn-generate').addEventListener('click', generateImage);
$('#img-model').addEventListener('change', () => updateImgModelNote());

async function removeBackground(m) {
  const settings = await getSettingsSafe();
  if (!settings.hfToken) {
    toast('Necesitas tu token gratis de Hugging Face — ponlo en Ajustes.', 'error', 8000);
    return;
  }
  toast('Quitando el fondo…', 'info', 4000);
  try {
    const src = await Storage.getMedia(m.id);
    if (!src) throw new Error('No se pudo leer la imagen.');
    const res = await fetch('https://router.huggingface.co/hf-inference/models/briaai/RMBG-1.4', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + settings.hfToken, 'Content-Type': 'application/octet-stream' },
      body: src,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error('Hugging Face devolvió HTTP ' + res.status + (text ? ': ' + text.slice(0, 200) : '') + '.');
    }
    const ct = res.headers.get('content-type') || '';
    if (!ct.startsWith('image/')) throw new Error('El servicio no devolvió una imagen (content-type: ' + ct + ').');
    const blob = await res.blob();
    await Storage.saveMedia(blob, { name: (m.name || 'Imagen') + ' — sin fondo', kind: 'image' });
    clearURLCache();
    toast('Fondo quitado. La versión sin fondo está en la galería.', 'success');
    renderImages();
  } catch (e) { toast('No se pudo quitar el fondo: ' + errMsg(e), 'error', 9000); }
}

/* ================= CLON ================= */
function renderClone() {
  updateTakePreview('a');
  updateTakePreview('b');
  updateClonePreview();
}
async function updateTakePreview(which) {
  const take = which === 'a' ? state.cloneA : state.cloneB;
  const box = $('#take-' + which + '-preview');
  box.innerHTML = '';
  if (!take) { box.innerHTML = '<span class="muted small">Sin toma elegida</span>'; return; }
  const url = await mediaURL(take.mediaId).catch(() => null);
  if (!url) { box.innerHTML = '<span class="muted small">No se pudo cargar la toma.</span>'; return; }
  const v = document.createElement('video');
  v.src = url; v.muted = true; v.loop = true; v.playsInline = true; v.controls = true; v.preload = 'metadata';
  const name = document.createElement('div'); name.className = 'muted small'; name.textContent = take.name || '';
  box.append(v, name);
}
function updateClonePreview() {
  const div = parseInt($('#clone-divider').value, 10) || 50;
  $('#clone-divider-value').textContent = div + '%';
  $('#clone-preview-a').style.flex = '1 1 ' + div + '%';
  $('#clone-preview-b').style.flex = '1 1 ' + (100 - div) + '%';
  for (const [which, boxId] of [['a', 'clone-preview-a'], ['b', 'clone-preview-b']]) {
    const take = which === 'a' ? state.cloneA : state.cloneB;
    const box = $('#' + boxId);
    box.querySelectorAll('video').forEach(v => v.remove());
    if (!take) { if (!box.querySelector('.muted')) box.innerHTML = '<span class="muted small">Toma ' + which.toUpperCase() + '</span>'; continue; }
    box.querySelectorAll('.muted').forEach(n => n.remove());
    mediaURL(take.mediaId).then(url => {
      if (!url) return;
      const v = document.createElement('video');
      v.src = url; v.muted = true; v.loop = true; v.playsInline = true; v.autoplay = true;
      v.play().catch(() => {});
      box.appendChild(v);
    });
  }
}
$('#clone-divider').addEventListener('input', updateClonePreview);

function pickFromGallery(which) {
  Storage.listMedia('video').then(items => {
    if (!items.length) { toast('La galería no tiene vídeos. Sube primero las dos tomas desde el Editor.', 'error'); return; }
    const root = $('#modal-root');
    root.innerHTML = '';
    const overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;z-index:200';
    const box = document.createElement('div');
    box.className = 'card'; box.style.cssText = 'max-width:520px;width:92%;max-height:80vh;overflow-y:auto';
    box.innerHTML = '<h2>Elegir toma ' + which.toUpperCase() + '</h2>';
    for (const m of items) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn'; b.style.cssText = 'display:block;width:100%;text-align:left;margin-bottom:.4rem';
      b.textContent = m.name + ' · ' + fmtSize(m.size) + (m.duration ? ' · ' + fmtTime(m.duration) : '');
      b.addEventListener('click', () => {
        if (which === 'a') state.cloneA = { mediaId: m.id, name: m.name };
        else state.cloneB = { mediaId: m.id, name: m.name };
        root.innerHTML = '';
        renderClone();
      });
      box.appendChild(b);
    }
    const cancel = document.createElement('button');
    cancel.type = 'button'; cancel.className = 'btn'; cancel.textContent = 'Cancelar';
    cancel.addEventListener('click', () => { root.innerHTML = ''; });
    box.appendChild(cancel);
    overlay.appendChild(box);
    overlay.addEventListener('click', e => { if (e.target === overlay) root.innerHTML = ''; });
    root.appendChild(overlay);
  }).catch(e => toast('No se pudo leer la galería: ' + errMsg(e), 'error'));
}
$('#btn-take-a-gallery').addEventListener('click', () => pickFromGallery('a'));
$('#btn-take-b-gallery').addEventListener('click', () => pickFromGallery('b'));
$('#btn-take-a-upload').addEventListener('click', () => $('#file-take-a').click());
$('#btn-take-b-upload').addEventListener('click', () => $('#file-take-b').click());
async function handleTakeUpload(which, file) {
  if (!file) return;
  if (!file.type.startsWith('video/')) { toast('La toma debe ser un vídeo.', 'error'); return; }
  try {
    const id = await Storage.saveMedia(file, { name: file.name, kind: 'video' });
    clearURLCache();
    if (which === 'a') state.cloneA = { mediaId: id, name: file.name };
    else state.cloneB = { mediaId: id, name: file.name };
    toast('Toma ' + which.toUpperCase() + ' subida.', 'success', 3000);
    renderClone();
  } catch (e) { toast('No se pudo subir la toma: ' + errMsg(e), 'error'); }
}
$('#file-take-a').addEventListener('change', e => { handleTakeUpload('a', e.target.files[0]); e.target.value = ''; });
$('#file-take-b').addEventListener('change', e => { handleTakeUpload('b', e.target.files[0]); e.target.value = ''; });

$('#btn-export-clone').addEventListener('click', async () => {
  if (!state.cloneA || !state.cloneB) { toast('Elige primero la toma A (izquierda) y la toma B (derecha).', 'error'); return; }
  if (!(await ensureEngine())) return;
  const divider = (parseInt($('#clone-divider').value, 10) || 50) / 100;
  const status = $('#clone-status');
  status.textContent = 'Componiendo el clon…';
  $('#btn-export-clone').disabled = true;
  $('#btn-download-clone').hidden = true;
  try {
    const mediaId = await Engine.composeClone(state.cloneA.mediaId, state.cloneB.mediaId, { divider });
    // El motor guarda el resultado en la galería y devuelve su mediaId (§3).
    let url = null;
    if (typeof mediaId === 'string') url = await mediaURL(mediaId).catch(() => null);
    if (!url) throw new Error('El motor compuso el clon pero no devolvió un medio descargable.');
    // En el teléfono el enlace <a download> no guarda: se escribe el
    // archivo y se abre la ventana de compartir.
    if (isNativeApp() && nativeFilesystem()) {
      const blob = await Storage.getMedia(mediaId);
      const saved = blob ? await saveBlobNative(blob, 'influencer-xl-clon.mp4').catch(e => { console.warn('Guardado nativo falló:', e); return null; }) : null;
      if (saved) {
        status.textContent = saved === 'shared'
          ? 'Clon listo y guardado en la galería. Elige dónde guardarlo en la ventana que se abrió.'
          : 'Clon listo y guardado en la galería y en el caché de la app.';
        toast('Clon compuesto y guardado en la galería.', 'success');
        return;
      }
    }
    const dl = $('#btn-download-clone');
    dl.href = url;
    dl.download = 'influencer-xl-clon.mp4';
    dl.hidden = false;
    status.textContent = 'Clon listo y guardado en la galería. Pulsa «Descargar clon».';
    toast('Clon compuesto y guardado en la galería.', 'success');
  } catch (e) {
    status.textContent = 'El clon falló: ' + errMsg(e);
    toast('El clon falló: ' + errMsg(e), 'error', 9000);
  } finally {
    $('#btn-export-clone').disabled = false;
  }
});

/* ================= AJUSTES ================= */
async function getSettingsSafe() {
  try {
    const s = Storage.getSettings();
    return s && typeof s.then === 'function' ? await s : (s || {});
  } catch { return {}; }
}
async function renderSettings() {
  const s = await getSettingsSafe();
  $('#setting-hf-token').value = s.hfToken || '';
  $('#setting-pollinations-key').value = s.pollinationsKey || '';
  $('#setting-groq-key').value = s.groqKey || '';
  $('#setting-cf-token').value = s.cfToken || '';
  const oc = OpenCode.getSettings();
  $('#setting-opencode-url').value = oc.serverUrl || '';
  $('#setting-opencode-password').value = oc.password || '';
  $('#setting-whisper-model').value = oc.whisperModel || 'tiny';
  $('#settings-status').textContent = '';
  $('#opencode-status').textContent = '';
  $('#about-version').textContent = VERSION;
}
$('#btn-save-settings').addEventListener('click', async () => {
  try {
    const r = Storage.setSettings({
      hfToken: $('#setting-hf-token').value.trim(),
      pollinationsKey: $('#setting-pollinations-key').value.trim(),
      groqKey: $('#setting-groq-key').value.trim(),
      cfToken: $('#setting-cf-token').value.trim(),
    });
    if (r && typeof r.then === 'function') await r;
    OpenCode.saveSettings({
      serverUrl: $('#setting-opencode-url').value.trim(),
      password: $('#setting-opencode-password').value.trim(),
      whisperModel: $('#setting-whisper-model').value,
    });
    $('#settings-status').textContent = 'Ajustes guardados en este dispositivo.';
    toast('Ajustes guardados.', 'success', 3000);
  } catch (e) { toast('No se pudieron guardar los ajustes: ' + errMsg(e), 'error'); }
});
$('#btn-opencode-pc').addEventListener('click', () => {
  $('#setting-opencode-url').value = 'http://127.0.0.1:4096';
  toast('URL puesta para esta PC. Guarda los ajustes.', 'info', 4000);
});
$('#btn-opencode-phone').addEventListener('click', () => {
  $('#setting-opencode-url').value = 'http://100.93.202.6:4096';
  toast('URL puesta para el teléfono (por Tailscale). Guarda los ajustes.', 'info', 4000);
});
$('#btn-opencode-test').addEventListener('click', async () => {
  const st = $('#opencode-status');
  st.textContent = 'Probando…';
  try {
    // Probar con lo que hay escrito (sin obligar a guardar primero).
    OpenCode.saveSettings({
      serverUrl: $('#setting-opencode-url').value.trim(),
      password: $('#setting-opencode-password').value.trim(),
      whisperModel: $('#setting-whisper-model').value,
    });
    const r = await OpenCode.ping(15000);
    if (r.ok) {
      st.textContent = 'Conectado: OpenCode responde (' + r.sessions + ' sesiones).';
      toast('Motor PC conectado.', 'success', 4000);
    } else {
      st.textContent = 'Sin conexión: ' + (r.error || ('HTTP ' + r.status));
      toast('Motor PC sin conexión: ' + (r.error || ('HTTP ' + r.status)), 'error', 9000);
    }
  } catch (e) {
    st.textContent = 'Sin conexión: ' + errMsg(e);
    toast('Motor PC sin conexión: ' + errMsg(e), 'error', 9000);
  }
});
$('#btn-delete-all').addEventListener('click', async () => {
  if (!confirmDlg('¿Borrar TODOS los proyectos y medios de INFLUENCER XL en este dispositivo? Esta acción no se puede deshacer.')) return;
  if (!confirmDlg('Seguro del todo: se borrarán todos los proyectos, vídeos, imágenes y audios guardados. ¿Continuar?')) return;
  try {
    const projects = await Storage.listProjects();
    for (const p of projects) await Storage.deleteProject(p.id);
    const media = await Storage.listMedia();
    for (const m of media) await Storage.deleteMedia(m.id);
    clearURLCache(); probeCache.clear();
    state.project = null; state.selection = null; state.cloneA = null; state.cloneB = null;
    toast('Todos los datos borrados.', 'success');
    renderSettings();
  } catch (e) { toast('No se pudieron borrar todos los datos: ' + errMsg(e), 'error'); }
});

/* ================= Crear proyecto ================= */
$('#btn-create-project').addEventListener('click', async () => {
  const name = $('#new-project-name').value.trim() || 'Proyecto sin nombre';
  const ratio = $('#new-project-ratio').value;
  const p = newProjectObject(name, ratio);
  try {
    await Storage.saveProject(p);
    $('#new-project-name').value = '';
    toast('Proyecto «' + name + '» creado.', 'success', 3000);
    await openProject(p.id);
  } catch (e) { toast('No se pudo crear el proyecto: ' + errMsg(e), 'error'); }
});
$('#new-project-name').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btn-create-project').click(); });

/* ================= Inicio estilo CapCut + selector de medios ================= */
// Selector de medios (modal): Álbumes/Biblioteca, pestañas Vídeos/Fotos,
// rejilla de miniaturas con duración y círculos de selección. Devuelve las
// metas elegidas o null si se cancela. La fuente es la Biblioteca local
// (IndexedDB); «＋ Subir» añade archivos del dispositivo a la Biblioteca.
const pickerState = { kind: 'video', selected: new Set(), resolve: null };
function openMediaPicker({ kind = 'video', title = 'Elegir medios' } = {}) {
  return new Promise((resolve) => {
    pickerState.kind = kind;
    pickerState.selected = new Set();
    pickerState.resolve = resolve;
    $('#picker-title').textContent = title;
    $('#media-picker').hidden = false;
    renderPicker();
  });
}
function closeMediaPicker(result) {
  $('#media-picker').hidden = true;
  const resolve = pickerState.resolve;
  pickerState.resolve = null;
  if (resolve) resolve(result ?? null);
}
async function renderPicker() {
  const grid = $('#picker-grid');
  const emptyEl = $('#picker-empty');
  grid.innerHTML = '';
  $$('.picker-tab').forEach(t => t.classList.toggle('active', t.dataset.kind === pickerState.kind));
  let items = [];
  try { items = await Storage.listMedia(pickerState.kind); }
  catch (e) { toast('No se pudo leer la Biblioteca: ' + errMsg(e), 'error'); }
  emptyEl.hidden = items.length > 0;
  for (const m of items) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'picker-tile' + (pickerState.selected.has(m.id) ? ' selected' : '');
    tile.setAttribute('aria-label', m.name || 'Medio');
    let thumb;
    if (m.kind === 'audio') {
      thumb = document.createElement('span');
      thumb.className = 'picker-audio';
      thumb.textContent = '♪';
    } else if (m.kind === 'image') {
      thumb = document.createElement('img');
      thumb.alt = '';
    } else {
      thumb = document.createElement('video');
      thumb.muted = true;
      thumb.preload = 'metadata';
      thumb.playsInline = true;
    }
    const url = await mediaURL(m.id).catch(() => null);
    if (url && m.kind !== 'audio') thumb.src = url;
    const check = document.createElement('span');
    check.className = 'picker-check';
    check.textContent = pickerState.selected.has(m.id) ? '✓' : '';
    const nm = document.createElement('span');
    nm.className = 'picker-name';
    nm.textContent = m.name || 'Sin nombre';
    tile.append(thumb, check, nm);
    if (m.kind === 'video' && m.duration) {
      const dur = document.createElement('span');
      dur.className = 'picker-dur';
      dur.textContent = fmtTime(m.duration);
      tile.appendChild(dur);
    }
    tile.addEventListener('click', () => {
      if (pickerState.selected.has(m.id)) pickerState.selected.delete(m.id);
      else pickerState.selected.add(m.id);
      tile.classList.toggle('selected', pickerState.selected.has(m.id));
      check.textContent = pickerState.selected.has(m.id) ? '✓' : '';
      updatePickerFoot();
    });
    grid.appendChild(tile);
  }
  updatePickerFoot();
}
function updatePickerFoot() {
  const n = pickerState.selected.size;
  $('#picker-count').textContent = n + (n === 1 ? ' seleccionado' : ' seleccionados');
  $('#picker-add').disabled = n === 0;
  $('#picker-add').textContent = n > 0 ? 'Añadir (' + n + ')' : 'Añadir';
}
$$('.picker-tab').forEach(t => t.addEventListener('click', () => {
  pickerState.kind = t.dataset.kind;
  pickerState.selected = new Set();
  renderPicker();
}));
$('#picker-close').addEventListener('click', () => closeMediaPicker(null));
$('#picker-cancel').addEventListener('click', () => closeMediaPicker(null));
$('#picker-add').addEventListener('click', async () => {
  const ids = [...pickerState.selected];
  let items = [];
  try { items = await Storage.listMedia(pickerState.kind); } catch { /* ya avisado */ }
  closeMediaPicker(items.filter(m => ids.includes(m.id)));
});
$('#picker-upload').addEventListener('click', () => $('#picker-upload-input').click());
$('#picker-upload-input').addEventListener('change', async e => {
  const files = [...(e.target.files || [])];
  e.target.value = '';
  if (!files.length) return;
  await uploadFiles(files);
  renderPicker();
});

// Crea un proyecto con los medios elegidos y lo abre en el Editor.
async function createProjectFromMedia(medias, { namePrefix = 'Vídeo nuevo', ratio = '9:16' } = {}) {
  if (!medias || !medias.length) return null;
  const stamp = new Date().toLocaleDateString('es-CU', { day: 'numeric', month: 'short' });
  const p = newProjectObject(namePrefix + ' — ' + stamp, ratio);
  try {
    await Storage.saveProject(p);
  } catch (e) { toast('No se pudo crear el proyecto: ' + errMsg(e), 'error'); return null; }
  state.project = p;
  state.selection = null;
  state.playhead = 0;
  state.playing = false;
  state.clipDurations.clear();
  seedHistory();
  showScreen('editor');
  for (const m of medias) await addMediaToTimeline(m);
  return p;
}

// Tarjetas grandes del inicio.
$('#btn-home-new-video').addEventListener('click', async () => {
  const picked = await openMediaPicker({ kind: 'video', title: 'Vídeo nuevo — elige clips' });
  if (picked) await createProjectFromMedia(picked, { namePrefix: 'Vídeo nuevo' });
});
$('#btn-home-edit-photo').addEventListener('click', async () => {
  const picked = await openMediaPicker({ kind: 'image', title: 'Editar foto — elige una foto' });
  if (picked) await createProjectFromMedia(picked.slice(0, 1), { namePrefix: 'Editar foto' });
});

// Herramientas rápidas.
$('#qt-photo-editor').addEventListener('click', () => $('#btn-home-edit-photo').click());
$('#qt-camera').addEventListener('click', () => $('#home-camera-input').click());
$('#home-camera-input').addEventListener('change', async e => {
  const files = [...(e.target.files || [])];
  e.target.value = '';
  if (!files.length) return;
  const saved = await uploadFiles(files, { quiet: true });
  const videos = saved.filter(m => m.kind === 'video');
  if (videos.length) await createProjectFromMedia(videos, { namePrefix: 'Vídeo nuevo' });
  else toast('No se grabó ningún vídeo.', 'error');
});
$('#qt-autocut').addEventListener('click', async () => {
  const picked = await openMediaPicker({ kind: 'video', title: 'AutoCut — elige clips' });
  if (!picked) return;
  const p = await createProjectFromMedia(picked, { namePrefix: 'AutoCut' });
  if (!p) return;
  // El corte automático (quitar silencios con silencedetect) llega en la
  // oleada 3 de InShot; los clips ya están en la línea de tiempo. Cuando
  // el motor lo tenga, este botón lo aplica solo. Nunca se finge el corte.
  if (typeof Engine.autoCut === 'function') {
    let done = 0;
    for (const c of [...state.project.clips]) {
      if (c.kind !== 'video' || c.placeholder) continue;
      try {
        const id = await Engine.autoCut(c.mediaId);
        const meta = await Storage.getMediaMeta(id);
        c.mediaId = id;
        c.name = (meta && meta.name) || c.name;
        c.trimStart = 0; c.trimEnd = null;
        state.clipDurations.delete(c.id);
        done++;
      } catch (e) { toast('AutoCut falló en «' + (c.name || 'clip') + '»: ' + errMsg(e), 'error'); }
    }
    await saveProject(true);
    await renderEditor();
    clearURLCache();
    await renderGallery();
    if (done) toast('AutoCut aplicado a ' + done + (done === 1 ? ' clip' : ' clips') + ': silencios eliminados.', 'success');
  } else {
    toast('Corte automático (quitar silencios) llega en la oleada 3 de funciones — los clips ya están en la línea de tiempo.', 'info', 9000);
  }
});
$('#qt-autocaptions').addEventListener('click', () => { autoCaptions(); });
$('#qt-speed').addEventListener('click', async () => {
  if (state.project && state.project.clips.length) {
    showScreen('editor');
    state.selection = { track: 'video', id: state.project.clips[0].id };
    renderTimeline();
    showInspectorSection('Velocidad');
    return;
  }
  const picked = await openMediaPicker({ kind: 'video', title: 'Adjust speed — elige un clip' });
  if (!picked) return;
  await createProjectFromMedia(picked.slice(0, 1), { namePrefix: 'Velocidad' });
  if (state.project && state.project.clips.length) {
    state.selection = { track: 'video', id: state.project.clips[0].id };
    renderTimeline();
    showInspectorSection('Velocidad');
  }
});
$('#qt-all-tools').addEventListener('click', async () => {
  if (state.project && state.project.clips.length) { showScreen('editor'); return; }
  const picked = await openMediaPicker({ kind: 'video', title: 'All tools — elige un clip' });
  if (picked) await createProjectFromMedia(picked.slice(0, 1), { namePrefix: 'Vídeo nuevo' });
});

// Teleprompter: texto real que baja por la pantalla a velocidad ajustable,
// para leerlo mientras se graba con la cámara del teléfono.
let tpTimer = null;
let tpRunning = false;
function tpStop() {
  tpRunning = false;
  if (tpTimer) { clearInterval(tpTimer); tpTimer = null; }
  $('#tp-stop').hidden = true;
  $('#tp-start').hidden = false;
}
$('#qt-teleprompter').addEventListener('click', () => {
  tpStop();
  $('#tp-stage').hidden = true;
  $('#teleprompter').hidden = false;
});
$('#tp-close').addEventListener('click', () => { tpStop(); $('#teleprompter').hidden = true; });
$('#tp-speed').addEventListener('input', e => { $('#tp-speed-value').textContent = e.target.value; });
$('#tp-start').addEventListener('click', () => {
  const text = $('#tp-text').value.trim();
  if (!text) { toast('Escribe primero el texto que vas a leer.', 'error'); return; }
  const scroll = $('#tp-scroll');
  scroll.textContent = text;
  scroll.style.top = '100%';
  $('#tp-stage').hidden = false;
  $('#tp-start').hidden = true;
  $('#tp-stop').hidden = false;
  tpRunning = true;
  const stage = $('#tp-stage');
  const pxPerSec = Number($('#tp-speed').value) || 40;
  tpTimer = setInterval(() => {
    if (!tpRunning) return;
    const cur = parseFloat(scroll.style.top) || 100;
    const next = cur - (pxPerSec / 10) / stage.clientHeight * 100;
    if (next < -((scroll.clientHeight / stage.clientHeight) * 100)) { tpStop(); return; }
    scroll.style.top = next + '%';
  }, 100);
});
$('#tp-stop').addEventListener('click', tpStop);
$('#tp-stage').addEventListener('click', () => { tpRunning = !tpRunning; });

/* ================= Estilo J'K ================= */
// Estilo de J'K (@jk_elements): reels ~25 s, cortes rápidos al ritmo,
// antes/después (crudo + cuenta atrás 3-2-1 + edit final), color
// cinematográfico (B/N desaturado alternando con color intenso, filtro
// cómic) y letras grandes en amarillo.
const JK_YELLOW = '#ffe600';
const JK_LYRICS_SIZE = 80;
const JK_LYRICS_Y = 180; // tercio inferior del lienzo (720p, centro = 0)

function yellowLyricsText(text, start, end, y) {
  return {
    id: uid(), text, size: JK_LYRICS_SIZE, color: JK_YELLOW, bg: null,
    stroke: { color: '#000000', width: 6 }, bold: true, italic: false,
    x: 0, y: (y ?? JK_LYRICS_Y), start, end, keyframes: [],
  };
}

async function addYellowLyricsAtPlayhead() {
  if (!state.project) { toast('Abre primero un proyecto en el Editor.', 'error'); return; }
  const t = yellowLyricsText('Tu letra aquí', state.playhead, state.playhead + 3);
  state.project.texts.push(t);
  state.selection = { track: 'texts', id: t.id };
  await saveProject(true);
  renderTimeline(); renderInspector(); updatePreview();
  toast('Letras amarillas añadidas. Edita la letra en el inspector.', 'success', 3000);
}

function jkSlotClip(name, trimEnd, preset, slot) {
  return {
    id: uid(), kind: 'video', mediaId: null, name,
    trimStart: 0, trimEnd, speed: 1,
    filters: { brightness: 0, contrast: 1, saturation: 1, preset },
    chroma: null, transition: { type: 'none', duration: 0.5 }, keyframes: [], volume: 1,
    placeholder: true, slot,
  };
}

async function createJKTemplate() {
  // La plantilla es un proyecto nuevo: el abierto (si lo hay) queda guardado.
  if (state.project) await saveProject(true);
  const p = newProjectObject('Plantilla J\'K — reel 25 s', '9:16');
  // Estructura ~25 s: crudo/BTS 11 s (la cuenta atrás 3-2-1 va sobre sus
  // últimos 3 s, como en los antes/después de J'K), clip final 14 s con el
  // look J'K (Cómic) + letras amarillas.
  p.clips = [
    jkSlotClip('① Crudo / BTS — toca para elegir tu clip', 11, 'none', 'bts'),
    jkSlotClip('② Final — look J\'K (Cómic)', 14, 'comic', 'final'),
  ];
  const cd = (n, start) => ({
    id: uid(), text: String(n), size: 200, color: JK_YELLOW, bg: null,
    stroke: { color: '#000000', width: 8 }, bold: true, italic: false,
    x: 0, y: 0, start, end: start + 1, keyframes: [],
  });
  p.texts = [
    {
      id: uid(), text: 'GUARDA ESTO', size: 56, color: JK_YELLOW, bg: null,
      stroke: { color: '#000000', width: 5 }, bold: true, italic: false,
      x: 0, y: -100, start: 0, end: 3, keyframes: [],
    },
    cd(3, 8), cd(2, 9), cd(1, 10),
    yellowLyricsText('AL BERRO', 11, 15),
  ];
  p.audios = [];
  // Si la galería ya tiene vídeos, los huecos se rellenan con vídeos reales
  // (los más recientes primero) para que la plantilla nunca se vea vacía:
  // el primero en crudo y el segundo con el look Cómic; con un solo vídeo,
  // los dos huecos usan el mismo (crudo + edit final, como hace J'K).
  // La duración y el look de cada hueco se conservan, y el marcador slot
  // ('bts'/'final') también: el hueco sigue siendo el hueco ①/② y se puede
  // cambiar después tocándolo y eligiendo otro vídeo de la galería.
  let galleryVideos = [];
  try { galleryVideos = await Storage.listMedia('video'); } catch {}
  const fillSlot = (slot, media) => {
    slot.mediaId = media.id;
    slot.kind = media.kind;
    slot.name = media.name;
    slot.placeholder = false;
  };
  if (galleryVideos.length) {
    fillSlot(p.clips[0], galleryVideos[0]);
    fillSlot(p.clips[1], galleryVideos[1] || galleryVideos[0]);
  }
  try {
    await Storage.saveProject(p);
    await openProject(p.id);
    // El primer hueco queda seleccionado para que se vea qué es y se pueda
    // cambiar tocando otro vídeo de la galería.
    state.selection = { track: 'video', id: p.clips[0].id };
    renderTimeline(); renderInspector(); updatePreview();
    toast(galleryVideos.length
      ? 'Plantilla J\'K creada con tus vídeos: el primero en crudo y el segundo con el look Cómic. Toca un hueco y elige otro de la galería para cambiarlo.'
      : 'Plantilla J\'K creada con huecos vacíos: toca un vídeo de la galería para rellenar el primer hueco.', 'success', 8000);
  } catch (e) { toast('No se pudo crear la plantilla: ' + errMsg(e), 'error'); }
}

async function applyLookJK() {
  if (!state.project || !state.project.clips.length) { toast('Añade primero clips a la línea de tiempo.', 'error'); return; }
  let kept = 0;
  state.project.clips.forEach((c, i) => {
    c.filters = c.filters || { brightness: 0, contrast: 1, saturation: 1 };
    if (c.filters.preset === 'comic') { kept++; return; } // el Cómic se respeta
    c.filters.preset = i % 2 === 0 ? 'bw' : 'color';
  });
  await saveProject(true);
  renderTimeline(); renderInspector(); updatePreview();
  toast('Look J\'K aplicado: B/N y color intenso alternos' + (kept ? ' (el Cómic se respeta).' : '.'), 'success', 5000);
}

async function applyComicToSelected() {
  const sel = selectedItem();
  if (!sel || !sel.item || state.selection.track !== 'video') { toast('Selecciona primero un clip de vídeo en la línea de tiempo.', 'error'); return; }
  const c = sel.item;
  if (c.placeholder) { toast('Ese hueco aún no tiene clip. Rellénalo primero desde la galería.', 'error'); return; }
  c.filters = c.filters || { brightness: 0, contrast: 1, saturation: 1 };
  c.filters.preset = 'comic';
  await saveProject(true);
  renderTimeline(); renderInspector(); updatePreview();
  toast('Cómic aplicado al clip «' + (c.name || '') + '». Se ve en la vista previa (aproximación) y completo al exportar.', 'success', 4000);
}

$('#btn-jk-template').addEventListener('click', createJKTemplate);
$('#btn-jk-template-projects').addEventListener('click', createJKTemplate);
$('#btn-jk-lyrics').addEventListener('click', addYellowLyricsAtPlayhead);
$('#btn-jk-look').addEventListener('click', applyLookJK);
$('#btn-jk-comic').addEventListener('click', applyComicToSelected);

/* ================= Barra de herramientas del editor (estilo CapCut) ================= */
// Vista previa grande arriba, línea de tiempo debajo y botones abajo. En el
// teléfono los paneles empiezan cerrados y se abren desde aquí; en escritorio
// siempre se ven (salvo que el usuario los cierre con su botón).
function showEditorPanel(el) {
  el.classList.remove('panel-hidden');
  el.classList.add('panel-open');
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function toggleEditorPanel(el) {
  const visible = el.offsetParent !== null && !el.classList.contains('panel-hidden');
  if (visible) { el.classList.add('panel-hidden'); el.classList.remove('panel-open'); }
  else showEditorPanel(el);
}
function showInspectorSection(heading) {
  const insp = document.querySelector('.inspector');
  showEditorPanel(insp);
  // PIP y Adhesivos viven en el panel del proyecto (sin selección).
  const projectHeadings = ['PIP', 'Adhesivos'];
  if (!selectedItem() && !projectHeadings.includes(heading)) { toast('Selecciona un clip en la línea de tiempo para editarlo.', 'error'); return; }
  const hit = [...document.querySelectorAll('#inspector-body h3, #inspector-body label')]
    .find(h => (h.textContent || '').includes(heading));
  if (hit) hit.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
$('#tb-media').addEventListener('click', () => toggleEditorPanel(document.querySelector('.media-panel')));
$('#tb-text').addEventListener('click', () => $('#btn-add-text').click());
$('#tb-split').addEventListener('click', () => $('#btn-split').click());
$('#tb-filters').addEventListener('click', () => showInspectorSection('Filtros'));
$('#tb-effects').addEventListener('click', () => showInspectorSection('Efectos'));
$('#tb-rotate').addEventListener('click', () => showInspectorSection('Girar'));
$('#tb-speed').addEventListener('click', () => showInspectorSection('Velocidad'));
$('#tb-transition').addEventListener('click', () => showInspectorSection('Transición'));
$('#tb-keyframes').addEventListener('click', () => showInspectorSection('Keyframes'));
$('#tb-animation').addEventListener('click', () => showInspectorSection('Animación'));
$('#tb-pip').addEventListener('click', () => {
  state.selection = null; renderTimeline(); renderInspector();
  showInspectorSection('PIP');
});
$('#tb-sticker').addEventListener('click', () => {
  state.selection = null; renderTimeline(); renderInspector();
  showInspectorSection('Adhesivos');
});
$('#tb-mask').addEventListener('click', () => showInspectorSection('Máscara'));
$('#tb-background').addEventListener('click', () => showInspectorSection('Fondo'));
$('#tb-crop').addEventListener('click', () => showInspectorSection('Cortar'));
$('#tb-jk').addEventListener('click', () => {
  showEditorPanel(document.querySelector('.media-panel'));
  const card = document.getElementById('jk-card');
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.classList.remove('flash'); void card.offsetWidth; card.classList.add('flash');
});
$('#tb-inspector').addEventListener('click', () => toggleEditorPanel(document.querySelector('.inspector')));

/* ================= Arranque ================= */
async function init() {
  await loadModules();
  try { await Storage.init(); } catch (e) { toast('No se pudo abrir la base de datos local: ' + errMsg(e), 'error', 9000); }
  $('#app-version').textContent = VERSION;
  const mode = (Engine && Engine.mode) || (isNativeApp() ? 'native' : 'web');
  setEngineBadge('Motor: sin cargar (' + mode + ')');
  window.__ixl = {
    version: VERSION,
    mode,
    engine: Engine,
    storage: Storage,
    opencode: OpenCode,
    app,
    buildImagePrompt,
    get ready() { return !!(Engine && Engine.ready); },
  };
  const settings = await getSettingsSafe();
  if (settings.theme === 'dark' || !settings.theme) document.documentElement.dataset.theme = 'dark';
  showScreen('projects');
  if (storageSource === 'fallback') console.warn('[ixl] Storage de reserva activo (js/storage.js no cargado).');
  if (engineSource === 'fallback') console.warn('[ixl] Engine de reserva activo (js/engine.js no cargado).');
}
init();
