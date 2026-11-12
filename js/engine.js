// INFLUENCER XL — Engine (motor de vídeo web, ffmpeg.wasm)
// ES module. Apache-2.0.
//
// Motor web: ffmpeg.wasm single-thread (@ffmpeg/ffmpeg@0.12.15 +
// @ffmpeg/core@0.12.10). El wrapper (@ffmpeg/ffmpeg) siempre se vende
// localmente en ../vendor/ffmpeg/. El core (ffmpeg-core.js + .wasm) se
// carga vendido en modo native (APK, 100% sin conexión) y en modo web
// vendido si está presente; si no (GitHub Pages no admite archivos
// >25 MB y el .wasm pesa 32 MB), se carga desde el CDN (jsDelivr, con
// unpkg de reserva), misma versión 0.12.10. Toda la UI llama a
// Engine.* y a Storage.*; nunca a ffmpeg.wasm directamente.
//
// NOTA sobre el core: @ffmpeg/core@0.12.10 (single-thread) NO incluye el
// archivo ffmpeg-core.worker.js — ese archivo solo existe en
// @ffmpeg/core-mt (multihilo). El core single-thread nunca crea workers
// pthreads, así que load() solo necesita coreURL y wasmURL. El contrato
// mencionaba ffmpeg-core.worker.js; no existe en este paquete y no se
// inventa un archivo falso.
//
// Recetas de grafos FFmpeg: contrato §6 (validadas con ffmpeg 8.1.2 en la VM).
// Dos correcciones aplicadas aquí y en CONTRACT.md:
//   1) geq NO acepta la variable `t` (da "Undefined constant"): el tiempo
//      en geq es `T` (mayúscula). Las expresiones de opacidad para geq usan
//      `T`; el resto de filtros (rotate, volume, overlay) sí usan `t`.
//      Además el alfa es `a='alpha(X,Y)*(OP)'` (no `255*(OP)`): con 255*OP se
//      destruye el alfa de origen y el fondo transparente del PNG de texto
//      (o la zona recortada por el croma) se vuelve opaco. Ojo: la función
//      es `alpha(X,Y)`, no `a(X,Y)` (geq no conoce `a(X,Y)`).
//   2) El PNG de texto es 2x para nitidez, así que en el grafo se escala a
//      la mitad (scale=trunc(iw/2):trunc(ih/2)) y las coordenadas X/Y usan
//      el ancho/alto mostrados (la mitad del PNG).
//   3) En el clon, el corte del divisor se redondea a par
//      (trunc(iw*D/2)*2): crop redondea hacia abajo a par en yuv420p, así
//      que sin esto las dos mitades sumarían W-2 en vez de W.
//   4) rotate NO agranda el cuadro: su out_w/out_h por defecto ya son
//      iw/ih, así que la receta del contrato (sin out_w/out_h) es correcta
//      y no se añade nada.

import { Storage } from './storage.js';

const VENDOR_DIR = new URL('../vendor/ffmpeg/', import.meta.url);
const VENDOR_CORE_URL = new URL('ffmpeg-core.js', VENDOR_DIR).href;
const VENDOR_WASM_URL = new URL('ffmpeg-core.wasm', VENDOR_DIR).href;

// CDN del core single-thread @ffmpeg/core@0.12.10 (misma versión que el
// vendido). jsDelivr y unpkg envían Access-Control-Allow-Origin: *, así
// que el fetch entre orígenes funciona en hosting estático sin COOP/COEP.
const CDN_CORE_BASES = [
  'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm/',
  'https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm/',
];
const CDN_URLS = CDN_CORE_BASES.map((base) => ({
  coreURL: base + 'ffmpeg-core.js',
  wasmURL: base + 'ffmpeg-core.wasm',
}));

const FPS_DEFAULT = 30;

// Lienzo W×H (pares, para H.264) por ratio y altura de exportación — contrato §4.
const RATIO_CANVAS = {
  '9:16': { 720: [406, 720], 1080: [608, 1080] },
  '1:1': { 720: [720, 720], 1080: [1080, 1080] },
  '16:9': { 720: [1280, 720], 1080: [1920, 1080] },
  '3:4': { 720: [540, 720], 1080: [810, 1080] },
  '4:3': { 720: [960, 720], 1080: [1440, 1080] },
  '4:5': { 720: [576, 720], 1080: [864, 1080] },
  '21:9': { 720: [1680, 720], 1080: [2520, 1080] },
};

const XFADES = new Set([
  'fade', 'wipeleft', 'wiperight', 'wipeup', 'wipedown',
  'dissolve', 'circleopen', 'smoothleft', 'zoom',
]);

const IMAGE_BASE_DURATION = 3; // segundos por defecto para imágenes — contrato §4

// ---------------------------------------------------------------------------
// Utilidades de formato y expresiones
// ---------------------------------------------------------------------------

function fmt(n) {
  if (!Number.isFinite(n)) return '0';
  const s = Number(n.toFixed(6)).toString();
  return s === '-0' ? '0' : s;
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function ffColor(hex) {
  if (typeof hex === 'string') {
    const h = hex.replace(/^#/, '');
    if (/^[0-9a-fA-F]{6}$/.test(h)) return `0x${h.toLowerCase()}`;
  }
  return '0x00ff00';
}

function extFor(mime, kind) {
  const map = {
    'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm',
    'video/x-matroska': 'mkv', 'video/avi': 'avi',
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
    'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/wav': 'wav',
    'audio/ogg': 'ogg', 'audio/webm': 'webm', 'audio/x-wav': 'wav',
  };
  if (mime && map[mime]) return map[mime];
  return kind === 'video' ? 'mp4' : kind === 'image' ? 'png' : 'm4a';
}

function newId() {
  return (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function derivedName(name, suffix) {
  const base = (name || 'medio').replace(/\.[^.]+$/, '');
  return `${base}${suffix}`;
}

// atempo solo acepta 0.5–2.0: descomponer la velocidad en factores válidos.
// Ej.: 4 → 2,2; 0.25 → 0.5,0.5; 3 → 2,1.5.
function atempoChain(speed) {
  const factors = [];
  let v = speed;
  while (v > 2.000001) { factors.push(2); v /= 2; }
  while (v < 0.499999) { factors.push(0.5); v /= 0.5; }
  factors.push(v);
  return factors.map((f) => `atempo=${fmt(f)}`).join(',');
}

// ---------------------------------------------------------------------------
// Interpolación de keyframes — contrato §6.1
// Solo aritmética + min/max, sin `if`:
//   v0 + Σ (v[i+1]-v[i]) * min(max((T - t[i])/(t[i+1]-t[i]), 0), 1)
// tVar es la variable de tiempo de la expresión ('t' en casi todos los
// filtros; '(on/30)' en zoompan).
// ---------------------------------------------------------------------------

const KF_DEFAULTS = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, volume: 1 };

function interpExpr(keyframes, prop, tVar) {
  const kfs = (keyframes || [])
    .filter((k) => k && Number.isFinite(k.t))
    .sort((a, b) => a.t - b.t);
  if (!kfs.length) return null;
  const val = (k) => (Number.isFinite(k[prop]) ? k[prop] : KF_DEFAULTS[prop]);
  if (kfs.length === 1) return fmt(val(kfs[0]));
  let expr = fmt(val(kfs[0]));
  for (let i = 0; i < kfs.length - 1; i++) {
    const t0 = kfs[i].t;
    const t1 = kfs[i + 1].t;
    const dv = val(kfs[i + 1]) - val(kfs[i]);
    if (t1 <= t0 || dv === 0) continue;
    expr += `+(${fmt(dv)})*min(max((${tVar}-${fmt(t0)})/${fmt(t1 - t0)},0),1)`;
  }
  return expr;
}

// Expresión de opacidad envuelta en min/max — contrato §6.1.
function opacityExpr(keyframes, tVar) {
  const e = interpExpr(keyframes, 'opacity', tVar);
  if (e === null) return null;
  return `min(max(${e},0),1)`;
}

function opacityNeeded(keyframes) {
  const kfs = keyframes || [];
  return kfs.some((k) => k && Number.isFinite(k.opacity) && k.opacity !== 1);
}

// ---------------------------------------------------------------------------
// Estado del motor
// ---------------------------------------------------------------------------

let _ffmpeg = null;
let _ready = false;
let _loadPromise = null;
let _caps = null;
let _progressCb = null;
let _progressTotalUs = 0;
const _logs = []; // anillo de las últimas líneas del registro de FFmpeg
const _probeCache = new Map(); // mediaId -> probe (el medio es inmutable)
// Colector por llamada: _exec NO puede usar mark/slice sobre el anillo,
// porque el tope de 300 líneas recorta las salidas largas y el mark queda
// fuera de rango (salía vacío: -filters/-encoders/-i perdían líneas y
// las capacidades, el probe y el audio de la exportación fallaban).
let _currentLines = null;

function _pushLog(message) {
  const s = String(message);
  _logs.push(s);
  if (_logs.length > 300) _logs.splice(0, _logs.length - 300);
  if (_currentLines) _currentLines.push(s);
}

function _lastLogLines(n) {
  return _logs.slice(-n);
}

async function _ensureLoaded() {
  // En v1 no existe ningún plugin nativo VideoEditor: el motor wasm es el
  // motor en la web Y en el APK. El error solo salta si algún día existe
  // el plugin pero el motor nativo sigue sin implementarse.
  if (Engine.mode === 'native' && typeof window !== 'undefined' && window.Capacitor?.Plugins?.VideoEditor) {
    throw {
      code: 'unsupported',
      message: 'El motor nativo (plugin Capacitor VideoEditor) no está implementado en esta fase; usa la versión web.',
    };
  }
  if (_ready && _ffmpeg) return;
  await Engine.load();
}

async function _exec(args, { ignoreError = false, onProgress = null, totalUs = 0, restore = null } = {}) {
  await _ensureLoaded();
  const lines = [];
  _currentLines = lines;
  _progressCb = onProgress;
  _progressTotalUs = totalUs;
  try {
    const ret = await _ffmpeg.exec(args, -1);
    if (ret !== 0 && !ignoreError) {
      const tail = lines.slice(-8).join('\n') || '(sin registro)';
      // Peculiaridad del núcleo wasm (12 nov 2026): tras correr loudnorm,
      // vibrato/tremolo sobre silencio digital puede fallar con
      // "Input contains (near) NaN/+-Inf" por estado residual del heap.
      // Bisecado 12 nov: el fallo es DETERMINISTA con la misma historia de
      // sesión — getCapabilities() + varias ops de vídeo + loudnorm, y luego
      // vibrato/tremolo (efecto robot); sin getCapabilities pasa, y en una
      // instancia nueva también pasa. Por eso el reintento en caliente no
      // basta: con restore disponible se RECARGA la instancia (heap limpio,
      // MEMFS vacío) y se reescriben las entradas antes de reintentar UNA
      // vez; sin restore se mantiene el reintento en caliente. Si el
      // reintento también falla, se devuelve el error real, nunca un
      // resultado fingido.
      if (/nan/i.test(tail)) {
        if (typeof restore === 'function') {
          try {
            Engine.cancel();
            await _ensureLoaded();
            await restore();
          } catch {
            throw new Error(`FFmpeg falló (código ${ret}) y no se pudo recargar el motor para reintentar. Últimas líneas del registro:\n${tail}`);
          }
          _progressCb = onProgress;
          _progressTotalUs = totalUs;
          lines.length = 0;
          const ret2 = await _ffmpeg.exec(args, -1);
          if (ret2 === 0) return { ret: ret2, lines };
          const tail2 = lines.slice(-8).join('\n') || '(sin registro)';
          throw new Error(`FFmpeg falló (código ${ret2}) tras recargar el motor. Últimas líneas del registro:\n${tail2}`);
        }
        lines.length = 0;
        const ret2 = await _ffmpeg.exec(args, -1);
        if (ret2 === 0) return { ret: ret2, lines };
        const tail2 = lines.slice(-8).join('\n') || '(sin registro)';
        throw new Error(`FFmpeg falló (código ${ret2}). Últimas líneas del registro:\n${tail2}`);
      }
      throw new Error(`FFmpeg falló (código ${ret}). Últimas líneas del registro:\n${tail}`);
    }
    return { ret, lines };
  } finally {
    _currentLines = null;
    _progressCb = null;
    _progressTotalUs = 0;
  }
}

// Guarda el resultado de una operación y completa su meta (width/height/
// duration) probando el archivo resultante. La meta nunca debe quedar en
// null si el archivo es legible; si el probe falla, el medio queda guardado
// igualmente y la meta se completa bajo demanda en probe().
async function _saveResult(blob, opts) {
  const id = await Storage.saveMedia(blob, opts);
  try {
    const pr = await Engine.probe(id);
    await Storage.updateMediaMeta(id, {
      width: pr.width,
      height: pr.height,
      duration: opts.kind === 'image' ? null : pr.duration,
    });
  } catch { /* meta opcional */ }
  return id;
}

// ---------------------------------------------------------------------------
// MEMFS: archivos con nombres únicos, borrados tras cada operación
// ---------------------------------------------------------------------------

function _memName(ext) {
  return `${newId()}.${ext}`;
}

async function _writeInput(mediaId) {
  await _ensureLoaded();
  const blob = await Storage.getMedia(mediaId);
  const meta = await Storage.getMediaMeta(mediaId);
  if (!blob || !meta) throw new Error('Medio no encontrado en la galería');
  const name = _memName(extFor(blob.type, meta.kind));
  await _ffmpeg.writeFile(name, new Uint8Array(await blob.arrayBuffer()));
  return { name, blob, meta };
}

async function _writeBlob(name, blob) {
  await _ffmpeg.writeFile(name, new Uint8Array(await blob.arrayBuffer()));
}

async function _readOutput(name, mime) {
  const data = await _ffmpeg.readFile(name);
  return new Blob([data], { type: mime });
}

async function _rm(name) {
  if (!_ffmpeg) return;
  try { await _ffmpeg.deleteFile(name); } catch { /* ya borrado o no existe */ }
}

async function _rmAll(names) {
  for (const n of names) await _rm(n);
}

// ---------------------------------------------------------------------------
// Probe: HTML primero, ffmpeg -i como fallback — contrato §3
// ---------------------------------------------------------------------------

function _elementProbe(blob, kind) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    let done = false;
    const finish = (res) => {
      if (done) return;
      done = true;
      URL.revokeObjectURL(url);
      resolve(res);
    };
    const fail = (err) => {
      if (done) return;
      done = true;
      URL.revokeObjectURL(url);
      reject(err || new Error('No se pudo leer el medio en el navegador'));
    };
    const timer = setTimeout(() => fail(new Error('La lectura del medio agotó el tiempo (15 s)')), 15000);
    const ok = (res) => { clearTimeout(timer); finish(res); };
    const bad = (e) => { clearTimeout(timer); fail(e); };

    if (kind === 'image') {
      const img = new Image();
      img.onload = () => ok({
        duration: 0, width: img.naturalWidth, height: img.naturalHeight,
        fps: FPS_DEFAULT, hasAudio: false, codec: '',
      });
      img.onerror = () => bad(new Error('No se pudo leer la imagen'));
      img.src = url;
    } else if (kind === 'video') {
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.muted = true;
      video.onloadedmetadata = () => {
        let hasAudio = null;
        try {
          if (video.audioTracks) hasAudio = video.audioTracks.length > 0;
        } catch { hasAudio = null; }
        const duration = Number.isFinite(video.duration) ? video.duration : null;
        ok({
          duration, width: video.videoWidth || null, height: video.videoHeight || null,
          fps: FPS_DEFAULT, hasAudio, codec: '',
        });
      };
      video.onerror = () => bad(new Error('No se pudo leer el vídeo'));
      video.src = url;
    } else {
      const audio = document.createElement('audio');
      audio.preload = 'metadata';
      audio.onloadedmetadata = () => {
        const duration = Number.isFinite(audio.duration) ? audio.duration : null;
        ok({ duration, width: null, height: null, fps: FPS_DEFAULT, hasAudio: true, codec: '' });
      };
      audio.onerror = () => bad(new Error('No se pudo leer el audio'));
      audio.src = url;
    }
  });
}

