const ENDED_RETRY_MS = 30000;
const CHANNEL_OSD_MS = 3000;
const VOLUME_STEP = 5;
const OSD_SEGMENTS = 50;
const OSD_MS = 2500;

const grid = document.getElementById('grid');
const help = document.getElementById('help');
const osd = {
  el: document.getElementById('osd'),
  label: document.querySelector('#osd .osd-label'),
  value: document.querySelector('#osd .osd-value'),
  bar: document.querySelector('#osd .osd-bar'),
  timer: null,
};
const channelOsd = {
  el: document.getElementById('osd-channel'),
  number: document.querySelector('#osd-channel .osd-number'),
  name: document.querySelector('#osd-channel .osd-name'),
  timer: null,
};

const ytReady = new Promise((resolve) => {
  window.onYouTubeIframeAPIReady = resolve;
});

const tiles = [];
let focusIndex = 0;
let columns = 1;
let configColumns = null;
// Índices de los tiles en el mosaico, en orden; los canales sin señal quedan fuera.
let visible = [];
let showOffline = false;
// Volumen y silencio son globales, como en un televisor: se mantienen al cambiar de canal.
let volume = 100;
let muted = false;

// Acepta watch?v=, youtu.be/, /live/, /embed/, /shorts/ o un ID suelto.
function parseVideoId(url) {
  if (/^[\w-]{11}$/.test(url)) return url;
  try {
    const u = new URL(url);
    const v = u.searchParams.get('v');
    if (v) return v;
    const m = u.pathname.match(/^\/(?:live|embed|shorts|v)\/([\w-]{11})/) ||
      (u.hostname.endsWith('youtu.be') && u.pathname.match(/^\/([\w-]{11})/));
    if (m) return m[1];
  } catch {}
  return null;
}

function setStatus(tile, text) {
  tile.statusEl.textContent = text;
}

// Pantalla azul tipo VHS para canales sin señal o sin configurar.
function setNoSignal(tile, text) {
  tile.el.classList.toggle('nosignal', !!text);
  if (text) {
    tile.el.dataset.nosignal = text;
    setOffline(tile, true);
  }
}

// Un canal sin señal sale del mosaico hasta que vuelva a reproducir. No basta
// con la pantalla azul: cada reintento la quita mientras carga y la grilla
// saltaría cada 30 s.
function setOffline(tile, offline) {
  if (tile.offline === offline) return;
  tile.offline = offline;
  if (tiles.includes(tile)) layout();
}

// OSD verde de canal en la esquina superior derecha de la ventana.
function showChannelOsd(tile) {
  channelOsd.number.textContent = tile.number;
  channelOsd.name.textContent = tile.name;
  channelOsd.el.classList.toggle('muted', muted);
  channelOsd.el.hidden = false;
  clearTimeout(channelOsd.timer);
  channelOsd.timer = setTimeout(() => { channelOsd.el.hidden = true; }, CHANNEL_OSD_MS);
}

function applyAudio() {
  tiles.forEach((tile, i) => {
    const p = tile.player;
    if (!tile.ready) return;
    if (i === focusIndex && !muted) {
      p.unMute();
      p.setVolume(volume);
    } else {
      p.mute();
    }
  });
}

function setFocus(i) {
  focusIndex = i;
  tiles.forEach((tile, j) => {
    tile.el.classList.toggle('focused', j === focusIndex);
  });
  showChannelOsd(tiles[focusIndex]);
  applyAudio();
}

