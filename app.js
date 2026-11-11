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
let storageSource = 'fallback';
let engineSource = 'fallback';

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
  if (!Storage) Storage = createFallbackStorage();
  if (!Engine) Engine = createFallbackEngine();
}

/* ---------- Reserva de Storage (IndexedDB, misma API §2) ---------- */
function createFallbackStorage() {
  const DB = 'influencer-xl';
  let dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('media', { keyPath: 'id' });
        req.result.createObjectStore('projects', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }
  const tx = (store, mode, fn) => db().then(d => new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const out = fn(t.objectStore(store));
    out.onsuccess = () => res(out.result);
    out.onerror = () => rej(out.error);
  }));
  const all = store => db().then(d => new Promise((res, rej) => {
    const r = d.transaction(store, 'readonly').objectStore(store).getAll();
    r.onsuccess = () => res(r.result || []);
    r.onerror = () => rej(r.error);
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
    mode: (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.VideoEditor) ? 'native' : 'web',
    ready: false,
    async load() { throw new Error('El motor de vídeo (js/engine.js) aún no está disponible en esta compilación.'); },
    async getCapabilities() { throw new Error('El motor de vídeo (js/engine.js) aún no está disponible.'); },
    async probe(mediaId) { return probeWithElement(mediaId); },
    async trim() { throw new Error('Recortar necesita el motor de vídeo (js/engine.js), aún no disponible.'); },
    async setSpeed() { throw new Error('Cambiar la velocidad necesita el motor de vídeo (js/engine.js), aún no disponible.'); },
    async applyFilters() { throw new Error('Los filtros necesitan el motor de vídeo (js/engine.js), aún no disponible.'); },
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
async function saveProject(silent) {
  if (!state.project) return;
  state.project.updatedAt = Date.now();
  try {
    await Storage.saveProject(state.project);
    if (!silent) toast('Proyecto guardado.', 'success', 3000);
  } catch (e) { toast('No se pudo guardar el proyecto: ' + errMsg(e), 'error'); }
}
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
  return { id: uid(), name, createdAt: now, updatedAt: now, ratio, fps: 30, exportHeight: 720, clips: [], texts: [], audios: [] };
}

async function openProject(id) {
  let p = null;
  try { p = await Storage.getProject(id); } catch (e) { toast('No se pudo abrir el proyecto: ' + errMsg(e), 'error'); return; }
  if (!p) { toast('Ese proyecto ya no existe.', 'error'); renderProjects(); return; }
  state.project = p;
  state.selection = null;
  state.playhead = 0;
  state.playing = false;
  state.clipDurations.clear();
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
  // Sin probe aún: imagen 3 s, vídeo 3 s provisional hasta que el probe lo corrija.
  const d = c.kind === 'image' ? (((c.trimEnd ?? 3) - (c.trimStart || 0)) / (c.speed || 1)) : 3;
  return Math.max(0.1, d);
}
async function refreshClipDurations() {
  if (!state.project) return;
  for (const c of state.project.clips) {
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
$('#file-upload').addEventListener('change', async e => {
  const files = [...(e.target.files || [])];
  e.target.value = '';
  if (!files.length) return;
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
      toast('«' + f.name + '» subido a la galería.', 'success', 3000);
    } catch (err) { toast('No se pudo subir «' + f.name + '»: ' + errMsg(err), 'error'); }
  }
  clearURLCache();
  await renderGallery();
  if (state.screen === 'images') renderImages();
});

async function addMediaToTimeline(m) {
  if (!state.project) { toast('Abre primero un proyecto en el Editor.', 'error'); return; }
  if (m.kind === 'audio') {
    state.project.audios.push({ id: uid(), mediaId: m.id, name: m.name, trimStart: 0, trimEnd: null, volume: 1, start: state.playhead, keyframes: [] });
    toast('Audio añadido en ' + fmtTime(state.playhead) + '.', 'success', 3000);
  } else {
    const clip = {
      id: uid(), kind: m.kind, mediaId: m.id, name: m.name, trimStart: 0, trimEnd: null, speed: 1,
      filters: { brightness: 0, contrast: 1, saturation: 1 },
      chroma: null, transition: { type: 'none', duration: 0.5 }, keyframes: [], volume: 1,
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
  const total = Math.max(projectDuration(), 0.1);
  for (const it of items) {
    const el = document.createElement('div');
    el.className = 'clip ' + clsFn(it);
    el.textContent = labelFn(it);
    const dur = durFn(it);
    el.style.width = Math.max(64, Math.round((dur / total) * 100)) + '%';
    const ds = document.createElement('span'); ds.className = 'clip-dur'; ds.textContent = fmtTime(dur);
    el.appendChild(ds);
    if (state.selection && state.selection.track === track && state.selection.id === it.id) el.classList.add('selected');
    el.addEventListener('click', () => {
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
  trackItemEls('video', p.clips, c => c.kind, c => c.name || 'Clip', c => clipDuration(c));
  trackItemEls('texts', p.texts, () => 'text', t => t.text || 'Texto', t => Math.max(0.1, (t.end - t.start)));
  trackItemEls('audio', p.audios, () => 'audio', a => a.name || 'Audio', a => {
    const end = a.trimEnd ?? 3; return Math.max(0.1, end - (a.trimStart || 0));
  });
  $('#time-label').textContent = fmtTime(state.playhead) + ' / ' + fmtTime(projectDuration());
  const total = Math.max(projectDuration(), 0.1);
  const pct = Math.min(100, (state.playhead / total) * 100);
  $('#progress-fill').style.width = pct + '%';
  $('#progress-cursor').style.left = pct + '%';
  const bar = $('#progress-bar');
  bar.setAttribute('aria-valuemax', String(Math.round(total)));
  bar.setAttribute('aria-valuenow', String(Math.round(state.playhead)));
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

/* ---------- Vista previa ---------- */
let previewRaf = null;
let previewClipId = null;
async function updatePreview() {
  const p = state.project;
  const videoEl = $('#preview-video');
  const imgEl = $('#preview-image');
  const emptyEl = $('#preview-empty');
  if (!p || !p.clips.length) {
    videoEl.removeAttribute('src'); videoEl.load();
    imgEl.hidden = true; videoEl.hidden = true;
    emptyEl.style.display = 'flex';
    $('#preview-texts').innerHTML = '';
    return;
  }
  emptyEl.style.display = 'none';
  // clip activo según el cursor
  let t = state.playhead, cur = p.clips[0], start = 0;
  for (const c of p.clips) {
    const d = clipDuration(c);
    if (t < start + d || c === p.clips[p.clips.length - 1]) { cur = c; break; }
    start += d;
  }
  const offset = Math.max(0, t - start);
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
    const mediaTime = (cur.trimStart || 0) + offset * (cur.speed || 1);
    if (Math.abs(videoEl.currentTime - mediaTime) > 0.4) videoEl.currentTime = Math.min(mediaTime, (videoEl.duration || mediaTime) - 0.05);
    videoEl.playbackRate = cur.speed || 1;
    videoEl.volume = Math.min(1, cur.volume ?? 1);
    if (state.playing) videoEl.play().catch(() => {});
    else videoEl.pause();
  }
  renderPreviewTexts();
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
function tickPreview() {
  if (!state.playing || !state.project) { previewRaf = null; return; }
  const total = projectDuration();
  state.playhead += 1 / 30;
  if (state.playhead >= total) { state.playing = false; state.playhead = total; $('#btn-play-pause').textContent = '▶'; }
  renderTimeline();
  updatePreview();
  previewRaf = setTimeout(() => requestAnimationFrame(tickPreview), 1000 / 30);
}
$('#btn-play-pause').addEventListener('click', () => {
  if (!state.project || !state.project.clips.length) { toast('Añade un clip para reproducir.', 'error'); return; }
  if (state.playhead >= projectDuration()) state.playhead = 0;
  state.playing = !state.playing;
  $('#btn-play-pause').textContent = state.playing ? '⏸' : '▶';
  if (state.playing) tickPreview();
  else { if (previewRaf) clearTimeout(previewRaf); $('#preview-video').pause(); }
});
$('#progress-bar').addEventListener('click', e => {
  const rect = e.currentTarget.getBoundingClientRect();
  const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  state.playhead = frac * projectDuration();
  renderTimeline(); updatePreview();
});
$('#progress-bar').addEventListener('keydown', e => {
  if (e.key === 'ArrowLeft') state.playhead = Math.max(0, state.playhead - 1);
  if (e.key === 'ArrowRight') state.playhead = Math.min(projectDuration(), state.playhead + 1);
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { renderTimeline(); updatePreview(); }
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
    body.innerHTML = '<p class="muted">Selecciona un clip, un texto o un audio en la línea de tiempo para editarlo.</p>';
    return;
  }
  const it = sel.item;
  if (state.selection.track === 'video') return renderClipInspector(body, actions, it);
  if (state.selection.track === 'texts') return renderTextInspector(body, actions, it);
  return renderAudioInspector(body, actions, it);
}

function renderClipInspector(body, actions, c) {
  const h = document.createElement('h3'); h.textContent = 'Clip: ' + (c.name || 'sin nombre'); body.appendChild(h);
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
  if (c.chroma) mkBtn('🟢 Aplicar croma', async () => {
    if (!(await ensureEngine())) return;
    try { await Engine.chromaKey(c.mediaId, c.chroma); toast('Croma aplicado y guardado en la galería.', 'success'); clearURLCache(); renderGallery(); }
    catch (e) { toast('Croma falló: ' + errMsg(e), 'error'); }
  });
  const noStab = state.capabilities && state.capabilities.vidstab === false;
  mkBtn('🛟 Estabilizar', async () => {
    if (!(await ensureEngine())) return;
    try { await Engine.stabilize(c.mediaId); toast('Vídeo estabilizado y guardado en la galería.', 'success'); clearURLCache(); renderGallery(); }
    catch (e) {
      if (e && e.code === 'unsupported') toast('Tu motor de vídeo no incluye estabilización (vidstab).', 'error');
      else toast('Estabilizar falló: ' + errMsg(e), 'error');
    }
  }, noStab, noStab ? 'Tu motor de vídeo no incluye estabilización.' : null);
}

function renderTextInspector(body, actions, t) {
  const h = document.createElement('h3'); h.textContent = 'Texto'; body.appendChild(h);
  const textLab = document.createElement('label'); textLab.textContent = 'Texto';
  const textInp = document.createElement('input'); textInp.type = 'text'; textInp.value = t.text || '';
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

/* ---------- Exportar ---------- */
$('#btn-export').addEventListener('click', async () => {
  if (!state.project || !state.project.clips.length) { toast('Añade al menos un clip antes de exportar.', 'error'); return; }
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
    const url = URL.createObjectURL(blob);
    const dl = $('#btn-download-export');
    dl.href = url;
    dl.download = (state.project.name || 'influencer-xl').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') + '.mp4';
    dl.hidden = false;
    $('#export-status').textContent = 'Listo: ' + fmtSize(blob.size) + ' — pulsa «Descargar vídeo exportado».';
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
  const settings = await getSettingsSafe();
  if (model === 'hf' && !settings.hfToken) {
    toast('Para FLUX.1-schnell necesitas tu token gratis de Hugging Face — ponlo en Ajustes.', 'error', 8000);
    return;
  }
  if (model === 'pollinations' && Date.now() < state.pollinationsBlockedUntil) { pollinationsCountdown(); return; }
  const btn = $('#btn-generate');
  btn.disabled = true; btn.textContent = 'Generando…';
  $('#img-status').textContent = 'Generando imagen…';
  try {
    let blob;
    if (model === 'pollinations') {
      const longSide = settings.pollinationsKey ? 1024 : 768;
      const { width, height } = genSize(ratio, longSide);
      const url = 'https://image.pollinations.ai/prompt/' + encodeURIComponent(prompt) +
        '?width=' + width + '&height=' + height + '&model=flux&nologo=true&seed=' + Math.floor(Math.random() * 1e9) +
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
    } else {
      const { width, height } = genSize(ratio, 1024);
      blob = await hfImage(prompt, width, height, settings.hfToken);
    }
    const id = await Storage.saveMedia(blob, { name: prompt.slice(0, 80) + ' — ' + (model === 'hf' ? 'FLUX.1-schnell' : 'Pollinations Flux'), kind: 'image' });
    try {
      const pr = await probeWithElement(id);
      await Storage.updateMediaMeta(id, { width: pr.width || null, height: pr.height || null, duration: null });
    } catch { /* meta opcional: la imagen queda guardada igualmente */ }
    clearURLCache();
    $('#img-status').textContent = 'Imagen generada y guardada en la galería.';
    toast('Imagen generada y guardada en la galería.', 'success');
    $('#img-prompt').value = '';
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
$('#img-model').addEventListener('change', async e => {
  const settings = await getSettingsSafe();
  $('#img-model-note').textContent = e.target.value === 'hf'
    ? (settings.hfToken ? 'FLUX.1-schnell con tu token de Hugging Face. Lado largo 1024.' : 'FLUX.1-schnell necesita tu token gratis de Hugging Face — ponlo en Ajustes.')
    : 'Pollinations es gratis y sin clave. Si pide esperar, te avisaremos con una cuenta atrás de ~45 s entre imágenes.';
});

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
  $('#settings-status').textContent = '';
  $('#about-version').textContent = VERSION;
}
$('#btn-save-settings').addEventListener('click', async () => {
  try {
    const r = Storage.setSettings({
      hfToken: $('#setting-hf-token').value.trim(),
      pollinationsKey: $('#setting-pollinations-key').value.trim(),
    });
    if (r && typeof r.then === 'function') await r;
    $('#settings-status').textContent = 'Ajustes guardados en este dispositivo.';
    toast('Ajustes guardados.', 'success', 3000);
  } catch (e) { toast('No se pudieron guardar los ajustes: ' + errMsg(e), 'error'); }
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

/* ================= Arranque ================= */
async function init() {
  await loadModules();
  try { await Storage.init(); } catch (e) { toast('No se pudo abrir la base de datos local: ' + errMsg(e), 'error', 9000); }
  $('#app-version').textContent = VERSION;
  const mode = (Engine && Engine.mode) || ((window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.VideoEditor) ? 'native' : 'web');
  setEngineBadge('Motor: sin cargar (' + mode + ')');
  window.__ixl = {
    version: VERSION,
    mode,
    engine: Engine,
    storage: Storage,
    app,
    get ready() { return !!(Engine && Engine.ready); },
  };
  const settings = await getSettingsSafe();
  if (settings.theme === 'dark' || !settings.theme) document.documentElement.dataset.theme = 'dark';
  showScreen('projects');
  if (storageSource === 'fallback') console.warn('[ixl] Storage de reserva activo (js/storage.js no cargado).');
  if (engineSource === 'fallback') console.warn('[ixl] Engine de reserva activo (js/engine.js no cargado).');
}
init();
