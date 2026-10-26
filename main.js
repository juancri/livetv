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
  win.webContents.on('did-frame-finish-load', (_e, isMainFrame, processId, routingId) => {
    if (isMainFrame) return;
    const frame = webFrameMain.fromId(processId, routingId);
    if (frame && frame.url.startsWith('https://www.youtube.com/')) {
      frame.executeJavaScript('0', true).catch(() => {});
    }
  });
  win.loadURL(`http://127.0.0.1:${port}/`);
}

ipcMain.handle('get-config', () => loadConfig());
ipcMain.handle('find-lives', (_e, channel) => findLives(channel));
ipcMain.handle('find-market', (_e, value) => findMarket(value));
ipcMain.handle('price-history', (_e, tokenId) => priceHistory(tokenId));
ipcMain.on('toggle-fullscreen', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  win.setFullScreen(!win.isFullScreen());
});
ipcMain.on('quit', () => app.quit());

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
