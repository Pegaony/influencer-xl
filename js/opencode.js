// INFLUENCER XL — cliente del motor OpenCode en Datar (PC).
// API verificada en vivo el 12 Nov 2026 contra OpenCode v2.2.5 en Datar
// (sesión, shell, prompt, fs/write, fs/read — ver CONTRACT.md §15):
//  - Auth HTTP Basic, usuario 'opencode', contraseña en Ajustes (localStorage
//    'ixl.opencode', nunca en el código ni en el repo).
//  - GET /api/session -> 200 {data:[...]} (sin auth -> 401) = salud.
//  - POST /api/shell {command, cwd?, timeout?} -> 200 {data:{id, status}}.
//    La shell es PowerShell; cwd por defecto C:\Windows\system32: los
//    comandos usan rutas ABSOLUTAS. Se sondea GET /api/shell/{id} hasta que
//    status != 'running' y se lee GET /api/shell/{id}/output.
//  - POST /api/session {title} -> 200 {data:{id}} ; POST
//    /api/session/{id}/prompt {text} -> 200 (async, delivery 'steer') ; las
//    respuestas del agente llegan por GET /api/session/{id}/message.
//  - POST /api/experimental/fs/write?path=<absoluta> (octet-stream) -> 200.
//  - GET /api/fs/read/<nombre>?location[directory]=<dir> -> octet-stream.
//  - No hay subida por el endpoint de sesión: los archivos van por fs/write.
// CORS: el servidor ya permite https://pegaony.github.io y
// capacitor://localhost (orígenes de producción de la app).
// El modelo de texto es el gratis de OpenRouter ya configurado en Datar
// (nemotron-3.5-lightning:free por defecto; la sesión puede usar otro :free).
// Este módulo no toca el DOM: se puede probar desde Node con fetch.

const SETTINGS_KEY = 'ixl.opencode';
const SESSION_KEY = 'ixl.opencode.session';
const PC_WORKDIR = 'C:\\Users\\arti\\ixl-work';
const PC_DOWNLOADS = 'C:\\Users\\arti\\Downloads';
const WHISPER_SCRIPT = 'C:\\Users\\arti\\ixl-whisper.py';

// LocalStorage no existe en Node: se guarda en memoria en ese caso.
const _mem = {};
function _lsGet(k) {
  try { if (typeof localStorage !== 'undefined') return localStorage.getItem(k); } catch { /* sin storage */ }
  return _mem[k] ?? null;
}
function _lsSet(k, v) {
  try { if (typeof localStorage !== 'undefined') { localStorage.setItem(k, v); return; } } catch { /* sin storage */ }
  _mem[k] = v;
}
function _b64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function _pcName(name) {
  return String(name || 'medio').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120) || 'medio';
}

