// INFLUENCER XL — Storage (IndexedDB + ajustes en localStorage)
// ES module. Sin dependencias externas. Apache-2.0.
//
// IndexedDB 'influencer-xl' v1, stores:
//   media    — {id, name, kind, size, mime, width, height, duration, createdAt, blob}
//   projects — {id, name, createdAt, updatedAt, ...proyecto (JSON §4 del contrato)}
// Ajustes — localStorage 'ixl.settings': {hfToken, pollinationsKey, theme}

const DB_NAME = 'influencer-xl';
const DB_VERSION = 1;
const SETTINGS_KEY = 'ixl.settings';

const DEFAULT_SETTINGS = Object.freeze({ hfToken: '', pollinationsKey: '', theme: 'dark' });

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('media')) {
        const media = db.createObjectStore('media', { keyPath: 'id' });
        media.createIndex('kind', 'kind', { unique: false });
        media.createIndex('createdAt', 'createdAt', { unique: false });
      }
      if (!db.objectStoreNames.contains('projects')) {
        const projects = db.createObjectStore('projects', { keyPath: 'id' });
        projects.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('No se pudo abrir IndexedDB'));
    req.onblocked = () => reject(new Error('IndexedDB bloqueada por otra pestaña'));
  });
  // Si la apertura falla, permitir un reintento posterior.
  _dbPromise.catch(() => { _dbPromise = null; });
  return _dbPromise;
}

function tx(storeName, mode, fn) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    let result;
    try {
      result = fn(store);
    } catch (err) {
      reject(err);
      return;
    }
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error || new Error('Error en la transacción IndexedDB'));
    t.onabort = () => reject(t.error || new Error('Transacción IndexedDB abortada'));
  }));
}

function reqAsPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Error leyendo IndexedDB'));
  });
}

function newId() {
  return (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export const Storage = {
  async init() {
    await openDB();
  },

  async saveMedia(blob, { name, kind, width = null, height = null, duration = null }) {
    if (!(blob instanceof Blob)) throw new Error('saveMedia: se esperaba un Blob');
    if (!['video', 'image', 'audio'].includes(kind)) {
      throw new Error(`saveMedia: kind no válido: ${kind}`);
    }
    const id = newId();
    const record = {
      id,
      name: name || 'sin nombre',
      kind,
      size: blob.size,
      mime: blob.type || '',
      width,
      height,
      duration,
      createdAt: Date.now(),
      blob,
    };
    await tx('media', 'readwrite', (store) => store.put(record));
    return id;
  },

  // Actualiza solo los campos de meta que se pasan (no nulos). Sirve para
  // completar width/height/duration de un medio ya guardado, tras probarlo.
  async updateMediaMeta(mediaId, patch) {
    const rec = await tx('media', 'readonly', (store) => reqAsPromise(store.get(mediaId)));
    if (!rec) throw new Error('updateMediaMeta: medio no encontrado');
    if (patch.width != null) rec.width = patch.width;
    if (patch.height != null) rec.height = patch.height;
    if (patch.duration != null) rec.duration = patch.duration;
    await tx('media', 'readwrite', (store) => store.put(rec));
  },

  async getMedia(mediaId) {
    const rec = await tx('media', 'readonly', (store) => reqAsPromise(store.get(mediaId)));
    return rec ? rec.blob : null;
  },

  async getMediaMeta(mediaId) {
    const rec = await tx('media', 'readonly', (store) => reqAsPromise(store.get(mediaId)));
    if (!rec) return null;
    const { blob, ...meta } = rec;
    return meta;
  },

  async listMedia(kind) {
    const all = await tx('media', 'readonly', (store) => reqAsPromise(store.getAll()));
    const filtered = kind ? all.filter((r) => r.kind === kind) : all;
    filtered.sort((a, b) => b.createdAt - a.createdAt);
    return filtered.map(({ blob, ...meta }) => meta);
  },

  async deleteMedia(mediaId) {
    await tx('media', 'readwrite', (store) => store.delete(mediaId));
  },

  async saveProject(project) {
    if (!project || !project.id) throw new Error('saveProject: el proyecto necesita un id');
    const now = Date.now();
    const record = {
      ...project,
      createdAt: project.createdAt || now,
      updatedAt: now,
    };
    await tx('projects', 'readwrite', (store) => store.put(record));
  },

  async getProject(id) {
    const rec = await tx('projects', 'readonly', (store) => reqAsPromise(store.get(id)));
    return rec || null;
  },

  async listProjects() {
    const all = await tx('projects', 'readonly', (store) => reqAsPromise(store.getAll()));
    all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return all;
  },

  async deleteProject(id) {
    await tx('projects', 'readwrite', (store) => store.delete(id));
  },

  getSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return { ...DEFAULT_SETTINGS };
      const parsed = JSON.parse(raw);
      return {
        hfToken: typeof parsed.hfToken === 'string' ? parsed.hfToken : '',
        pollinationsKey: typeof parsed.pollinationsKey === 'string' ? parsed.pollinationsKey : '',
        theme: parsed.theme === 'light' || parsed.theme === 'dark' ? parsed.theme : 'dark',
      };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  },

  setSettings(patch) {
    const current = this.getSettings();
    const next = { ...current, ...(patch || {}) };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  },
};

export default Storage;