function _parseFfmpegInfo(text) {
  const out = { duration: null, width: null, height: null, fps: null, hasAudio: false, codec: '' };
  const dur = text.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
  if (dur) out.duration = Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]);
  const lines = text.split('\n');
  for (const line of lines) {
    if (/Stream #/.test(line) && /Video:/.test(line)) {
      const m = line.match(/Video:\s*([a-zA-Z0-9_]+).*?(\d+)x(\d+)/);
      if (m) {
        out.codec = m[1];
        out.width = Number(m[2]);
        out.height = Number(m[3]);
      }
      const f = line.match(/([\d.]+)\s*fps/);
      if (f) out.fps = Number(f[1]);
    }
    if (/Stream #/.test(line) && /Audio:/.test(line)) out.hasAudio = true;
  }
  return out;
}

async function _ffmpegProbe(name) {
  const { lines } = await _exec(['-i', name], { ignoreError: true });
  return _parseFfmpegInfo(lines.join('\n'));
}

// ---------------------------------------------------------------------------
// Constructor de grafos por clip — contrato §6.2
// ---------------------------------------------------------------------------

function clipDuration(clip, info) {
  const mediaDur = clip.kind === 'image'
    ? IMAGE_BASE_DURATION
    : (Number.isFinite(info.duration) ? info.duration : null);
  if (mediaDur === null) throw new Error(`No se pudo determinar la duración de "${clip.name || 'clip'}"`);
  const end = clip.trimEnd ?? mediaDur;
  const d = (end - (clip.trimStart || 0)) / (clip.speed || 1);
  if (!(d > 0)) throw new Error(`Duración inválida en el clip "${clip.name || ''}": el fin debe ser mayor que el inicio`);
  return d;
}

// ---------------------------------------------------------------------------
// Receta "Cómic" (Estilo J'K) — colores planos + contornos negros.
//   Rama de color: colores planos (posterizado) + eq saturado.
//   Rama de bordes: edgedetect → negate (líneas negras sobre blanco).
//   Unión: blend multiply por planos (luma multiply, croma = la de la rama
//   de color): el blanco deja pasar el color y las líneas negras quedan
//   como contorno.
// HALLAZGOS (11 Nov 2026, verificados con fotogramas reales):
//   - `posterize` NO existe en el core wasm (@ffmpeg/core 0.12.10 = FFmpeg
//     7.0; posterize llegó en 7.1) ni en el ffmpeg del sistema. El
//     posterizado se hace con `lutyuv` (cuantiza luma y croma a pasos de 36).
//   - `blend=all_mode=multiply` a secas NO vale: multiplica también los
//     planos de croma y todo se vuelve verde.
//   - **NO usar `split` para las dos ramas**: tras `scale`, el filtro
//     edgedetect destruye el croma del fotograma compartido y el Cómic sale
//     en gris (comprobado: con split + scale la salida es gris; sin split,
//     a color). La rama de bordes lee el mismo medio de una SEGUNDA entrada
//     (`c.edgeInputIdx` en exportTimeline, `-i` duplicado en applyComic).
// Requiere: edgedetect, negate, format, lutyuv, eq, blend.
// ---------------------------------------------------------------------------

// Posterizado + saturación de la rama de color (después de la cadena base).
const COMIC_FLAT = `lutyuv=y='trunc(val/36)*36':u='128+trunc((val-128)/36)*36':v='128+trunc((val-128)/36)*36',eq=brightness=0.02:contrast=1.12:saturation=1.9`;
// Bordes del Cómic (después de la cadena geométrica de la segunda entrada).
const COMIC_EDGE = 'edgedetect=low=0.08:high=0.35,negate,format=yuv420p';
// Unión de las dos ramas: luma multiplicada, croma de la rama de color.
function comicBlend(flatLabel, edgeLabel, outLabel) {
  return `[${flatLabel}][${edgeLabel}]blend=c0_mode=multiply:c1_expr=A:c2_expr=A[${outLabel}]`;
}

// Presets de look por clip (Estilo J'K): 'none' | 'bw' (blanco y negro) |
// 'color' (color intenso) | 'comic' (receta Cómic). Viven en
// clip.filters.preset; los proyectos viejos sin preset se tratan como 'none'.

// Pack de efectos de un toque (InShot, ola 1): recetas validadas con el
// ffmpeg del sistema el 12 nov 2026 (/tmp/validate-recipes.sh, 26/26).
// Se aplican tras el look (B/N/Color/Cómic) y antes del croma/opacidad.
// `shake` recorta 20 px y mueve el encuadre con el tiempo; el scale final
// devuelve el marco a W×H (el concat exige dimensiones iguales).
const EFFECT_FILTERS = {
  vintage: () => 'curves=preset=vintage,colorbalance=rs=0.1:bs=-0.1,vignette=PI/5',
  sepia: () => 'colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131',
  blur: () => 'gblur=sigma=8',
  glitch: () => 'noise=alls=20:allf=t+u,rgbashift=rh=6:bh=-6,hue=s=1.3',
  shake: (W, H) => `crop=iw-20:ih-20:'10*sin(2*PI*t*3)':'10*cos(2*PI*t*3)',scale=${W}:${H}`,
  neon: () => 'eq=saturation=1.8:contrast=1.15,unsharp=5:5:1.0',
};
const EFFECT_LABELS = {
  none: 'Ninguno', vintage: 'Vintage', sepia: 'Sepia', blur: 'Desenfoque',
  glitch: 'Glitch', shake: 'Sacudida', neon: 'Neón',
};