export const OpenCode = {
  PC_WORKDIR,
  PC_DOWNLOADS,
  WHISPER_SCRIPT,

  // ---- Ajustes -------------------------------------------------------
  getSettings() {
    let s = {};
    try { s = JSON.parse(_lsGet(SETTINGS_KEY) || '{}') || {}; } catch { s = {}; }
    return {
      // Por defecto el teléfono por Tailscale; en la PC es 127.0.0.1:4096.
      serverUrl: s.serverUrl || 'http://100.93.202.6:4096',
      password: s.password || '',
      whisperModel: s.whisperModel || 'tiny',
    };
  },
  saveSettings(patch) {
    const cur = this.getSettings();
    const next = { ...cur, ...patch };
    _lsSet(SETTINGS_KEY, JSON.stringify(next));
    return next;
  },
  // Para pruebas (Node): fija los ajustes en memoria sin localStorage.
  configure(patch) { return this.saveSettings(patch); },

  _base() {
    return this.getSettings().serverUrl.replace(/\/+$/, '') + '/api';
  },
  _headers(json) {
    const h = { Authorization: 'Basic ' + _b64('opencode:' + this.getSettings().password) };
    if (json) h['Content-Type'] = 'application/json';
    return h;
  },
  async _fetch(path, opts = {}) {
    const url = this._base() + path;
    const res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), ...this._headers(opts.json) } });
    return res;
  },

  // ---- Salud ---------------------------------------------------------
  // GET /api/session sin auth -> 401; con auth -> 200 {data:[...]}.
  async ping(timeoutMs = 10000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await this._fetch('/session', { signal: ctrl.signal });
      if (res.status === 401) return { ok: false, status: 401, error: 'Contraseña incorrecta o sin configurar (el servidor pide auth).' };
      if (!res.ok) return { ok: false, status: res.status, error: 'El servidor respondió HTTP ' + res.status + '.' };
      const j = await res.json();
      return { ok: true, sessions: Array.isArray(j.data) ? j.data.length : 0 };
    } catch (e) {
      if (e && e.name === 'AbortError') return { ok: false, error: 'Sin respuesta del servidor en ' + Math.round(timeoutMs / 1000) + ' s (¿la PC está encendida y OpenCode corriendo?).' };
      return { ok: false, error: 'No se pudo conectar con ' + this.getSettings().serverUrl + ' (' + (e && e.message ? e.message : e) + ').' };
    } finally { clearTimeout(t); }
  },

  // ---- Archivos (teléfono <-> PC) ------------------------------------
  // Sube un Blob a una ruta absoluta de Datar (crea las carpetas que falten).
  async uploadFile(blob, pcPath) {
    const res = await this._fetch('/experimental/fs/write?path=' + encodeURIComponent(pcPath), {
      method: 'POST', body: blob,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    if (res.status === 401) throw new Error('Auth OpenCode rechazada (401): revisa la contraseña en Ajustes.');
    if (!res.ok) throw new Error('No se pudo subir a Datar (HTTP ' + res.status + ').');
    return { ok: true, path: pcPath };
  },
  // Baja un archivo de Datar como Blob (ruta absoluta).
  async downloadFile(pcPath) {
    const norm = pcPath.replace(/\//g, '\\');
    const cut = norm.lastIndexOf('\\');
    const dir = cut >= 0 ? norm.slice(0, cut) : 'C:\\';
    const name = cut >= 0 ? norm.slice(cut + 1) : norm;
    const url = '/fs/read/' + name.split('/').map(encodeURIComponent).join('/')
      + '?location%5Bdirectory%5D=' + encodeURIComponent(dir);
    const res = await this._fetch(url);
    if (res.status === 401) throw new Error('Auth OpenCode rechazada (401): revisa la contraseña en Ajustes.');
    if (res.status === 404) throw new Error('No existe en Datar: ' + pcPath);
    if (!res.ok) throw new Error('No se pudo bajar de Datar (HTTP ' + res.status + ').');
    return await res.blob();
  },
  // Ruta de trabajo en Datar para un medio de la galería.
  pcWorkPath(mediaName) { return PC_WORKDIR + '\\' + _pcName(mediaName); },
  pcDownloadsPath(mediaName) { return PC_DOWNLOADS + '\\' + _pcName(mediaName); },

  // ---- Shell (PowerShell en Datar) -----------------------------------
  // Ejecuta un comando y espera a que termine. Devuelve {status, output}.
  // El comando corre en PowerShell: rutas con espacios entre comillas dobles.
  async runShell(command, { timeoutMs = 300000, cwd = null, onProgress = null } = {}) {
    const body = { command, timeout: timeoutMs };
    if (cwd) body.cwd = cwd;
    const res = await this._fetch('/shell', { method: 'POST', json: true, body: JSON.stringify(body) });
    if (res.status === 401) throw new Error('Auth OpenCode rechazada (401): revisa la contraseña en Ajustes.');
    if (!res.ok) throw new Error('El shell de OpenCode rechazó el comando (HTTP ' + res.status + ').');
    const j = await res.json();
    const id = j && j.data && j.data.id;
    if (!id) throw new Error('El shell no devolvió id de trabajo.');
    const t0 = Date.now();
    let lastOut = '';
    for (;;) {
      await _sleep(2000);
      if (onProgress) onProgress(Math.min(0.95, (Date.now() - t0) / timeoutMs), lastOut);
      const st = await this._fetch('/shell/' + encodeURIComponent(id));
      if (!st.ok) throw new Error('No se pudo consultar el trabajo (HTTP ' + st.status + ').');
      const sj = await st.json();
      const status = sj && sj.data && sj.data.status;
      const out = await this._fetch('/shell/' + encodeURIComponent(id) + '/output');
      if (out.ok) {
        const oj = await out.json();
        lastOut = (oj && oj.data && oj.data.output) || lastOut;
      }
      if (status && status !== 'running') {
        if (onProgress) onProgress(1, lastOut);
        return { status, output: lastOut };
      }
      if (Date.now() - t0 > timeoutMs) throw new Error('El trabajo en la PC tardó más de ' + Math.round(timeoutMs / 1000) + ' s.');
    }
  },

  // ---- Texto con el modelo gratis (agente) ---------------------------
  // Crea una sesión (o reutiliza la guardada), manda el texto y espera la
  // respuesta del asistente. Devuelve el texto de la respuesta.
  async _ensureSession() {
    const saved = _lsGet(SESSION_KEY);
    if (saved) return saved;
    const res = await this._fetch('/session', { method: 'POST', json: true, body: JSON.stringify({ title: 'INFLUENCER XL' }) });
    if (!res.ok) throw new Error('No se pudo crear la sesión en OpenCode (HTTP ' + res.status + ').');
    const j = await res.json();
    const id = j && j.data && j.data.id;
    if (!id) throw new Error('OpenCode no devolvió id de sesión.');
    _lsSet(SESSION_KEY, id);
    return id;
  },
  async ask(text, { timeoutMs = 300000, onProgress = null } = {}) {
    const sid = await this._ensureSession();
    const res = await this._fetch('/session/' + encodeURIComponent(sid) + '/prompt', {
      method: 'POST', json: true, body: JSON.stringify({ text }),
    });
    if (res.status === 401) throw new Error('Auth OpenCode rechazada (401): revisa la contraseña en Ajustes.');
    if (!res.ok) throw new Error('OpenCode no aceptó el mensaje (HTTP ' + res.status + ').');
    const sent = await res.json();
    const userMsgId = sent && sent.data && sent.data.id;
    const t0 = Date.now();
    let lastSeen = 0;
    for (;;) {
      await _sleep(3000);
      if (onProgress) onProgress(Math.min(0.95, (Date.now() - t0) / timeoutMs));
      const mr = await this._fetch('/session/' + encodeURIComponent(sid) + '/message');
      if (!mr.ok) throw new Error('No se pudieron leer los mensajes (HTTP ' + mr.status + ').');
      const mj = await mr.json();
      const list = (mj && mj.data) || [];
      // La respuesta del asistente llega después del mensaje del usuario.
      const idx = userMsgId ? list.findIndex(m => m.id === userMsgId) : -1;
      const after = idx >= 0 ? list.slice(idx + 1) : list;
      const asst = after.find(m => m.type === 'assistant' || (m.payload && m.payload.type === 'assistant'));
      if (asst) {
        const parts = asst.parts || (asst.payload && asst.payload.parts) || [];
        const text = parts.filter(p => p.type === 'text').map(p => p.text || '').join('').trim();
        if (text) {
          if (onProgress) onProgress(1, text);
          return text;
        }
        // Mensaje de asistente sin texto todavía (está pensando): seguir.
        lastSeen = Math.max(lastSeen, list.length);
      }
      if (Date.now() - t0 > timeoutMs) throw new Error('El agente tardó más de ' + Math.round(timeoutMs / 1000) + ' s en responder.');
    }
  },

  // ---- Subtítulos automáticos (Whisper en Datar) ---------------------
  // pcPath: ruta ABSOLUTA del WAV 16 kHz mono en Datar. Devuelve el JSON de
  // ixl-whisper.py: {language, duration, segments:[{start,end,text}]}.
  async whisper(pcPath, { model = null, lang = 'es', timeoutMs = 300000, onProgress = null } = {}) {
    const m = model || this.getSettings().whisperModel || 'tiny';
    const cmd = 'python "' + WHISPER_SCRIPT + '" "' + pcPath.replace(/"/g, '') + '" --model ' + m + ' --lang ' + lang;
    const { output } = await this.runShell(cmd, { timeoutMs, onProgress });
    const jsonText = this._extractJson(output);
    if (!jsonText) throw new Error('Whisper no devolvió JSON. Salida: ' + String(output).slice(-400));
    let parsed;
    try { parsed = JSON.parse(jsonText); } catch (e) { throw new Error('No se pudo leer el JSON de Whisper: ' + e.message); }
    if (!Array.isArray(parsed.segments)) throw new Error('Whisper devolvió un JSON sin segmentos.');
    return parsed;
  },
  _extractJson(output) {
    const text = String(output || '');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    return text.slice(start, end + 1);
  },

  // ---- Estabilizar con vidstab (ffmpeg 9.0.2 de Datar) ---------------
  // Dos pasadas (detect + transform). Devuelve la ruta del vídeo resultante.
  async stabilizeVidstab(pcPath, outPath, { timeoutMs = 600000, onProgress = null } = {}) {
    const trf = PC_WORKDIR + '\\vidstab-' + Date.now() + '.trf';
    const detect = 'ffmpeg -y -v error -i "' + pcPath.replace(/"/g, '') + '" -vf vidstabdetect=shakiness=5:accuracy=15:result="' + trf + '" -f null -';
    const r1 = await this.runShell(detect, { timeoutMs, onProgress: onProgress ? (p) => onProgress(p * 0.5) : null });
    if (!/vidstab/i.test(r1.output) && r1.status !== 'exited') throw new Error('La detección de vidstab no terminó bien.');
    const transform = 'ffmpeg -y -v error -i "' + pcPath.replace(/"/g, '') + '" -vf vidstabtransform=input="' + trf + '":smoothing=10 -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p -c:a copy "' + outPath.replace(/"/g, '') + '"';
    const r2 = await this.runShell(transform, { timeoutMs, onProgress: onProgress ? (p) => onProgress(0.5 + p * 0.5) : null });
    if (r2.status !== 'exited') throw new Error('La estabilización no terminó bien.');
    return { ok: true, path: outPath };
  },
};