function createPlayer(tile) {
  clearTimeout(tile.retryTimer);
  if (tile.player) tile.player.destroy();
  tile.player = null;
  tile.ready = false;
  // Invalida una búsqueda de live pendiente de una carga anterior.
  const load = tile.load = {};
  tile.playerHost.replaceChildren();
  setNoSignal(tile, null);

  if (!tile.stream.url && !tile.stream.channel) {
    tile.player = null;
    setNoSignal(tile, 'SIN CANAL');
    setStatus(tile, '');
    return;
  }
  setStatus(tile, 'Cargando…');

  const playerVars = {
    autoplay: 1,
    controls: 0,
    playsinline: 1,
    rel: 0,
    disablekb: 1,
    iv_load_policy: 3,
    origin: location.origin,
  };
  const events = {
    onReady: () => {
      tile.ready = true;
      tile.player.playVideo();
      applyAudio();
    },
    onStateChange: (e) => onStateChange(tile, e.data),
    onError: (e) => {
      setNoSignal(tile, 'SIN SEÑAL');
      setStatus(tile, `Error ${e.data}`);
      // Un canal sin live activo puede volver a transmitir: reintentar.
      if (tile.stream.channel) tile.retryTimer = setTimeout(() => createPlayer(tile), ENDED_RETRY_MS);
    },
  };

  const mount = (videoId) => {
    const div = document.createElement('div');
    div.className = 'player';
    tile.playerHost.append(div);
    tile.player = new YT.Player(div, { videoId, playerVars, events });
  };

  if (tile.stream.channel) {
    // main busca el live actual del canal en cada carga, así un reintento
    // encuentra el live nuevo si el canal cambió de transmisión.
    window.livetv.findLive(tile.stream.channel)
      .then((videoId) => {
        if (tile.load !== load) return;
        if (videoId) {
          mount(videoId);
          return;
        }
        setNoSignal(tile, 'SIN SEÑAL');
        setStatus(tile, 'Sin live, reintentando…');
        tile.retryTimer = setTimeout(() => createPlayer(tile), ENDED_RETRY_MS);
      })
      .catch((err) => {
        if (tile.load !== load) return;
        console.warn(`No se pudo buscar el live de ${tile.stream.channel}:`, err);
        setNoSignal(tile, 'SIN SEÑAL');
        setStatus(tile, 'Reintentando…');
        tile.retryTimer = setTimeout(() => createPlayer(tile), ENDED_RETRY_MS);
      });
  } else {
    const videoId = parseVideoId(tile.stream.url || '');
    if (!videoId) {
      setNoSignal(tile, 'SIN SEÑAL');
      setStatus(tile, `URL inválida: ${tile.stream.url}`);
      return;
    }
    mount(videoId);
  }
}

function onStateChange(tile, state) {
  switch (state) {
    case YT.PlayerState.PLAYING:
      setStatus(tile, '');
      setNoSignal(tile, null);
      setOffline(tile, false);
      // YouTube arranca silenciado si el iframe aún no tenía activación de
      // usuario al hacer autoplay; reaplicar el audio ya reproduciendo.
      applyAudio();
      break;
    case YT.PlayerState.BUFFERING:
      setStatus(tile, 'Buffering…');
      break;
    case YT.PlayerState.PAUSED:
      // Sin controles, una pausa nunca es intencional: retomar.
      tile.player.playVideo();
      break;
    case YT.PlayerState.ENDED:
      setNoSignal(tile, 'SIN SEÑAL');
      setStatus(tile, 'Reintentando…');
      tile.retryTimer = setTimeout(() => createPlayer(tile), ENDED_RETRY_MS);
      break;
  }
}

function buildGrid(streams) {
  streams.forEach((stream, i) => {
    const el = document.createElement('div');
    el.className = 'tile';
    const playerHost = document.createElement('div');
    const statusEl = document.createElement('div');
    statusEl.className = 'status';
    const ring = document.createElement('div');
    ring.className = 'focus-ring';
    el.append(playerHost, statusEl, ring);
    grid.append(el);

    const name = stream.name || stream.url || stream.channel || 'Sin canal';
    el.dataset.channel = name;
    const number = `CH ${String(i + 1).padStart(2, '0')}`;
    const tile = { stream, name, number, el, playerHost, statusEl, player: null, ready: false, offline: false };
    el.addEventListener('click', () => setFocus(i));
    tiles.push(tile);
  });
  layout();
  tiles.forEach(createPlayer);
}

// Arma la grilla con los tiles visibles. Los ocultos no se destruyen: siguen
// reintentando fuera de pantalla y vuelven al mosaico al reproducir.
function layout() {
  visible = tiles.flatMap((tile, i) => (showOffline || !tile.offline ? [i] : []));
  // Si ningún canal tiene señal, mostrar todos en vez de una pantalla negra.
  if (!visible.length) visible = tiles.map((_, i) => i);
  tiles.forEach((tile, i) => tile.el.classList.toggle('offline', !visible.includes(i)));

  const n = visible.length;
  columns = configColumns || Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / columns);
  grid.style.gridTemplateColumns = `repeat(${columns}, 1fr)`;
  grid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;

  // Celdas sobrantes de la grilla: sin canal configurado.
  grid.querySelectorAll('.empty').forEach((el) => el.remove());
  for (let k = n; k < columns * rows; k++) {
    const el = document.createElement('div');
    el.className = 'tile nosignal empty';
    el.dataset.channel = `CH ${String(tiles.length + k - n + 1).padStart(2, '0')}`;
    el.dataset.nosignal = 'SIN CANAL';
    grid.append(el);
  }

  // Si el canal con foco salió del mosaico, pasar al siguiente visible.
  if (tiles[focusIndex]?.el.classList.contains('focused') && !visible.includes(focusIndex)) {
    setFocus(visible.find((i) => i > focusIndex) ?? visible[0]);
  }
}