// Cadena de vídeo de un clip. Devuelve {graph, vLabel, needsAlpha}: graph es
// la lista de sentencias del grafo (la primera termina en [v{i}]) y vLabel
// es la etiqueta del vídeo procesado de ese clip.
function buildClipVideoFilter(c, W, H, fps) {
  // Cadena geométrica (recorte, escala, rotación, zoompan): es COMÚN a la
  // rama de color y a la de bordes del Cómic, para que los contornos caigan
  // sobre la misma imagen. Sin el prefijo de entrada (se añade por rama).
  const geo = [];
  if (c.kind === 'image') {
    geo.push(`fps=${fps},format=yuv420p`);
  } else {
    geo.push(`trim=start=${fmt(c.trimStart)}:end=${fmt(c.trimEnd)},setpts=(PTS-STARTPTS)/${fmt(c.speed)},fps=${fps}`);
  }
  // Girar 90° + voltear (ola 1): antes del escalado, porque transpose
  // cambia las dimensiones y el cover se adapta solo.
  if (c.rotate === 90) geo.push('transpose=1');
  else if (c.rotate === 180) geo.push('hflip,vflip');
  else if (c.rotate === 270) geo.push('transpose=2');
  if (c.flipH) geo.push('hflip');
  if (c.flipV) geo.push('vflip');
  // Cortar (encuadre, ola 2): x/y/w/h en fracciones del marco original.
  if (c.crop && c.crop.w > 0 && c.crop.h > 0) {
    geo.push(`crop=iw*${fmt(c.crop.w)}:ih*${fmt(c.crop.h)}:iw*${fmt(c.crop.x || 0)}:ih*${fmt(c.crop.y || 0)}`);
  }
  // Fondo + Lona (ola 2): cover (actual) o contain con fondo negro, color
  // o desenfocado. Con fondo desenfocado el marco NO se rellena aquí: el
  // paso final compone el fondo borroso desde el propio clip.
  const containBlur = c.fit === 'contain' && c.bg === 'blur';
  if (containBlur) {
    geo.push(`scale=${W}:${H}:force_original_aspect_ratio=decrease`);
  } else if (c.fit === 'contain') {
    const padColor = c.bg === 'color' ? ffColor(c.bgColor || '#000000') : 'black';
    geo.push(`scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:${padColor}`);
  } else {
    geo.push(`scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`);
  }

  const rotExpr = interpExpr(c.keyframes, 'rotation', 't');
  if (rotExpr !== null) {
    // rotate mantiene W×H por defecto (out_w/out_h son iw/ih).
    geo.push(`rotate='(${rotExpr})*(0.0174532925)':fillcolor=black`);
  }

  const tVar = `(on/${fps})`;
  const scaleE = interpExpr(c.keyframes, 'scale', tVar);
  const xE = interpExpr(c.keyframes, 'x', tVar);
  const yE = interpExpr(c.keyframes, 'y', tVar);
  const needsZP = (scaleE !== null && scaleE !== '1')
    || (xE !== null && xE !== '0')
    || (yE !== null && yE !== '0');
  // Con fondo desenfocado no hay zoompan: re-escalaría el marco pequeño
  // a W×H y se perdería el contain (los keyframes de zoom no se aplican
  // en ese modo; la rotación sí, porque mantiene iw/ih).
  if (needsZP && !containBlur) {
    geo.push(
      `zoompan=z='${scaleE || '1'}':x='(iw-iw/zoom)/2+(${xE || '0'})':y='(ih-ih/zoom)/2+(${yE || '0'})':d=1:s=${W}x${H}:fps=${fps}`,
    );
  }
  const geoStr = geo.join(',');

  const f = c.filters || {};
  const b = f.brightness ?? 0;
  const co = f.contrast ?? 1;
  const sa = f.saturation ?? 1;
  const eqPart = (b !== 0 || co !== 1 || sa !== 1)
    ? `,eq=brightness=${fmt(b)}:contrast=${fmt(co)}:saturation=${fmt(sa)}` : '';

  const graph = [];
  let vLabel = `v${c.idx}`;
  let needsAlpha = false;

  // Preset de look (Estilo J'K): se aplica tras los sliders de eq y ANTES
  // del croma/opacidad, porque el Cómic trabaja sobre yuv420p (sin alfa).
  const preset = (f && f.preset) || 'none';
  if (preset === 'comic') {
    // Cómic con DOS entradas del mismo medio (sin split: ver nota arriba).
    // Rama de color: cadena base + posterizado; rama de bordes: misma
    // geometría desde la segunda entrada + edgedetect.
    graph.push(`[${c.inputIdx}:v]${geoStr}${eqPart}[v${c.idx}]`);
    graph.push(`[${c.edgeInputIdx}:v]${geoStr},${COMIC_EDGE}[cmE${c.idx}]`);
    graph.push(`[v${c.idx}]${COMIC_FLAT}[cmF${c.idx}]`);
    graph.push(comicBlend(`cmF${c.idx}`, `cmE${c.idx}`, `v${c.idx}c`));
    vLabel = `v${c.idx}c`;
  } else {
    graph.push(`[${c.inputIdx}:v]${geoStr}${eqPart}[v${c.idx}]`);
    if (preset === 'bw') {
      const out = `v${c.idx}bw`;
      graph.push(`[${vLabel}]hue=s=0,eq=contrast=1.08[${out}]`);
      vLabel = out;
    } else if (preset === 'color') {
      const out = `v${c.idx}col`;
      graph.push(`[${vLabel}]eq=saturation=1.55:contrast=1.08[${out}]`);
      vLabel = out;
    }
  }

  // Efectos (ola 1): un toque, tras el look y antes del croma/opacidad.
  const effectFn = (c.effect && EFFECT_FILTERS[c.effect]) || null;
  if (effectFn) {
    const out = `v${c.idx}fx`;
    graph.push(`[${vLabel}]${effectFn(W, H)}[${out}]`);
    vLabel = out;
  }

  if (c.chroma) {
    const out = `v${c.idx}ck`;
    graph.push(`[${vLabel}]chromakey=${ffColor(c.chroma.color)}:${fmt(c.chroma.similarity ?? 0.15)}:${fmt(c.chroma.blend ?? 0.1)},format=yuva420p[${out}]`);
    vLabel = out;
    needsAlpha = true;
  }
  // Opacidad (ola 3): animada por keyframes o constante por el slider.
  const constOpacity = (c.opacity ?? 1);
  const opFromKf = opacityNeeded(c.keyframes);
  if (opFromKf || constOpacity !== 1) {
    // geq usa T (mayúscula) como tiempo; `t` da "Undefined constant".
    // alpha(X,Y)*OP conserva el alfa de origen (fondo transparente del PNG
    // de texto o zona recortada por el croma); 255*OP lo destruiría y
    // volvería opaco el fondo transparente. La función es alpha(X,Y).
    const out = `v${c.idx}op`;
    const opE = opFromKf ? opacityExpr(c.keyframes, 'T') : `min(max(${fmt(constOpacity)},0),1)`;
    // geq para opacidad animada (colorchannelmixer con aa variable NO funciona).
    graph.push(`[${vLabel}]format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*(${opE})',format=yuva420p[${out}]`);
    vLabel = out;
    needsAlpha = true;
  }
  // Máscara (ola 2): forma con pluma. Fuera de la forma el píxel es
  // transparente (el segmento lo compone sobre negro). x/y/w/h son
  // fracciones del lienzo; feather es el ancho de la pluma en px.
  if (c.mask && c.mask.shape && c.mask.shape !== 'none') {
    const out = `v${c.idx}mk`;
    const m = c.mask;
    const F = Math.max(1, m.feather ?? 12);
    let alphaE;
    if (m.shape === 'circle') {
      const cx = W * ((m.x ?? 0.25) + (m.w ?? 0.5) / 2);
      const cy = H * ((m.y ?? 0.25) + (m.h ?? 0.5) / 2);
      const R = Math.min(W * (m.w ?? 0.5), H * (m.h ?? 0.5)) / 2;
      alphaE = `255*min(max((${fmt(R + F)}-hypot(X-${fmt(cx)},Y-${fmt(cy)}))/${fmt(F)},0),1)`;
    } else { // rect
      const x0 = W * (m.x ?? 0.1);
      const x1 = W * ((m.x ?? 0.1) + (m.w ?? 0.8));
      const y0 = H * (m.y ?? 0.1);
      const y1 = H * ((m.y ?? 0.1) + (m.h ?? 0.8));
      alphaE = `255*min(max((min(min(X-${fmt(x0)},${fmt(x1)}-X),min(Y-${fmt(y0)},${fmt(y1)}-Y))+${fmt(F)})/${fmt(F)},0),1)`;
    }
    graph.push(`[${vLabel}]format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${alphaE}',format=yuva420p[${out}]`);
    vLabel = out;
    needsAlpha = true;
  }
  // Fondo desenfocado (ola 2): el fondo es el propio clip borroso a cover
  // y el marco nítido centrado encima. Sale opaco (yuv420p), así que ya no
  // necesita composición sobre negro.
  if (containBlur) {
    const out = `v${c.idx}bg`;
    graph.push(
      `[${vLabel}]split[cbA${c.idx}][cbB${c.idx}];`
      + `[cbA${c.idx}]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},gblur=sigma=20[cbBg${c.idx}];`
      + `[cbB${c.idx}]scale=${W}:${H}:force_original_aspect_ratio=decrease[cbFg${c.idx}];`
      + `[cbBg${c.idx}][cbFg${c.idx}]overlay=(W-w)/2:(H-h)/2,format=yuv420p[${out}]`,
    );
    vLabel = out;
    needsAlpha = false;
  }

  return { graph, vLabel, needsAlpha };
}

// Cadena de audio de un clip. Sin audio en el medio: silencio sintetizado.
function buildClipAudioFilter(c) {
  if (!c.hasAudio) {
    return `anullsrc=channel_layout=stereo:sample_rate=48000:d=${fmt(c.D)},asetpts=PTS-STARTPTS[a${c.idx}]`;
  }
  let s = `[${c.inputIdx}:a]atrim=start=${fmt(c.trimStart)}:end=${fmt(c.trimEnd)},asetpts=PTS-STARTPTS`;
  if (c.speed !== 1) s += `,${atempoChain(c.speed)}`;
  if ((c.volume ?? 1) !== 1) s += `,volume=${fmt(c.volume)}`;
  s += `,aresample=48000,aformat=channel_layouts=stereo[a${c.idx}]`;
  return s;
}

// Cadena de un audio de la pista de audio — contrato §6.5.
function buildAudioTrackFilter(a) {
  let s = `[${a.inputIdx}:a]atrim=start=${fmt(a.trimStart)}:end=${fmt(a.trimEnd)},asetpts=PTS-STARTPTS`;
  const volE = interpExpr(a.keyframes, 'volume', 't');
  if (volE !== null) s += `,volume='${volE}':eval=frame`;
  else if ((a.volume ?? 1) !== 1) s += `,volume=${fmt(a.volume)}`;
  const delayMs = Math.round((a.start || 0) * 1000);
  s += `,aformat=channel_layouts=stereo,aresample=48000,adelay=${delayMs}|${delayMs}[au${a.idx}]`;
  return s;
}

// Encadenar segmentos con xfade/acrossfade o concat — contrato §6.3.
// segments: [{vLabel, aLabel, D, transition}] donde transition es la
// transición HACIA ese clip (la del clip 0 se ignora).
// Devuelve {graphParts, vChain, aChain|null, totalDuration}.
function chainSegments(segments, withAudio) {
  const graph = [];
  let labelN = 0;
  const nextLabel = (p) => `${p}${labelN++}`;
  const vTramos = [];
  const aTramos = [];
  let totalDuration = 0;
  let i = 0;

  while (i < segments.length) {
    let curV = segments[i].vLabel;
    let curA = withAudio ? segments[i].aLabel : null;
    let curD = segments[i].D;
    let j = i;
    while (j + 1 < segments.length) {
      const tr = segments[j + 1].transition || { type: 'none', duration: 0.5 };
      if (!XFADES.has(tr.type) || tr.type === 'none') break;
      let td = clamp(tr.duration ?? 0.5, 0, Math.min(curD, segments[j + 1].D));
      if (td <= 0.05) break; // transición inviable: se trata como corte
      const off = curD - td;
      const xv = nextLabel('xf');
      const xa = nextLabel('af');
      graph.push(`[${curV}][${segments[j + 1].vLabel}]xfade=transition=${tr.type}:duration=${fmt(td)}:offset=${fmt(off)}[${xv}]`);
      if (withAudio) {
        graph.push(`[${curA}][${segments[j + 1].aLabel}]acrossfade=d=${fmt(td)}[${xa}]`);
      }
      curV = xv;
      if (withAudio) curA = xa;
      curD = curD + segments[j + 1].D - td;
      j++;
    }
    vTramos.push(curV);
    if (withAudio) aTramos.push(curA);
    totalDuration += curD;
    i = j + 1;
  }

  let vChain;
  let aChain = null;
  if (vTramos.length === 1) {
    vChain = vTramos[0];
  } else {
    graph.push(`${vTramos.map((l) => `[${l}]`).join('')}concat=n=${vTramos.length}:v=1:a=0[vchain]`);
    vChain = 'vchain';
  }
  if (withAudio) {
    if (aTramos.length === 1) {
      aChain = aTramos[0];
    } else {
      graph.push(`${aTramos.map((l) => `[${l}]`).join('')}concat=n=${aTramos.length}:v=0:a=1[achain]`);
      aChain = 'achain';
    }
  }
  return { graph, vChain, aChain, totalDuration };
}

