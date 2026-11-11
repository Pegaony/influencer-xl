# INFLUENCER XL — versión web (fase 1)

Editor de vídeo e imágenes en el navegador, sin servidor y sin cuentas.
Todo pasa en tu equipo: los proyectos viven en IndexedDB/localStorage, los
medios en tu galería local y las exportaciones se descargan a tu carpeta de
Descargas.

**Estado:** fase 1 verificada en navegador de escritorio (ver
`smoke/results/report.json`). La APK de Android llega después de que esta
versión web quede confirmada; el mismo `www/` se empaqueta con Capacitor y
los plugins nativos (Media3 + FFmpeg) sustituyen a ffmpeg.wasm.

## Qué hace (fase 1)

- **Editor de vídeo** — línea de tiempo multi-pista (vídeo, imagen, texto,
  audio), cortar/dividir/unir clips, textos sobre el vídeo, filtros
  (brillo/contraste/saturación/color), transiciones (fade, wipe, dissolve,
  zoom), velocidad, croma, máscaras (lineal/circular), keyframes
  (posición/escala/rotación/opacidad), auto-reframe, exportación H.264+AAC
  en 720p/1080p y relaciones 9:16, 1:1, 16:9, 3:4, 4:3, 4:5, 21:9.
- **Efecto clon por media máscara (sin IA)** — dos tomas guiadas lado a lado
  con divisor móvil, más la guía de grabación dentro de la app (trípode,
  mismo fondo y luz, foco/exposición bloqueados, no cruzar la línea central,
  mirar al otro "yo", cambiar de ropa entre tomas).
- **Generación de imágenes** — Pollinations sin clave (modelo Flux) y
  FLUX.1-schnell de Hugging Face si pones tu token en Ajustes. Galería
  propia de imágenes generadas + importación desde tu equipo. Las imágenes
  generadas entran en la línea de tiempo como cualquier clip.
- **Quitar fondo** — rembg/U2-Net por ONNX o por Inference de Hugging Face
  cuando hay token; sin token la app lo dice claro, nunca finge el resultado.
- **Proyectos locales** — JSON en IndexedDB, sin nube ni registro.

## Cómo usarla

1. Abre `www/index.html` desde un servidor estático (por ejemplo
   `python3 -m http.server` en `www/`) o súbela a GitHub Pages.
2. Crea un proyecto, sube vídeos/imágenes/audio desde tu equipo.
3. Edita en la línea de tiempo, exporta y descarga el MP4.

> La primera carga descarga el motor ffmpeg.wasm (~32 MB, en `www/vendor/`),
> así que la primera exportación tarda unos segundos más. Después queda en
> caché del navegador.

## Limitaciones honestas (web, fase 1)

- **Estabilización no disponible en web:** el core de ffmpeg.wasm no trae
  `vidstab`; el botón lo dice y no finge estabilizar. En la APK sí estará
  (ffmpeg-kit-full-gpl incluye vidstab).
- **Pollinations sin clave** permite 1 petición a la vez con ~45 s entre
  imágenes; la app aplica esa espera y avisa con un temporizador.
- **Sin token de Hugging Face** no hay FLUX.1-schnell ni quitar-fondo por
  Inference; la app lo avisa en vez de inventar el resultado.
- La exportación en el navegador es más lenta que en la APK y depende de la
  memoria del equipo; para vídeos largos conviene 720p.

## Licencias

- **Código propio de INFLUENCER XL** (todo `www/` salvo `www/vendor/`):
  **Apache License 2.0**. Eres libre de usarlo, modificarlo y
  redistribuirlo bajo sus términos.
- **ffmpeg.wasm** (`www/vendor/ffmpeg/`, paquete `@ffmpeg/core`): el core
  está bajo **GPL** (FFmpeg con libx264). Si redistribuyes la app con este
  motor, respeta la GPL (ofrece el código fuente correspondiente). Por eso
  este repositorio no mezcla licencias: tu código es Apache-2.0 y el motor
  de vídeo es GPL, cada uno en su carpeta.
- **Servicios externos** (no se redistribuyen, se llaman desde el navegador):
  Pollinations (sus términos en pollinations.ai) y Hugging Face Inference
  (sus términos; el token es tuyo y nunca sale de tu navegador salvo hacia
  sus servidores).

## Desarrollo

- Contratos y recetas de FFmpeg: `CONTRACT.md`.
- Investigación y decisiones de fase 1: `../app-editor-video/investigacion.md`.
- Pruebas de humo (Playwright): `smoke/smoke-web.mjs` — sirve `www/` en
  local y verifica carga, pantallas, proyecto, motor, generación de imagen,
  recorte, ratio, división, texto, exportación con audio y clon. Resultados
  en `smoke/results/report.json`.
