const { app, BrowserWindow, ipcMain, session, webFrameMain } = require('electron');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
// YouTube trata mejor un user agent de Chrome normal que uno con "Electron/x".
app.userAgentFallback = app.userAgentFallback.replace(/\s*(Electron|livetv)\/\S+/g, '');

const RENDERER_DIR = path.join(__dirname, 'renderer');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

function configPaths() {
  const i = process.argv.indexOf('--config');
  if (i !== -1 && process.argv[i + 1]) return [path.resolve(process.argv[i + 1])];
  return [
    path.join(os.homedir(), '.config', 'livetv', 'streams.json'),
    path.join(__dirname, 'streams.json'),
  ];
}

function loadConfig() {
  const candidates = configPaths();
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      const config = JSON.parse(fs.readFileSync(file, 'utf8'));
      return { ...config, file };
    } catch (err) {
      return { error: `No se pudo leer ${file}: ${err.message}` };
    }
  }
  return { error: `No se encontró configuración. Crea uno de:\n${candidates.join('\n')}` };
}

// URL base de un canal a partir de un ID UC…, un handle (@nombre o nombre)
// o una URL de canal.
function channelUrl(value) {
  if (/^UC[\w-]{22}$/.test(value)) return `https://www.youtube.com/channel/${value}`;
  if (/^https?:\/\//.test(value)) return value.replace(/\/(live|featured|videos|streams)?\/?$/, '');
  return `https://www.youtube.com/@${value.replace(/^@/, '')}`;
}

async function fetchPage(url) {
  const res = await fetch(url, { headers: { 'User-Agent': app.userAgentFallback } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// embed/live_stream?channel= da Error 150 aunque el live sí sea embebible,
// así que se busca el video del live: <canal>/live lo tiene como canonical.
// Es el live principal; si el canal transmite varios a la vez, el resto sale
// de la pestaña <canal>/streams (los que tienen el badge EN VIVO). Devuelve
// [{ id, title }], vacío si el canal no está transmitiendo.
async function findLives(channel) {
  const base = channelUrl(channel);
  const [live, streams] = await Promise.all([
    fetchPage(`${base}/live`),
    fetchPage(`${base}/streams`),
  ]);
  const lives = [];
  const main = live.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})"/);
  // Sin live en curso, /live apunta al próximo live programado (isUpcoming en
  // videoDetails): no cuenta hasta que empiece.
  if (main && !live.includes('"isUpcoming":true')) lives.push({ id: main[1], title: '' });

  const data = streams.match(/var ytInitialData = (\{.*?\});<\/script>/s);
  if (!data) return lives;
  (function walk(o) {
    if (!o || typeof o !== 'object') return;
    const v = o.lockupViewModel;
    if (v) {
      if (JSON.stringify(v.contentImage).includes('THUMBNAIL_OVERLAY_BADGE_STYLE_LIVE')) {
        const title = v.metadata?.lockupMetadataViewModel?.title?.content || '';
        const found = lives.find((l) => l.id === v.contentId);
        if (found) found.title = title;
        else lives.push({ id: v.contentId, title });
      }
      return;
    }
    Object.values(o).forEach(walk);
  })(JSON.parse(data[1]));
  return lives;
}

// Slug de un evento de Polymarket a partir del slug o de su URL (/event/<slug>).
function polymarketSlug(value) {
  const m = value.match(/polymarket\.com\/event\/([^/?#]+)/);
  return m ? m[1] : value;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': app.userAgentFallback } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Outcomes de un evento de Polymarket, de mayor a menor probabilidad. Un evento
// con varios mercados (candidatos) da un row por mercado abierto, con el token
// del "Yes"; un evento de un solo mercado da un row por outcome. Si ya se
// resolvió, closed es true y los precios quedan en 0 o 1.
async function findMarket(value) {
  const slug = polymarketSlug(value);
  const [event] = await fetchJson(`https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`);
  if (!event) throw new Error(`No existe el evento ${slug}`);
  const parse = (s) => (s ? JSON.parse(s) : []);
  const markets = event.markets || [];
  const closed = !!event.closed || markets.every((m) => m.closed);
  let rows;
  if (markets.length === 1) {
    const [m] = markets;
    const tokens = parse(m.clobTokenIds);
    const prices = parse(m.outcomePrices);
    rows = parse(m.outcomes).map((label, k) => ({ label, tokenId: tokens[k], price: Number(prices[k]) }));
  } else {
    rows = markets.filter((m) => closed || !m.closed).map((m) => ({
      label: m.groupItemTitle || m.question,
      tokenId: parse(m.clobTokenIds)[0],
      price: Number(parse(m.outcomePrices)[0]),
    }));
  }
  // Los eventos traen mercados de relleno ("Person O") sin token ni precio.
  rows = rows.filter((r) => r.tokenId && Number.isFinite(r.price));
  rows.sort((a, b) => b.price - a.price);
  return { title: event.title, closed, rows };
}

// Probabilidad del último día de un outcome: [{ t, p }], t en segundos.
async function priceHistory(tokenId) {
  const data = await fetchJson(`https://clob.polymarket.com/prices-history?market=${tokenId}&interval=1d&fidelity=5`);
  return data.history || [];
}

const decodeEntities = (s) => s
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// Programación de un canal para la guía, desde mi.tv (stream.epg =
// "mi.tv/<país>/<canal>", el país y el id como en las URLs de mi.tv). La
// página de cada día trae los programas en orden con la hora de inicio en UTC;
// si la hora retrocede, ya es el día siguiente. Se piden ayer, hoy y mañana
// (UTC) para tener lo que está al aire y lo que viene; cada programa dura hasta
// que empieza el siguiente. Devuelve { logo, programs: [{ start, stop, title,
// category, description }] } con tiempos en ms.
const SCHEDULE_TTL_MS = 30 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const scheduleCache = new Map();

async function findSchedule(epg) {
  const m = /^mi\.tv\/([a-z]{2})\/([\w-]+)$/.exec(epg || '');
  if (!m) throw new Error(`epg no reconocido: ${epg}`);
  const cached = scheduleCache.get(epg);
  if (cached && Date.now() - cached.at < SCHEDULE_TTL_MS) return cached.data;
  const [, country, id] = m;
  const today = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  const pages = await Promise.all([-1, 0, 1].map(async (k) => {
    const day = today + k * DAY_MS;
    const date = new Date(day).toISOString().slice(0, 10);
    try {
      return { day, html: await fetchPage(`https://mi.tv/${country}/async/channel/${id}/${date}/0`) };
    } catch {
      return null;
    }
  }));
  const text = (html) => decodeEntities((html || '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
  let logo = null;
  // Las páginas se solapan (lo de pasada la medianoche sale en dos días): por inicio.
  const byStart = new Map();
  for (const page of pages.filter(Boolean)) {
    logo ||= /<div class="channel-info">\s*<img src="([^"]+)"/.exec(page.html)?.[1] || null;
    let base = page.day;
    let prev = -Infinity;
    for (const [, item] of page.html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)) {
      const time = /class="time">\s*(\d{1,2}):(\d{2})/.exec(item);
      if (!time) continue;
      let start = base + (Number(time[1]) * 60 + Number(time[2])) * 60000;
      if (start < prev) {
        base += DAY_MS;
        start += DAY_MS;
      }
      prev = start;
      byStart.set(start, {
        start,
        title: text(/<h2>([\s\S]*?)<\/h2>/.exec(item)?.[1]),
        category: text(/class="sub-title">([\s\S]*?)<\/span>/.exec(item)?.[1]),
        description: text(/class="synopsis">([\s\S]*?)<\/p>/.exec(item)?.[1]),
      });
    }
  }
  const programs = [...byStart.values()].sort((a, b) => a.start - b.start);
  programs.forEach((p, k) => { p.stop = programs[k + 1]?.start ?? p.start + 60 * 60000; });
  if (!programs.length) throw new Error(`mi.tv no trajo programación para ${epg}`);
  const data = { logo, programs };
  scheduleCache.set(epg, { at: Date.now(), data });
  return data;
}

// Logo de un canal para el OSD de canal y la guía: el de mi.tv si el stream
// tiene epg (logos de la señal, pensados para fondo claro: plate), si no el
// avatar del canal de YouTube (og:image de la página del canal o, para un
// video suelto, el de su dueño). null si no hay. Se piden de a uno, en cola,
// para no sumar una ráfaga de páginas de YouTube a la búsqueda de lives al
// abrir una categoría; un resultado vacío se vuelve a intentar la próxima vez.
const logoCache = new Map();
let logoQueue = Promise.resolve();

function findLogo(stream) {
  const key = stream.epg || stream.channel || stream.url;
  if (!key) return null;
  if (!logoCache.has(key)) {
    const job = logoQueue.then(() => fetchLogo(stream)).catch(() => null);
    logoQueue = job;
    logoCache.set(key, job.then((logo) => {
      if (!logo) logoCache.delete(key);
      return logo;
    }));
  }
  return logoCache.get(key);
}

async function fetchLogo(stream) {
  // Avatar a 176 px: alcanza para el OSD y pesa poco.
  const avatar = (url) => ({ url: url.replace(/=s\d+-/, '=s176-'), plate: false });
  if (stream.epg) {
    const logo = await findSchedule(stream.epg).then((d) => d.logo, () => null);
    if (logo) return { url: logo, plate: true };
  }
  if (stream.channel) {
    const page = await fetchPage(channelUrl(stream.channel));
    const m = /<meta property="og:image" content="([^"]+)"/.exec(page);
    return m ? avatar(decodeEntities(m[1])) : null;
  }
  if (stream.url && /(^|\.)(youtube\.com|youtu\.be)$/.test(new URL(stream.url).hostname)) {
    const page = await fetchPage(stream.url);
    const m = /"videoOwnerRenderer":\{"thumbnail":\{"thumbnails":\[\{"url":"([^"]+)"/.exec(page);
    return m ? avatar(m[1]) : null;
  }
  return null;
}

// Nombre para un stream agregado sin nombre: el título del canal, del video o
// del evento de Polymarket, o "Windy". Si no se puede averiguar queda sin nombre.
async function guessName(stream) {
  try {
    if (stream.polymarket) return (await findMarket(stream.polymarket)).title;
    if (stream.windy) return 'Windy';
    if (stream.url && !/\.m3u8$/i.test(new URL(stream.url).pathname)) {
      const page = await fetchPage(stream.url);
      const m = page.match(/<meta property="og:title" content="([^"]*)"/);
      return m ? decodeEntities(m[1]) : null;
    }
    if (stream.channel) {
      const page = await fetchPage(channelUrl(stream.channel));
      const m = page.match(/<meta property="og:title" content="([^"]*)"/);
      return m ? decodeEntities(m[1]) : null;
    }
  } catch {}
  return null;
}

// Agrega un stream a la categoría `category` (índice en la config) y reescribe
// el archivo. Se relee antes de escribir por si se editó con la app abierta;
// si la categoría ya no es la misma, no se toca. Devuelve el stream guardado.
async function addStream({ category, categoryName, stream }) {
  const { file } = loadConfig();
  if (!file) throw new Error('No hay archivo de configuración');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  let list;
  if (Array.isArray(config.categories)) {
    const target = config.categories[category];
    if (!target || (target.name || '') !== categoryName) {
      throw new Error(`${path.basename(file)} cambió: reinicia la app`);
    }
    list = target.streams = target.streams || [];
  } else {
    list = config.streams = config.streams || [];
  }
  const saved = stream.name ? stream : { name: await guessName(stream) || undefined, ...stream };
  list.push(saved);
  // Escritura atómica: un archivo a medio escribir dejaría la app sin config.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return saved;
}

// Ajustes del menú de setup, aparte de la config de streams (que se edita a
// mano): ~/.config/livetv/settings.json.
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
const DEFAULT_SETTINGS = { leveler: true };
let settings = loadSettings();

function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(win, changes) {
  settings = { ...settings, ...changes };
  const tmp = `${SETTINGS_FILE}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  fs.renameSync(tmp, SETTINGS_FILE);
  for (const frame of youtubeFrames(win)) {
    frame.executeJavaScript(`window.livetvLeveler?.(${settings.leveler})`).catch(() => {});
  }
  return settings;
}

// El nivelador de volumen (renderer/leveler.js) se inyecta en cada iframe de
// YouTube: es de otro origen y el renderer no puede tocar su audio.
const LEVELER_JS = fs.readFileSync(path.join(RENDERER_DIR, 'leveler.js'), 'utf8');

function isYoutubeFrame(frame) {
  return frame.url.startsWith('https://www.youtube.com/');
}

function youtubeFrames(win) {
  return win.webContents.mainFrame.framesInSubtree.filter(isYoutubeFrame);
}

// Los embeds de YouTube fallan desde file:// (sin Referer/origin válido),
// así que el renderer se sirve desde un HTTP local.
function startServer() {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.join(RENDERER_DIR, urlPath === '/' ? 'index.html' : urlPath);
    if (!file.startsWith(RENDERER_DIR + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

// hls.js baja la playlist y los segmentos de un .m3u8 con XHR desde el origin
// local, y muchos servidores HLS no mandan Access-Control-Allow-Origin. Se
// agrega a las respuestas pedidas por el renderer (no por los iframes de YouTube).
function allowHlsCors(origin) {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders || {};
    const hasCors = Object.keys(headers).some((h) => h.toLowerCase() === 'access-control-allow-origin');
    if (details.resourceType !== 'xhr' || hasCors || !details.frame?.url.startsWith(origin)) {
      callback({});
      return;
    }
    callback({ responseHeaders: { ...headers, 'Access-Control-Allow-Origin': ['*'] } });
  });
}

async function createWindow() {
  const port = await startServer();
  allowHlsCors(`http://127.0.0.1:${port}/`);
  const win = new BrowserWindow({
    width: 1600,
    height: 900,
    fullscreen: true,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    title: 'LiveTV',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.removeMenu();
  // El reproductor de YouTube ignora unMute() si su iframe nunca recibió un
  // gesto de usuario. Ejecutar JS con userGesture=true le da esa activación.
  // De paso se instala el nivelador de volumen.
  win.webContents.on('did-frame-finish-load', (_e, isMainFrame, processId, routingId) => {
    if (isMainFrame) return;
    const frame = webFrameMain.fromId(processId, routingId);
    if (frame && isYoutubeFrame(frame)) {
      frame.executeJavaScript(`${LEVELER_JS}\nwindow.livetvLeveler(${settings.leveler});`, true).catch(() => {});
    }
  });
  win.loadURL(`http://127.0.0.1:${port}/`);
}

ipcMain.handle('get-config', () => loadConfig());
ipcMain.handle('find-lives', (_e, channel) => findLives(channel));
ipcMain.handle('find-market', (_e, value) => findMarket(value));
ipcMain.handle('price-history', (_e, tokenId) => priceHistory(tokenId));
ipcMain.handle('add-stream', (_e, args) => addStream(args));
ipcMain.handle('find-schedule', (_e, epg) => findSchedule(epg));
ipcMain.handle('find-logo', (_e, stream) => findLogo(stream));
ipcMain.handle('get-settings', () => settings);
ipcMain.handle('set-settings', (e, changes) => saveSettings(BrowserWindow.fromWebContents(e.sender), changes));
ipcMain.on('toggle-fullscreen', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  win.setFullScreen(!win.isFullScreen());
});
ipcMain.on('quit', () => app.quit());

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