async function _urlExists(url) {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    return res.ok;
  } catch { return false; }
}

// Orden de intentos para cargar el core (ffmpeg-core.js + .wasm):
//  - modo native (APK): solo el vendido, para funcionar 100% sin conexión.
//  - modo web: el vendido si está presente (desarrollo local, smoke, APK
//    webview); si no, el CDN (GitHub Pages no puede alojar el .wasm de
//    32 MB). Si el vendido está presente pero su carga falla, el CDN es
//    el reserva; si el CDN principal falla, el segundo CDN.
async function _coreUrlAttempts() {
  const vendored = { coreURL: VENDOR_CORE_URL, wasmURL: VENDOR_WASM_URL };
  if (Engine.mode === 'native') return [vendored];
  if (await _urlExists(VENDOR_WASM_URL)) return [vendored, ...CDN_URLS];
  return CDN_URLS;
}

// Procesa el audio de un medio (vídeo: copia el vídeo; audio: solo audio)
// con una cadena de filtros de audio y guarda el resultado en la galería.
async function _audioOp(mediaId, af, suffix, onProgress, opts = {}) {
  const { name, blob, meta } = await _writeInput(mediaId);
  const info = await Engine.probe(mediaId);
  const files = [name];
  try {
    if (meta.kind === 'audio') {
      const outName = _memName('m4a');
      files.push(outName);
      await _exec(['-i', name, '-af', af, '-c:a', 'aac', '-b:a', '128k', outName], { onProgress, restore: () => _writeBlob(name, blob) });
      const out = await _readOutput(outName, 'audio/mp4');
      return await _saveResult(out, { name: derivedName(meta.name, suffix), kind: 'audio' });
    }
    if (meta.kind !== 'video' || !info.hasAudio) throw new Error('Este medio no tiene audio');
    const outName = _memName('mp4');
    files.push(outName);
    // -t explícito cuando se conoce la duración final: el núcleo wasm no
    // respeta -shortest con -c:v copy (la voz aguda salía con 6 s en vez de ~4 s).
    const args = ['-i', name, '-af', af, '-map', '0:v', '-map', '0:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k'];
    if (opts.maxDuration) args.push('-t', String(opts.maxDuration));
    args.push('-shortest', '-movflags', '+faststart', outName);
    await _exec(args, { onProgress, restore: () => _writeBlob(name, blob) });
    const out = await _readOutput(outName, 'video/mp4');
    return await _saveResult(out, { name: derivedName(meta.name, suffix), kind: 'video' });
  } finally {
    await _rmAll(files);
  }
}