function moveFocus(dx, dy) {
  const n = visible.length;
  const pos = visible.indexOf(focusIndex);
  if (dx) {
    setFocus(visible[(pos + dx + n) % n]);
    return;
  }
  const rows = Math.ceil(n / columns);
  const col = pos % columns;
  let row = Math.floor(pos / columns);
  // Avanza filas con wrap, saltando celdas vacías de la última fila.
  for (let k = 0; k < rows; k++) {
    row = (row + dy + rows) % rows;
    const target = row * columns + col;
    if (target < n) {
      setFocus(visible[target]);
      return;
    }
  }
}

function onKey(e) {
  if (!tiles.length) {
    if (e.key === 'q' || e.key === 'Escape') window.livetv.quit();
    return;
  }
  const tile = tiles[focusIndex];
  const zoomed = grid.classList.contains('zoomed');
  switch (e.key) {
    case 'ArrowLeft': case 'h': moveFocus(-1, 0); break;
    case 'ArrowRight': case 'l': moveFocus(1, 0); break;
    case 'ArrowUp': case 'k': moveFocus(0, -1); break;
    case 'ArrowDown': case 'j': moveFocus(0, 1); break;
    case 'Enter': case ' ':
      grid.classList.toggle('zoomed');
      break;
    case 'm':
      muted = !muted;
      applyAudio();
      showVolumeOsd();
      break;
    case '+': case '=':
      changeVolume(VOLUME_STEP);
      break;
    case '-':
      changeVolume(-VOLUME_STEP);
      break;
    case 'r': createPlayer(tile); break;
    case 's':
      showOffline = !showOffline;
      layout();
      break;
    case 'f': case 'F11': window.livetv.toggleFullscreen(); break;
    case '?': help.hidden = !help.hidden; break;
    case 'Escape':
      if (zoomed) grid.classList.remove('zoomed');
      else if (!help.hidden) help.hidden = true;
      else window.livetv.quit();
      break;
    case 'q': window.livetv.quit(); break;
    default:
      if (/^[1-9]$/.test(e.key) && visible.includes(Number(e.key) - 1)) setFocus(Number(e.key) - 1);
      else return;
  }
  e.preventDefault();
}

function changeVolume(delta) {
  volume = Math.max(0, Math.min(100, volume + delta));
  // Como en un televisor: subir o bajar el volumen quita el silencio.
  muted = false;
  applyAudio();
  showVolumeOsd();
}

// OSD verde de pantalla completa al estilo de los televisores Sony antiguos.
function showVolumeOsd() {
  const lit = Math.round((volume / 100) * OSD_SEGMENTS);
  osd.label.textContent = muted ? 'MUTE' : 'VOLUMEN';
  osd.value.textContent = muted ? '' : String(volume);
  osd.bar.replaceChildren(...Array.from({ length: OSD_SEGMENTS }, (_, k) => {
    const seg = document.createElement('span');
    if (k < lit && !muted) seg.className = 'on';
    return seg;
  }));
  osd.el.hidden = false;
  clearTimeout(osd.timer);
  osd.timer = setTimeout(() => { osd.el.hidden = true; }, OSD_MS);
}

function showMessage(text) {
  const el = document.getElementById('message');
  el.textContent = text;
  el.hidden = false;
}

async function main() {
  document.addEventListener('keydown', onKey);
  // Si un iframe llegara a tomar el foco, devolverlo al documento.
  window.addEventListener('blur', () => setTimeout(() => {
    if (document.activeElement?.tagName === 'IFRAME') document.activeElement.blur();
  }, 0));

  const config = await window.livetv.getConfig();
  if (config.error) {
    showMessage(config.error);
    return;
  }
  const streams = config.streams || [];
  if (!streams.length) {
    showMessage(`No hay streams en ${config.file}`);
    return;
  }
  await ytReady;
  configColumns = config.columns;
  buildGrid(streams);
  // Un canal puede quedar fuera del mosaico ya al crearse (URL inválida, sin canal).
  setFocus(visible[0]);
}

main();
