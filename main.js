const { app, BrowserWindow, ipcMain, webFrameMain } = require('electron');
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

// embed/live_stream?channel= da Error 150 aunque el live sí sea embebible,
// así que se busca el video del live actual: <canal>/live lo tiene como
// canonical. Devuelve null si el canal no está transmitiendo.
async function findLiveVideo(channel) {
  const res = await fetch(`${channelUrl(channel)}/live`, { headers: { 'User-Agent': app.userAgentFallback } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const m = (await res.text()).match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})"/);
  return m ? m[1] : null;
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

async function createWindow() {
  const port = await startServer();
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
ipcMain.handle('find-live', (_e, channel) => findLiveVideo(channel));
ipcMain.on('toggle-fullscreen', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  win.setFullScreen(!win.isFullScreen());
});
ipcMain.on('quit', () => app.quit());

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