// Aplica un filtro de vídeo a un medio (imagen: PNG; vídeo: MP4 con el
// audio copiado) y guarda el resultado en la galería.
async function _videoFilterOp(mediaId, vf, suffix, onProgress) {
  const { name, blob, meta } = await _writeInput(mediaId);
  const files = [name];
  try {
    if (meta.kind === 'audio') throw new Error('Los filtros de vídeo no se aplican a un audio');
    if (meta.kind === 'image') {
      const outName = _memName('png');
      files.push(outName);
      await _exec(['-i', name, '-vf', vf, '-frames:v', '1', outName], { onProgress, restore: () => _writeBlob(name, blob) });
      const out = await _readOutput(outName, 'image/png');
      return await _saveResult(out, { name: derivedName(meta.name, suffix), kind: 'image' });
    }
    const info = await Engine.probe(mediaId);
    const outName = _memName('mp4');
    files.push(outName);
    const args = ['-i', name, '-filter_complex', `[0:v]${vf}[v]`, '-map', '[v]'];
    if (info.hasAudio) args.push('-map', '0:a?', '-c:a', 'copy');
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
      '-r', '30', '-movflags', '+faststart', outName);
    await _exec(args, { onProgress, restore: () => _writeBlob(name, blob) });
    const out = await _readOutput(outName, 'video/mp4');
    return await _saveResult(out, { name: derivedName(meta.name, suffix), kind: 'video' });
  } finally {
    await _rmAll(files);
  }
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export const Engine = {
  get mode() {
    // Capacitor inyecta window.Capacitor con isNativePlatform() en el
    // WebView del APK. En el navegador no existe y el modo es 'web'.
    try {
      return (typeof window !== 'undefined' && window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform())
        ? 'native'
        : 'web';
    } catch { return 'web'; }
  },

  get ready() {
    return _ready;
  },

  async load(onProgress) {
    if (_ready && _ffmpeg) return;
    if (_loadPromise) return _loadPromise;
    _loadPromise = (async () => {
      try {
        if (typeof onProgress === 'function') onProgress(0.05);
        const { FFmpeg } = await import('../vendor/ffmpeg/index.js');
        if (typeof onProgress === 'function') onProgress(0.4);
        // El core single-thread no necesita workerURL (no existe ese archivo).
        // Se prueba cada fuente en orden con una instancia nueva; la primera
        // que carga gana y queda como motor activo.
        const attempts = await _coreUrlAttempts();
        let lastErr = null;
        for (const urls of attempts) {
          const inst = new FFmpeg();
          inst.on('log', ({ message }) => _pushLog(message));
          inst.on('progress', ({ progress, time }) => {
            if (!_progressCb) return;
            if (_progressTotalUs > 0 && Number.isFinite(time)) {
              _progressCb(clamp(time / _progressTotalUs, 0, 1));
            } else if (Number.isFinite(progress)) {
              _progressCb(clamp(progress, 0, 1));
            }
          });
          try {
            await inst.load(urls);
            _ffmpeg = inst;
            _ready = true;
            if (typeof onProgress === 'function') onProgress(1);
            return;
          } catch (err) {
            lastErr = err;
            try { inst.terminate(); } catch { /* ya terminado */ }
          }
        }
        throw lastErr || new Error('sin fuentes de core disponibles');
      } catch (err) {
        _ffmpeg = null;
        _ready = false;
        throw new Error(
          'No se pudo cargar el motor de vídeo (ffmpeg.wasm). Revisa tu conexión y vuelve a intentarlo. '
          + `Detalle: ${err && err.message ? err.message : err}`,
        );
      }
    })();
    try {
      await _loadPromise;
    } finally {
      _loadPromise = null;
    }
  },

  cancel() {
    if (_ffmpeg) {
      try { _ffmpeg.terminate(); } catch { /* ya terminado */ }
    }
    _ffmpeg = null;
    _ready = false;
    _loadPromise = null;
    _progressCb = null;
    _progressTotalUs = 0;
  },

  async getCapabilities() {
    if (_caps) return { ..._caps };
    await _ensureLoaded();
    const { lines: filterLines } = await _exec(['-hide_banner', '-filters'], { ignoreError: true });
    const { lines: encLines } = await _exec(['-hide_banner', '-encoders'], { ignoreError: true });
    const filterNames = new Set();
    for (const line of filterLines) {
      const m = line.match(/^\s*\S+\s+([A-Za-z0-9_]+)\s/);
      if (m) filterNames.add(m[1]);
    }
    const encNames = new Set();
    for (const line of encLines) {
      const m = line.match(/^\s*\S{6}\s+(\S+)\s/);
      if (m) encNames.add(m[1]);
    }
    const hasVidstab = filterNames.has('vidstabdetect') && filterNames.has('vidstabtransform');
    _caps = {
      xfade: filterNames.has('xfade'),
      chromakey: filterNames.has('chromakey'),
      vidstab: hasVidstab,
      overlay: filterNames.has('overlay'),
      zoompan: filterNames.has('zoompan'),
      rotate: filterNames.has('rotate'),
      geq: filterNames.has('geq'),
      libx264: encNames.has('libx264'),
      aac: encNames.has('aac'),
      // Filtros de la receta Cómic (Estilo J'K). `posterize` NO existe en
      // este core (llegó en FFmpeg 7.1); la receta usa `lutyuv` en su lugar.
      edgedetect: filterNames.has('edgedetect'),
      posterize: filterNames.has('posterize'),
      negate: filterNames.has('negate'),
      blend: filterNames.has('blend'),
      hue: filterNames.has('hue'),
      unsharp: filterNames.has('unsharp'),
      lutyuv: filterNames.has('lutyuv'),
      split: filterNames.has('split'),
      // Filtros de InShot (oleadas 1-3, 12 nov 2026).
      deshake: filterNames.has('deshake'),
      reverse: filterNames.has('reverse'),
      areverse: filterNames.has('areverse'),
      silencedetect: filterNames.has('silencedetect'),
      loudnorm: filterNames.has('loudnorm'),
      afftdn: filterNames.has('afftdn'),
      hqdn3d: filterNames.has('hqdn3d'),
      transpose: filterNames.has('transpose'),
      hflip: filterNames.has('hflip'),
      vflip: filterNames.has('vflip'),
      gblur: filterNames.has('gblur'),
      colorchannelmixer: filterNames.has('colorchannelmixer'),
      rgbashift: filterNames.has('rgbashift'),
      noise: filterNames.has('noise'),
      vibrato: filterNames.has('vibrato'),
      tremolo: filterNames.has('tremolo'),
      aecho: filterNames.has('aecho'),
      asetrate: filterNames.has('asetrate'),
    };
    // La receta Cómic es viable solo si están todos sus filtros.
    // (No necesita `split`: las dos ramas leen de entradas separadas.)
    _caps.comic = _caps.edgedetect && _caps.negate && _caps.blend
      && _caps.lutyuv && filterNames.has('eq');
    return { ..._caps };
  },

  async probe(mediaId) {
    if (_probeCache.has(mediaId)) return { ..._probeCache.get(mediaId) };
    const blob = await Storage.getMedia(mediaId);
    const meta = await Storage.getMediaMeta(mediaId);
    if (!blob || !meta) throw new Error('Medio no encontrado en la galería');
    const out = {
      duration: null, width: null, height: null, fps: FPS_DEFAULT,
      hasAudio: meta.kind === 'video' ? null : false,
      codec: (blob.type || '').split('/')[1] || '', size: blob.size,
    };
    try {
      const html = await _elementProbe(blob, meta.kind);
      if (html.duration !== null && html.duration !== undefined) out.duration = html.duration;
      if (html.width) out.width = html.width;
      if (html.height) out.height = html.height;
      if (html.hasAudio !== null && html.hasAudio !== undefined) out.hasAudio = html.hasAudio;
    } catch {
      // El fallback ffmpeg lo cubre abajo.
    }
    const needFfmpeg = out.width === null
      || out.duration === null
      || (meta.kind === 'video' && out.hasAudio === null)
      || (meta.kind === 'video' && out.duration === 0);
    if (needFfmpeg) {
      await _ensureLoaded();
      const name = _memName(extFor(blob.type, meta.kind));
      try {
        await _writeBlob(name, blob);
        const info = await _ffmpegProbe(name);
        if (out.duration === null || out.duration === 0) {
          if (info.duration !== null) out.duration = info.duration;
        }
        if (out.width === null && info.width) out.width = info.width;
        if (out.height === null && info.height) out.height = info.height;
        if (info.fps) out.fps = info.fps;
        if (meta.kind === 'video') out.hasAudio = info.hasAudio;
        if (info.codec) out.codec = info.codec;
      } finally {
        await _rm(name);
      }
    }
    if (meta.kind === 'image' && out.duration === null) out.duration = 0;
    if (out.hasAudio === null) out.hasAudio = false;
    _probeCache.set(mediaId, { ...out });
    return { ...out };
  },

  // --- Operaciones rápidas: el resultado se guarda en la galería -----------

  async trim(mediaId, startSec, endSec, onProgress) {
    const { name, blob, meta } = await _writeInput(mediaId);
    const info = await this.probe(mediaId);
    const files = [name];
    try {
      const S = Math.max(0, startSec || 0);
      const full = meta.kind === 'image' ? IMAGE_BASE_DURATION : info.duration;
      const E = endSec ?? full;
      if (!(E > S)) throw new Error('Recorte inválido: el fin debe ser mayor que el inicio');
      if (meta.kind === 'audio') {
        const outName = _memName('m4a');
        files.push(outName);
        await _exec(['-i', name,
          '-af', `atrim=start=${fmt(S)}:end=${fmt(E)},asetpts=PTS-STARTPTS`,
          '-c:a', 'aac', '-b:a', '128k', outName], { onProgress });
        const out = await _readOutput(outName, 'audio/mp4');
        return await _saveResult(out, { name: derivedName(meta.name, ' - recorte'), kind: 'audio' });
      }
      if (meta.kind === 'image') {
        const outName = _memName('mp4');
        files.push(outName);
        const W = info.width - (info.width % 2);
        const H = info.height - (info.height % 2);
        await _exec(['-loop', '1', '-t', fmt(E - S), '-i', name,
          '-vf', `fps=30,format=yuv420p,scale=${W}:${H}`,
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
          '-r', '30', outName], { onProgress });
        const out = await _readOutput(outName, 'video/mp4');
        return await _saveResult(out, { name: derivedName(meta.name, ' - recorte'), kind: 'video' });
      }
      const outName = _memName('mp4');
      files.push(outName);
      const graph = info.hasAudio
        ? `[0:v]trim=start=${fmt(S)}:end=${fmt(E)},setpts=PTS-STARTPTS,fps=30[v];[0:a]atrim=start=${fmt(S)}:end=${fmt(E)},asetpts=PTS-STARTPTS[a]`
        : `[0:v]trim=start=${fmt(S)}:end=${fmt(E)},setpts=PTS-STARTPTS,fps=30[v]`;
      const args = ['-i', name, '-filter_complex', graph, '-map', '[v]'];
      if (info.hasAudio) args.push('-map', '[a]', '-c:a', 'aac', '-b:a', '128k');
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
        '-r', '30', '-movflags', '+faststart', outName);
      await _exec(args, { onProgress });
      const out = await _readOutput(outName, 'video/mp4');
      return await _saveResult(out, { name: derivedName(meta.name, ' - recorte'), kind: 'video' });
    } finally {
      await _rmAll(files);
    }
  },

  async setSpeed(mediaId, speed, onProgress) {
    if (!(speed >= 0.25 && speed <= 4)) throw new Error('La velocidad debe estar entre 0.25 y 4');
    const { name, blob, meta } = await _writeInput(mediaId);
    const info = await this.probe(mediaId);
    const files = [name];
    try {
      if (meta.kind === 'audio') {
        const outName = _memName('m4a');
        files.push(outName);
        await _exec(['-i', name, '-af', `${atempoChain(speed)},aresample=48000`,
          '-c:a', 'aac', '-b:a', '128k', outName], { onProgress });
        const out = await _readOutput(outName, 'audio/mp4');
        return await _saveResult(out, { name: derivedName(meta.name, ` - velocidad x${speed}`), kind: 'audio' });
      }
      const outName = _memName('mp4');
      files.push(outName);
      if (meta.kind === 'image') {
        const W = info.width - (info.width % 2);
        const H = info.height - (info.height % 2);
        await _exec(['-loop', '1', '-t', fmt(IMAGE_BASE_DURATION / speed), '-i', name,
          '-vf', `fps=30,format=yuv420p,scale=${W}:${H}`,
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
          '-r', '30', outName], { onProgress });
      } else {
        const graph = info.hasAudio
          ? `[0:v]setpts=PTS/${fmt(speed)},fps=30[v];[0:a]${atempoChain(speed)},aresample=48000[a]`
          : `[0:v]setpts=PTS/${fmt(speed)},fps=30[v]`;
        const args = ['-i', name, '-filter_complex', graph, '-map', '[v]'];
        if (info.hasAudio) args.push('-map', '[a]', '-c:a', 'aac', '-b:a', '128k');
        args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
          '-r', '30', '-movflags', '+faststart', outName);
        await _exec(args, { onProgress });
      }
      const out = await _readOutput(outName, 'video/mp4');
      return await _saveResult(out, { name: derivedName(meta.name, ` - velocidad x${speed}`), kind: 'video' });
    } finally {
      await _rmAll(files);
    }
  },

  async applyFilters(mediaId, { brightness = 0, contrast = 1, saturation = 1 } = {}, onProgress) {
    const { name, blob, meta } = await _writeInput(mediaId);
    const files = [name];
    try {
      if (meta.kind === 'audio') throw new Error('Los filtros de imagen no se aplican a un audio');
      const eq = `eq=brightness=${fmt(brightness)}:contrast=${fmt(contrast)}:saturation=${fmt(saturation)}`;
      if (meta.kind === 'image') {
        const outName = _memName('png');
        files.push(outName);
        await _exec(['-i', name, '-vf', eq, '-frames:v', '1', outName], { onProgress });
        const out = await _readOutput(outName, 'image/png');
        return await _saveResult(out, { name: derivedName(meta.name, ' - filtros'), kind: 'image' });
      }
      const info = await this.probe(mediaId);
      const outName = _memName('mp4');
      files.push(outName);
      const args = ['-i', name, '-filter_complex', `[0:v]${eq}[v]`, '-map', '[v]'];
      if (info.hasAudio) args.push('-map', '0:a?', '-c:a', 'copy');
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
        '-r', '30', '-movflags', '+faststart', outName);
      await _exec(args, { onProgress });
      const out = await _readOutput(outName, 'video/mp4');
      return await _saveResult(out, { name: derivedName(meta.name, ' - filtros'), kind: 'video' });
    } finally {
      await _rmAll(files);
    }
  },

  // Cómic (Estilo J'K): aplica la receta Cómic a un medio y guarda el
  // resultado en la galería. El medio entra DOS veces (-i duplicado): la
  // rama de color lee de [0:v] y la de bordes de [1:v]. Con `split` el
  // Cómic saldría en gris (ver nota en la receta). Si el core no trae los
  // filtros, lanza {code:'unsupported'} en vez de fingir.
  async applyComic(mediaId, onProgress) {
    const caps = await this.getCapabilities();
    if (!caps.comic) {
      throw {
        code: 'unsupported',
        message: 'Tu motor de vídeo no incluye los filtros del Cómic (edgedetect/blend/lutyuv).',
      };
    }
    const { name, blob, meta } = await _writeInput(mediaId);
    const files = [name];
    try {
      if (meta.kind === 'audio') throw new Error('El Cómic no se aplica a un audio');
      const graph = `[0:v]${COMIC_FLAT}[cmFq];[1:v]${COMIC_EDGE}[cmEq];${comicBlend('cmFq', 'cmEq', 'v')}`;
      if (meta.kind === 'image') {
        const outName = _memName('png');
        files.push(outName);
        await _exec(['-i', name, '-i', name, '-filter_complex', graph, '-map', '[v]', '-frames:v', '1', outName], { onProgress });
        const out = await _readOutput(outName, 'image/png');
        return await _saveResult(out, { name: derivedName(meta.name, ' - cómic'), kind: 'image' });
      }
      const info = await this.probe(mediaId);
      const outName = _memName('mp4');
      files.push(outName);
      const args = ['-i', name, '-i', name, '-filter_complex', graph, '-map', '[v]'];
      if (info.hasAudio) args.push('-map', '0:a?', '-c:a', 'copy');
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
        '-r', '30', '-movflags', '+faststart', outName);
      await _exec(args, { onProgress });
      const out = await _readOutput(outName, 'video/mp4');
      return await _saveResult(out, { name: derivedName(meta.name, ' - cómic'), kind: 'video' });
    } finally {
      await _rmAll(files);
    }
  },

  async chromaKey(mediaId, { color = '#00ff00', similarity = 0.15, blend = 0.1 } = {}, onProgress) {
    const { name, blob, meta } = await _writeInput(mediaId);
    const info = await this.probe(mediaId);
    const files = [name];
    try {
      if (meta.kind === 'audio') throw new Error('El croma no se aplica a un audio');
      const ck = `chromakey=${ffColor(color)}:${fmt(similarity)}:${fmt(blend)}`;
      if (meta.kind === 'image') {
        const outName = _memName('png');
        files.push(outName);
        await _exec(['-i', name, '-vf', `${ck},format=yuva420p`, '-frames:v', '1', outName], { onProgress });
        const out = await _readOutput(outName, 'image/png');
        return await _saveResult(out, { name: derivedName(meta.name, ' - croma'), kind: 'image' });
      }
      const W = info.width;
      const H = info.height;
      const D = info.duration;
      const outName = _memName('mp4');
      files.push(outName);
      const graph = `[0:v]${ck},format=yuva420p[ck];`
        + `color=c=black:s=${W}x${H}:r=30:d=${fmt(D)}[bg];`
        + `[bg][ck]overlay=0:0:shortest=1[vout]`;
      const args = ['-i', name, '-filter_complex', graph, '-map', '[vout]'];
      if (info.hasAudio) args.push('-map', '0:a?', '-c:a', 'copy');
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
        '-r', '30', '-movflags', '+faststart', outName);
      await _exec(args, { onProgress });
      const out = await _readOutput(outName, 'video/mp4');
      return await _saveResult(out, { name: derivedName(meta.name, ' - croma'), kind: 'video' });
    } finally {
      await _rmAll(files);
    }
  },

  async applyTransition(mediaIdA, mediaIdB, { type = 'fade', duration = 0.5 } = {}, onProgress) {
    if (type !== 'none' && !XFADES.has(type)) throw new Error(`Transición no válida: ${type}`);
    const inA = await _writeInput(mediaIdA);
    const inB = await _writeInput(mediaIdB);
    const infoA = await this.probe(mediaIdA);
    const infoB = await this.probe(mediaIdB);
    const files = [inA.name, inB.name];
    try {
      const W = infoA.width;
      const H = infoA.height;
      if (!W || !H) throw new Error('No se pudo determinar el tamaño del primer clip');
      const dA = inA.meta.kind === 'image' ? IMAGE_BASE_DURATION : infoA.duration;
      const dB = inB.meta.kind === 'image' ? IMAGE_BASE_DURATION : infoB.duration;
      const outName = _memName('mp4');
      files.push(outName);

      const videoChain = (inputIdx, kind, D) => (kind === 'image'
        ? `[${inputIdx}:v]fps=30,format=yuv420p,scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`
        : `[${inputIdx}:v]trim=start=0:end=${fmt(D)},setpts=PTS-STARTPTS,fps=30,scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`);
      const audioChain = (inputIdx, kind, hasAudio, D, tag) => (hasAudio
        ? `[${inputIdx}:a]atrim=start=0:end=${fmt(D)},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo[${tag}]`
        : `anullsrc=channel_layout=stereo:sample_rate=48000:d=${fmt(D)},asetpts=PTS-STARTPTS[${tag}]`);

      let graph;
      const hasAudioOut = infoA.hasAudio || infoB.hasAudio;
      const audioPart = (tagA, tagB, joiner) => (hasAudioOut
        ? `${audioChain(0, inA.meta.kind, infoA.hasAudio, dA, tagA)};`
          + `${audioChain(1, inB.meta.kind, infoB.hasAudio, dB, tagB)};`
          + `${joiner}`
        : '');
      if (type === 'none') {
        graph = `${videoChain(0, inA.meta.kind, dA)}[va];`
          + `${videoChain(1, inB.meta.kind, dB)}[vb];`
          + audioPart('aa', 'ab', '[aa][ab]concat=n=2:v=0:a=1[aout];')
          + `[va][vb]concat=n=2:v=1:a=0[vout]`;
      } else {
        const d = clamp(duration, 0, Math.min(dA, dB));
        if (d <= 0.05) throw new Error('La transición es más larga que los clips');
        const off = dA - d;
        graph = `${videoChain(0, inA.meta.kind, dA)}[va];`
          + `${videoChain(1, inB.meta.kind, dB)}[vb];`
          + audioPart('aa', 'ab', `[aa][ab]acrossfade=d=${fmt(d)}[aout];`)
          + `[va][vb]xfade=transition=${type}:duration=${fmt(d)}:offset=${fmt(off)}[vout]`;
      }

      const args = [];
      args.push(...(inA.meta.kind === 'image' ? ['-loop', '1', '-t', fmt(dA)] : []), '-i', inA.name);
      args.push(...(inB.meta.kind === 'image' ? ['-loop', '1', '-t', fmt(dB)] : []), '-i', inB.name);
      args.push('-filter_complex', graph, '-map', '[vout]');
      if (hasAudioOut) args.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '128k');
      else args.push('-an');
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
        '-r', '30', '-movflags', '+faststart', outName);
      await _exec(args, { onProgress });
      const out = await _readOutput(outName, 'video/mp4');
      return await _saveResult(out, {
        name: derivedName(inA.meta.name, ` - transición ${type}`), kind: 'video',
      });
    } finally {
      await _rmAll(files);
    }
  },

  async stabilize(mediaId, onProgress) {
    const caps = await this.getCapabilities();
    if (!caps.vidstab) {
      throw {
        code: 'unsupported',
        message: 'Tu motor de vídeo no incluye estabilización (falta vidstab).',
      };
    }
    const { name, blob, meta } = await _writeInput(mediaId);
    if (meta.kind !== 'video') throw new Error('La estabilización solo se aplica a vídeos');
    const info = await this.probe(mediaId);
    const trf = _memName('trf');
    const outName = _memName('mp4');
    const files = [name, trf, outName];
    try {
      await _exec(['-i', name, '-vf',
        `vidstabdetect=shakiness=5:accuracy=15:result=${trf}`,
        '-f', 'null', '-'], { onProgress: onProgress ? (p) => onProgress(p * 0.5) : null });
      const args = ['-i', name, '-vf',
        `vidstabtransform=input=${trf}:smoothing=10`,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p'];
      if (info.hasAudio) args.push('-c:a', 'aac', '-b:a', '128k');
      else args.push('-an');
      args.push('-r', '30', '-movflags', '+faststart', outName);
      await _exec(args, { onProgress: onProgress ? (p) => onProgress(0.5 + p * 0.5) : null });
      const out = await _readOutput(outName, 'video/mp4');
      return await _saveResult(out, { name: derivedName(meta.name, ' - estabilizado'), kind: 'video' });
    } finally {
      await _rmAll(files);
    }
  },

  // --- InShot, oleadas 1-3 (12 nov 2026) ---------------------------------
  // Todas crean un medio NUEVO en la galería (el original no se toca) y
  // completan su meta con _saveResult (contrato §11).

  // Capturar: extrae el fotograma del segundo t como PNG a la galería.
  // La congelación usa este mismo fotograma y lo inserta como clip de
  // imagen de 2 s. N = número de fotograma a 30 fps.
  async captureFrame(mediaId, timeSec, onProgress) {
    const { name, blob, meta } = await _writeInput(mediaId);
    if (meta.kind !== 'video') throw new Error('Capturar solo funciona con vídeos');
    const files = [name];
    try {
      const N = Math.max(0, Math.round((timeSec || 0) * 30));
      const outName = _memName('png');
      files.push(outName);
      await _exec(['-i', name, '-vf', `select='eq(n\\,${N})'`, '-frames:v', '1', outName], { onProgress });
      const out = await _readOutput(outName, 'image/png');
      return await _saveResult(out, { name: derivedName(meta.name, ` - fotograma ${fmt(timeSec || 0)}s`), kind: 'image' });
    } finally {
      await _rmAll(files);
    }
  },

  // Extrae el audio de un medio como WAV 16 kHz mono (lo que pide Whisper).
  // Lo guarda en la galería como audio y devuelve su id; la app lo sube a
  // Datar con OpenCode.uploadFile para transcribirlo con faster-whisper.
  async extractAudioWav(mediaId, onProgress) {
    const { name, blob, meta } = await _writeInput(mediaId);
    const info = await this.probe(mediaId);
    const files = [name];
    try {
      if (!info.hasAudio) throw new Error('Este medio no tiene audio');
      const outName = _memName('wav');
      files.push(outName);
      await _exec(['-i', name, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', outName], { onProgress });
      const out = await _readOutput(outName, 'audio/wav');
      return await _saveResult(out, { name: derivedName(meta.name, ' - audio 16kHz'), kind: 'audio' });
    } finally {
      await _rmAll(files);
    }
  },

  // Inverso: el clip al revés (vídeo + audio). En wasm re-codifica todo:
  // en clips largos tarda; la app avisa si pasa de ~30 s.
  async reverseClip(mediaId, onProgress) {
    const { name, blob, meta } = await _writeInput(mediaId);
    if (meta.kind !== 'video') throw new Error('El inverso solo se aplica a vídeos');
    const info = await this.probe(mediaId);
    const files = [name];
    try {
      const outName = _memName('mp4');
      files.push(outName);
      const args = ['-i', name, '-vf', 'reverse'];
      if (info.hasAudio) args.push('-af', 'areverse', '-map', '0:v', '-map', '0:a', '-c:a', 'aac', '-b:a', '128k');
      else args.push('-an');
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
        '-r', '30', '-movflags', '+faststart', outName);
      await _exec(args, { onProgress });
      const out = await _readOutput(outName, 'video/mp4');
      return await _saveResult(out, { name: derivedName(meta.name, ' - inverso'), kind: 'video' });
    } finally {
      await _rmAll(files);
    }
  },

  // Estabilizar (básico): deshake de una pasada. NO es vidstab (ausente
  // en este core): calidad inferior y recorta un poco los bordes. La vía
  // vidstab queda para el futuro motor nativo (stabilize()).
  async stabilizeDeshake(mediaId, onProgress) {
    const caps = await this.getCapabilities();
    if (!caps.deshake) {
      throw { code: 'unsupported', message: 'Tu motor de vídeo no incluye deshake.' };
    }
    const { name, blob, meta } = await _writeInput(mediaId);
    if (meta.kind !== 'video') throw new Error('La estabilización solo se aplica a vídeos');
    const info = await this.probe(mediaId);
    const files = [name];
    try {
      const outName = _memName('mp4');
      files.push(outName);
      const args = ['-i', name, '-vf', 'deshake', '-map', '0:v'];
      if (info.hasAudio) args.push('-map', '0:a', '-c:a', 'copy');
      else args.push('-an');
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
        '-r', '30', '-movflags', '+faststart', outName);
      await _exec(args, { onProgress });
      const out = await _readOutput(outName, 'video/mp4');
      return await _saveResult(out, { name: derivedName(meta.name, ' - estabilizado (básico)'), kind: 'video' });
    } finally {
      await _rmAll(files);
    }
  },

  // Mejorar voz (aproximación honesta, ola 3): limpieza + nivel, no IA.
  async enhanceVoice(mediaId, onProgress) {
    return _audioOp(mediaId, 'highpass=f=80,afftdn=nr=12,loudnorm=I=-16:TP=-1.5:LRA=11', ' - voz mejorada', onProgress);
  },

  // Efecto de voz (ola 3): presets con asetrate/vibrato/aecho. El cambio
  // de tono con asetrate cambia también la duración (no hay rubberband
  // en este core); la app lo dice al aplicarlo.
  async voiceEffect(mediaId, preset, onProgress) {
    const AF = {
      high: 'asetrate=48000*1.5,aresample=48000',
      low: 'asetrate=48000*0.75,aresample=48000',
      robot: 'vibrato=f=8:d=0.5,tremolo=f=8:d=0.5',
      echo: 'aecho=0.8:0.7:60:0.5',
    }[preset];
    if (!AF) throw new Error(`Efecto de voz no válido: ${preset}`);
    const LABEL = { high: 'aguda', low: 'grave', robot: 'robot', echo: 'eco' }[preset];
    // La voz aguda/grave cambia la duración del audio (×1.5 / ×0.75): se
    // corta la salida a esa duración (el núcleo wasm ignora -shortest aquí).
    const FACTOR = { high: 1.5, low: 0.75 }[preset];
    const opts = {};
    if (FACTOR) {
      const info = await this.probe(mediaId);
      // La salida no puede durar más que el vídeo: la grave alarga el audio
      // (6 s → 8 s) pero el vídeo manda (6 s).
      if (info.duration) opts.maxDuration = Math.round(Math.min(info.duration / FACTOR, info.duration) * 100) / 100;
    }
    return _audioOp(mediaId, AF, ` - voz ${LABEL}`, onProgress, opts);
  },

  // Suavizar (aproximación honesta, ola 3): reduce ruido, piel más lisa.
  async smoothClip(mediaId, onProgress) {
    return _videoFilterOp(mediaId, 'hqdn3d=1.5:1.5:6:6', ' - suavizado', onProgress);
  },

  // Mejorar (aproximación honesta, ola 3): nitidez + color + poco ruido.
  async enhanceClip(mediaId, onProgress) {
    return _videoFilterOp(mediaId, 'unsharp=5:5:1.0,eq=contrast=1.05:saturation=1.1,hqdn3d=1:1:3:3', ' - mejorado', onProgress);
  },

  // Corte automático (aproximación honesta, ola 3): quita los silencios
  // del clip (silencedetect) y concatena lo que queda. Si no hay
  // silencios, error honesto. Etiqueta en la UI: «Corte automático
  // (silencios)», nunca «IA».
  async autoCut(mediaId, onProgress) {
    const { name, blob, meta } = await _writeInput(mediaId);
    if (meta.kind !== 'video') throw new Error('El corte automático solo se aplica a vídeos');
    const info = await this.probe(mediaId);
    if (!info.hasAudio) throw new Error('El corte automático necesita audio para detectar silencios');
    const dur = info.duration || 0;
    if (!(dur > 0)) throw new Error('No se pudo determinar la duración del clip');
    const files = [name];
    try {
      const { lines } = await _exec(['-i', name, '-af', 'silencedetect=noise=-35dB:d=0.5', '-f', 'null', '-'], { ignoreError: true, onProgress: onProgress ? (p) => onProgress(p * 0.4) : null });
      const silences = [];
      let cur = null;
      for (const line of lines) {
        let m = line.match(/silence_start:\s*([\d.]+)/);
        if (m) { cur = { start: parseFloat(m[1]) }; continue; }
        m = line.match(/silence_end:\s*([\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)/);
        if (m && cur) { silences.push({ start: cur.start, end: parseFloat(m[1]) }); cur = null; }
      }
      if (cur) silences.push({ start: cur.start, end: dur }); // silencio hasta el final
      if (!silences.length) throw new Error('No se detectaron silencios en este clip');
      // Invertir: quedarse con lo que NO es silencio (mín. 0.3 s por tramo).
      const keep = [];
      let pos = 0;
      for (const s of silences) {
        if (s.start - pos >= 0.3) keep.push([pos, s.start]);
        pos = Math.max(pos, s.end);
      }
      if (dur - pos >= 0.3) keep.push([pos, dur]);
      if (!keep.length) throw new Error('El clip es casi todo silencio: no queda nada que guardar');
      const graph = [];
      const ioParts = [];
      keep.forEach(([S, E], i) => {
        graph.push(`[0:v]trim=start=${fmt(S)}:end=${fmt(E)},setpts=PTS-STARTPTS,fps=30[v${i}]`);
        graph.push(`[0:a]atrim=start=${fmt(S)}:end=${fmt(E)},asetpts=PTS-STARTPTS,aformat=channel_layouts=stereo,aresample=48000[a${i}]`);
        // concat exige vídeo y audio INTERCALADOS por tramo: [v0][a0][v1][a1]…
        ioParts.push(`[v${i}][a${i}]`);
      });
      graph.push(`${ioParts.join('')}concat=n=${keep.length}:v=1:a=1[vout][aout]`);
      const outName = _memName('mp4');
      files.push(outName);
      const args = ['-i', name, '-filter_complex', graph.join(';'), '-map', '[vout]', '-map', '[aout]',
        '-c:a', 'aac', '-b:a', '128k',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
        '-r', '30', '-movflags', '+faststart', outName];
      await _exec(args, { onProgress: onProgress ? (p) => onProgress(0.4 + p * 0.6) : null });
      const out = await _readOutput(outName, 'video/mp4');
      return await _saveResult(out, { name: derivedName(meta.name, ' - corte automático'), kind: 'video' });
    } finally {
      await _rmAll(files);
    }
  },

  async composeClone(mediaIdA, mediaIdB, { divider = 0.5 } = {}, onProgress) {
    const DIV = clamp(divider, 0.1, 0.9);
    const inA = await _writeInput(mediaIdA);
    const inB = await _writeInput(mediaIdB);
    const infoA = await this.probe(mediaIdA);
    const infoB = await this.probe(mediaIdB);
    const files = [inA.name, inB.name];
    try {
      const W = infoA.width;
      const H = infoA.height;
      if (!W || !H) throw new Error('No se pudo determinar el tamaño del primer clip');
      const dA = inA.meta.kind === 'image' ? IMAGE_BASE_DURATION : infoA.duration;
      const dB = inB.meta.kind === 'image' ? IMAGE_BASE_DURATION : infoB.duration;
      const D = Math.min(dA, dB);
      if (!(D > 0)) throw new Error('Los clips del clon no tienen duración');
      const outName = _memName('mp4');
      files.push(outName);

      const videoChain = (inputIdx, kind, tag) => (kind === 'image'
        ? `[${inputIdx}:v]fps=30,format=yuv420p,scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}[${tag}]`
        : `[${inputIdx}:v]trim=start=0:end=${fmt(D)},setpts=PTS-STARTPTS,fps=30,scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}[${tag}]`);
      const audioChain = (inputIdx, hasAudio, tag) => (hasAudio
        ? `[${inputIdx}:a]atrim=start=0:end=${fmt(D)},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo[${tag}]`
        : `anullsrc=channel_layout=stereo:sample_rate=48000:d=${fmt(D)},asetpts=PTS-STARTPTS[${tag}]`);

      // Pluma/suavizado del borde: diferido en v1 (divisor duro) — contrato §6.7.
      // El subgrafo de audio solo se construye si algún clip tiene audio:
      // una salida [aout] sin conectar hace fallar a FFmpeg.
      const hasAudioOut = infoA.hasAudio || infoB.hasAudio;
      const audioGraph = hasAudioOut
        ? `${audioChain(0, infoA.hasAudio, 'aa')};`
          + `${audioChain(1, infoB.hasAudio, 'ab')};`
          + `[aa][ab]amix=inputs=2:normalize=0[aout]`
        : '';
      // Corte a ancho par: crop redondea hacia abajo a par en yuv420p, así
      // que trunc(iw*D) puede perder 1 px por mitad (W-2 en total).
      const graph = `${videoChain(0, inA.meta.kind, 'vA')};`
        + `${videoChain(1, inB.meta.kind, 'vB')};`
        + `[vA]crop=w=trunc(iw*${fmt(DIV)}/2)*2:h=ih:x=0:y=0[L];`
        + `[vB]crop=w=iw-trunc(iw*${fmt(DIV)}/2)*2:h=ih:x=trunc(iw*${fmt(DIV)}/2)*2:y=0[R];`
        + `[L][R]hstack[vout]${audioGraph ? `;${audioGraph}` : ''}`;

      const args = [];
      args.push(...(inA.meta.kind === 'image' ? ['-loop', '1', '-t', fmt(D)] : []), '-i', inA.name);
      args.push(...(inB.meta.kind === 'image' ? ['-loop', '1', '-t', fmt(D)] : []), '-i', inB.name);
      args.push('-filter_complex', graph, '-map', '[vout]');
      if (hasAudioOut) args.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '128k');
      else args.push('-an');
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
        '-r', '30', '-movflags', '+faststart', outName);
      await _exec(args, { onProgress });
      const out = await _readOutput(outName, 'video/mp4');
      return await _saveResult(out, {
        name: derivedName(inA.meta.name, ' - clon'), kind: 'video',
      });
    } finally {
      await _rmAll(files);
    }
  },

  // PNG del texto en canvas 2x, fondo transparente — contrato §6.4.
  // El PNG resultante mide el doble que el tamaño lógico; el grafo lo
  // escala a la mitad al componer (ver nota al inicio del archivo).
  async renderTextPNG(text, opts = {}) {
    if (!text || !String(text).trim()) throw new Error('renderTextPNG: texto vacío');
    const size = opts.size || 64;
    const color = opts.color || '#ffffff';
    const bold = opts.bold !== false;
    const italic = !!opts.italic;
    const S = 2; // factor 2x
    let fontPx = size * S;
    let padX = Math.ceil(size * 0.35) * S;
    let padY = Math.ceil(size * 0.3) * S;
    const lines = String(text).split('\n');
    const fontFor = (px) => `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${px}px system-ui, -apple-system, 'Segoe UI', sans-serif`;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    let maxW = 0;
    const measure = () => {
      ctx.font = fontFor(fontPx);
      maxW = 0;
      for (const line of lines) {
        const w = ctx.measureText(line).width;
        if (w > maxW) maxW = w;
      }
      return maxW;
    };
    measure();
    // Ajuste al ancho: en un lienzo vertical (406 px) una letra larga a
    // tamaño grande se cortaría por los lados; con opts.maxWidth (ancho
    // lógico en px) la fuente se reduce hasta que el PNG quepa, en vez de
    // recortarse. Sin maxWidth el comportamiento no cambia.
    const maxWLogical = opts.maxWidth || 0;
    while (maxWLogical > 0 && (maxW + padX * 2) / S > maxWLogical && fontPx > 24) {
      fontPx = Math.max(24, Math.floor(fontPx * 0.9));
      padX = Math.ceil((fontPx / S) * 0.35) * S;
      padY = Math.ceil((fontPx / S) * 0.3) * S;
      measure();
    }
    const font = fontFor(fontPx);
    const lineH = fontPx * 1.25;
    canvas.width = Math.max(1, Math.ceil(maxW) + padX * 2);
    canvas.height = Math.max(1, Math.ceil(lineH * lines.length) + padY * 2);
    ctx.font = font;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    if (opts.bg) {
      ctx.globalAlpha = opts.bg.alpha ?? 0.5;
      ctx.fillStyle = opts.bg.color || '#000000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = color;
    if (opts.stroke) {
      ctx.strokeStyle = opts.stroke.color || '#000000';
      ctx.lineWidth = (opts.stroke.width || 4) * S;
      ctx.lineJoin = 'round';
    }
    lines.forEach((line, i) => {
      const y = padY + fontPx * 0.9 + i * lineH;
      if (opts.stroke) ctx.strokeText(line, padX, y);
      ctx.fillText(line, padX, y);
    });
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('No se pudo generar el PNG del texto'))),
        'image/png',
      );
    });
    return blob;
  },

  // Emoji como PNG transparente (adhesivos, ola 1): un emoji es texto con
  // fuente grande y fondo transparente — mismo patrón que renderTextPNG,
  // sin assets externos. sizePx es el tamaño lógico (el PNG sale a 2x).
  async renderEmojiPNG(emoji, sizePx = 256) {
    if (!emoji || !String(emoji).trim()) throw new Error('renderEmojiPNG: emoji vacío');
    const S = 2; // factor 2x
    const fontPx = sizePx * S;
    const font = `${fontPx}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",system-ui,sans-serif`;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    ctx.font = font;
    const w = Math.ceil(ctx.measureText(emoji).width);
    canvas.width = Math.max(1, w + fontPx);
    canvas.height = Math.max(1, Math.ceil(fontPx * 1.3));
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(emoji, canvas.width / 2, canvas.height / 2);
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('No se pudo generar el PNG del emoji'))),
        'image/png',
      );
    });
    return blob;
  },

  // --- Exportación de la línea de tiempo — contrato §6 ---------------------

  async exportTimeline(project, onProgress) {
    if (!project || !Array.isArray(project.clips) || project.clips.length === 0) {
      throw new Error('El proyecto no tiene clips para exportar');
    }
    // Huecos de la Plantilla J'K sin rellenar: error claro, no exportar a medias.
    if (project.clips.some((c) => c.placeholder || !c.mediaId)) {
      throw new Error('El proyecto tiene huecos sin rellenar (Plantilla J\'K): elige un clip de la galería para cada hueco antes de exportar.');
    }
    await _ensureLoaded();
    const fps = project.fps || FPS_DEFAULT;
    const exportHeight = project.exportHeight === 1080 ? 1080 : 720;
    const canvas = (RATIO_CANVAS[project.ratio] || RATIO_CANVAS['9:16'])[exportHeight];
    const W = canvas[0];
    const H = canvas[1];
    const files = [];
    try {
      // 1) Entradas: clips de vídeo/imagen.
      const clips = [];
      for (let i = 0; i < project.clips.length; i++) {
        const clip = project.clips[i];
        const { name, meta } = await _writeInput(clip.mediaId);
        files.push(name);
        const info = await this.probe(clip.mediaId);
        const trimEnd = clip.trimEnd ?? (clip.kind === 'image' ? IMAGE_BASE_DURATION : info.duration);
        const c = {
          idx: i, kind: clip.kind, mediaId: clip.mediaId, name: clip.name,
          inputIdx: i, trimStart: clip.trimStart || 0, trimEnd,
          speed: clip.speed || 1,
          filters: clip.filters || { brightness: 0, contrast: 1, saturation: 1 },
          chroma: clip.chroma || null,
          transition: clip.transition || { type: 'none', duration: 0.5 },
          keyframes: clip.keyframes || [],
          volume: clip.volume ?? 1,
          hasAudio: meta.kind === 'video' ? !!info.hasAudio : false,
          // InShot (12 nov 2026): efecto, giro/volteo, recorte, fondo/lona,
          // opacidad y máscara por clip.
          effect: clip.effect || 'none',
          rotate: clip.rotate || 0,
          flipH: !!clip.flipH,
          flipV: !!clip.flipV,
          crop: clip.crop || null,
          fit: clip.fit || 'cover',
          bg: clip.bg || 'black',
          bgColor: clip.bgColor || '#000000',
          opacity: clip.opacity ?? 1,
          mask: clip.mask || null,
        };
        c.D = clipDuration(c, info);
        clips.push(c);
      }

      // Entradas extra del Cómic: una segunda copia del medio por cada clip
      // con preset 'comic'. La rama de bordes lee de ahí (sin split: con
      // split el Cómic saldría en gris — ver nota en la receta). Van tras
      // las entradas principales, así que audioBase es files.length.
      for (const c of clips) {
        if ((c.filters && c.filters.preset) === 'comic') {
          const edge = await _writeInput(c.mediaId);
          files.push(edge.name);
          c.edgeInputIdx = files.length - 1;
        }
      }

      // 2) Entradas: audios de la pista de audio.
      const audios = [];
      const audioBase = files.length;
      for (let j = 0; j < (project.audios || []).length; j++) {
        const a = project.audios[j];
        const { name, meta } = await _writeInput(a.mediaId);
        files.push(name);
        if (meta.kind !== 'audio') throw new Error(`La pista de audio "${a.name || ''}" no es un audio`);
        const info = await this.probe(a.mediaId);
        audios.push({
          idx: j, inputIdx: audioBase + j, name: a.name,
          trimStart: a.trimStart || 0,
          trimEnd: a.trimEnd ?? info.duration,
          volume: a.volume ?? 1,
          start: a.start || 0,
          keyframes: a.keyframes || [],
        });
      }

      // 3) Entradas: textos (PNG 2x generados en canvas).
      const texts = [];
      const textBase = audioBase + audios.length;
      const sortedTexts = [...(project.texts || [])].sort((a, b) => (a.start || 0) - (b.start || 0));
      for (let k = 0; k < sortedTexts.length; k++) {
        const t = sortedTexts[k];
        const start = t.start || 0;
        const end = t.end ?? start + 3;
        if (!(end > start)) continue; // texto sin duración visible: se omite
        // maxWidth: la letra se ajusta al lienzo en vez de cortarse por los lados.
        const png = await this.renderTextPNG(t.text, { ...t, maxWidth: W - 16 });
        const size = await _pngSize(png);
        const name = _memName('png');
        await _writeBlob(name, png);
        files.push(name);
        texts.push({
          idx: k, inputIdx: textBase + k, start, end,
          x: t.x || 0, y: t.y || 0,
          keyframes: t.keyframes || [],
          dispW: Math.floor(size.w / 2),
          dispH: Math.floor(size.h / 2),
        });
      }

      const hasAnyAudio = clips.some((c) => c.hasAudio) || audios.length > 0;

      // 3b) Entradas: PIP (overlays) y adhesivos (stickers). Los PIP son
      // vídeos/imágenes de la galería, en silencio; los adhesivos son
      // emojis (PNG por canvas) o imágenes de la galería.
      const overlays = [];
      const overlayBase = textBase + texts.length;
      for (let n = 0; n < (project.overlays || []).length; n++) {
        const o = project.overlays[n];
        const { name, meta } = await _writeInput(o.mediaId);
        files.push(name);
        const info = await this.probe(o.mediaId);
        overlays.push({
          idx: n, inputIdx: overlayBase + n, kind: meta.kind,
          start: o.start || 0, end: o.end ?? (o.start || 0) + 3,
          x: o.x ?? 0.8, y: o.y ?? 0.2, w: o.w ?? 0.25,
          // El alto del PIP sale de su aspecto (no se estira al lienzo).
          aspect: (info.width && info.height) ? info.height / info.width : 1,
          opacity: o.opacity ?? 1,
        });
      }
      const stickers = [];
      const stickerBase = overlayBase + overlays.length;
      for (let q = 0; q < (project.stickers || []).length; q++) {
        const s = project.stickers[q];
        const start = s.start || 0;
        const end = s.end ?? start + 3;
        if (!(end > start)) continue; // adhesivo sin duración visible: se omite
        let name;
        let dispW;
        let dispH;
        if (s.emoji) {
          const png = await this.renderEmojiPNG(s.emoji, 256);
          const size = await _pngSize(png);
          name = _memName('png');
          await _writeBlob(name, png);
          files.push(name);
          dispW = Math.floor(size.w / 2);
          dispH = Math.floor(size.h / 2);
        } else if (s.mediaId) {
          const w = await _writeInput(s.mediaId);
          name = w.name;
          files.push(name);
          const info = await this.probe(s.mediaId);
          dispW = info.width || 200;
          dispH = info.height || 200;
        } else continue;
        // inputIdx = posición real en files[] (los omitidos no cuentan).
        stickers.push({
          idx: stickers.length, inputIdx: stickerBase + stickers.length,
          start, end, x: s.x ?? 0.5, y: s.y ?? 0.5,
          scale: s.scale ?? 1, dispW, dispH,
        });
      }

      // 4) Grafo.
      const graph = [];
      const segments = [];
      for (const c of clips) {
        const { graph: clipGraph, vLabel: clipVLabel, needsAlpha } = buildClipVideoFilter(c, W, H, fps);
        graph.push(...clipGraph);
        let vLabel = clipVLabel;
        if (needsAlpha) {
          graph.push(
            `color=c=black:s=${W}x${H}:r=${fps}:d=${fmt(c.D)}[bg${c.idx}];`
            + `[bg${c.idx}][${vLabel}]overlay=0:0:shortest=1[v${c.idx}s]`,
          );
          vLabel = `v${c.idx}s`;
        }
        let aLabel = null;
        if (hasAnyAudio) {
          graph.push(buildClipAudioFilter(c));
          aLabel = `a${c.idx}`;
        }
        segments.push({ vLabel, aLabel, D: c.D, transition: c.transition });
      }

      const chained = chainSegments(segments, hasAnyAudio);
      graph.push(...chained.graph);
      let vcur = chained.vChain;
      let totalDuration = chained.totalDuration;

      // 5) Textos sobre el vídeo encadenado — contrato §6.4.
      for (const t of texts) {
        const inIdx = t.inputIdx;
        let chain = `[${inIdx}:v]fps=${fps},setpts=PTS+${fmt(t.start)},format=rgba`;
        if (opacityNeeded(t.keyframes)) {
          // geq usa T (mayúscula) como tiempo; `t` da "Undefined constant".
          // alpha(X,Y)*OP conserva el alfa del PNG (fondo transparente).
          const opE = opacityExpr(t.keyframes, 'T');
          chain += `,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*(${opE})'`;
        }
        chain += `,scale=trunc(iw/2):trunc(ih/2)[txt${t.idx}]`;
        graph.push(chain);
        const xE = interpExpr(t.keyframes, 'x', 't');
        const yE = interpExpr(t.keyframes, 'y', 't');
        const X = xE !== null
          ? `${fmt(W / 2)}+(${xE})-${fmt(t.dispW / 2)}`
          : fmt(W / 2 + t.x - t.dispW / 2);
        const Y = yE !== null
          ? `${fmt(H / 2)}+(${yE})-${fmt(t.dispH / 2)}`
          : fmt(H / 2 + t.y - t.dispH / 2);
        const vout = `vtxt${t.idx}`;
        graph.push(`[${vcur}][txt${t.idx}]overlay=x='${X}':y='${Y}':enable='between(t,${fmt(t.start)},${fmt(t.end)})'[${vout}]`);
        vcur = vout;
      }

      // 5b) PIP y adhesivos sobre el vídeo encadenado. Los PIP van en
      // silencio (sin audio); su vídeo arranca en o.start. Las posiciones
      // x/y son el CENTRO en fracciones del lienzo; w/h del PIP también.
      for (const o of overlays) {
        const ow = Math.max(2, Math.round(W * o.w));
        const oh = Math.max(2, Math.round(ow * (o.aspect || 1)));
        let chain = `[${o.inputIdx}:v]fps=${fps},setpts=PTS-STARTPTS+${fmt(o.start)},scale=${ow}:${oh}`;
        if (o.kind === 'image') chain = `[${o.inputIdx}:v]fps=${fps},setpts=PTS+${fmt(o.start)},scale=${ow}:${oh}`;
        if (o.opacity !== 1) chain += `,format=yuva420p,colorchannelmixer=aa=${fmt(o.opacity)}`;
        chain += `[ov${o.idx}]`;
        graph.push(chain);
        const vout = `vov${o.idx}`;
        graph.push(`[${vcur}][ov${o.idx}]overlay=x='W*${fmt(o.x)}-w/2':y='H*${fmt(o.y)}-h/2':enable='between(t,${fmt(o.start)},${fmt(o.end)})'[${vout}]`);
        vcur = vout;
      }
      for (const s of stickers) {
        const sw = Math.max(2, Math.floor((s.dispW * s.scale) / 2) * 2);
        const sh = Math.max(2, Math.floor((s.dispH * s.scale) / 2) * 2);
        graph.push(`[${s.inputIdx}:v]fps=${fps},setpts=PTS+${fmt(s.start)},format=rgba,scale=${sw}:${sh}[stk${s.idx}]`);
        const X = `W*${fmt(s.x)}-${fmt(sw / 2)}`;
        const Y = `H*${fmt(s.y)}-${fmt(sh / 2)}`;
        const vout = `vstk${s.idx}`;
        graph.push(`[${vcur}][stk${s.idx}]overlay=x='${X}':y='${Y}':enable='between(t,${fmt(s.start)},${fmt(s.end)})'[${vout}]`);
        vcur = vout;
      }

      // 6) Mezcla de audio — contrato §6.5.
      let aout = null;
      if (hasAnyAudio) {
        aout = chained.aChain;
        if (audios.length > 0) {
          for (const a of audios) graph.push(buildAudioTrackFilter(a));
          const inputs = [`[${aout}]`, ...audios.map((a) => `[au${a.idx}]`)];
          graph.push(`${inputs.join('')}amix=inputs=${inputs.length}:normalize=0[aout]`);
          aout = 'aout';
        }
      }
      const maxAudioEnd = audios.reduce(
        (m, a) => Math.max(m, (a.start || 0) + ((a.trimEnd ?? 0) - (a.trimStart || 0))),
        0,
      );
      totalDuration = Math.max(totalDuration, maxAudioEnd);

      // 7) Argumentos de entrada y salida — contrato §6.6.
      const args = [];
      for (const c of clips) {
        if (c.kind === 'image') args.push('-loop', '1', '-t', fmt(c.D));
        args.push('-i', files[c.inputIdx]);
      }
      // Entradas extra del Cómic, en el mismo orden que en files[].
      for (const c of clips) {
        if (c.edgeInputIdx != null) {
          if (c.kind === 'image') args.push('-loop', '1', '-t', fmt(c.D));
          args.push('-i', files[c.edgeInputIdx]);
        }
      }
      for (const a of audios) args.push('-i', files[a.inputIdx]);
      for (const t of texts) args.push('-loop', '1', '-t', fmt(t.end - t.start), '-i', files[t.inputIdx]);
      for (const o of overlays) {
        if (o.kind === 'image') args.push('-loop', '1', '-t', fmt(o.end - o.start));
        args.push('-i', files[o.inputIdx]);
      }
      for (const s of stickers) args.push('-loop', '1', '-t', fmt(s.end - s.start), '-i', files[s.inputIdx]);

      const outName = _memName('mp4');
      files.push(outName);
      args.push('-filter_complex', graph.join(';'));
      args.push('-map', `[${vcur}]`);
      if (hasAnyAudio) {
        args.push('-map', `[${aout}]`, '-c:a', 'aac', '-b:a', '128k');
      } else {
        args.push('-an');
      }
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
        '-pix_fmt', 'yuv420p', '-r', String(fps),
        '-movflags', '+faststart', '-f', 'mp4', outName);

      const totalUs = Math.max(1, Math.round(totalDuration * 1000000));
      await _exec(args, { onProgress, totalUs });
      return await _readOutput(outName, 'video/mp4');
    } finally {
      await _rmAll(files);
    }
  },
};

function _pngSize(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ w: img.naturalWidth, h: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('No se pudo medir el PNG del texto'));
    };
    img.src = url;
  });
}

export default Engine;
