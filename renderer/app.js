const ENDED_RETRY_MS = 30000;
// Cada cuánto se buscan lives nuevos en los canales que ya están transmitiendo.
const LIVES_POLL_MS = 120000;
const CHANNEL_OSD_MS = 3000;
const CONFIRM_MS = 5000;
const VOLUME_STEP = 5;
const OSD_MS = 2500;
// El cursor se oculta tras este tiempo sin mover el mouse, como en un reproductor de video.
const CURSOR_IDLE_MS = 1000;
const ZOOM_MS = 900;
// Se aplica a la animación entera; los keyframes intermedios van en línea recta.
const ZOOM_EASING = 'cubic-bezier(.65, 0, .35, 1)';
// Keyframes muestreados a lo largo del recorrido.
const ZOOM_FRAMES = 24;
// A mitad de camino el tile crece hasta ZOOM_LIFT veces e inclina ZOOM_TILT grados.
const ZOOM_LIFT = 1.15;
const ZOOM_TILT = [10, 6];
const PERSPECTIVE = 'perspective(1200px)';
const MARKET_WS = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const MARKET_PING_MS = 10000;
const MARKET_RECONNECT_MS = 5000;
const MARKET_ROWS = 4;
// Como polymarket.com: con un spread mayor se muestra el último trade, no el punto medio.
const MARKET_MAX_SPREAD = 0.1;
// El embed de Windy muestra el pronóstico del momento en que cargó: se recarga cada hora.
const WINDY_RELOAD_MS = 3600000;
// Modelos de Windy que pueden aparecer en la URL de windy.com junto a la capa.
const WINDY_PRODUCTS = ['ecmwf', 'gfs', 'icon', 'iconEu', 'iconD2', 'nam', 'namConus', 'arome', 'ukv', 'hrrr', 'ecmwfWaves', 'gfsWaves', 'iconWaves', 'cams'];
const DAY_S = 86400;
const SVG_NS = 'http://www.w3.org/2000/svg';

const grid = document.getElementById('grid');
const help = document.getElementById('help');
const osd = {
  el: document.getElementById('osd'),
  label: document.querySelector('#osd .osd-label'),
  value: document.querySelector('#osd .osd-value'),
  fill: document.querySelector('#osd .progress-fill'),
  timer: null,
};
const channelOsd = {
  el: document.getElementById('osd-channel'),
  number: document.querySelector('#osd-channel .osd-number'),
  name: document.querySelector('#osd-channel .osd-name'),
  category: document.querySelector('#osd-channel .osd-category'),
  timer: null,
};
const menu = {
  el: document.getElementById('osd-menu'),
  list: document.querySelector('#osd-menu .osd-menu-list'),
};
const setupMenu = {
  el: document.getElementById('osd-setup'),
  list: document.querySelector('#osd-setup .osd-setup-list'),
};
// Filas del menú de ajustes; key es el nombre en settings.
const SETUP_ITEMS = [
  {
    key: 'leveler',
    label: 'Nivelar volumen',
    description: 'Comprime el audio para que los canales fuertes y los suaves suenen parecido',
  },
];
const addForm = {
  el: document.getElementById('osd-add'),
  source: document.querySelector('#osd-add [name=source]'),
  name: document.querySelector('#osd-add [name=name]'),
  category: document.querySelector('#osd-add .osd-field-category'),
  categoryName: document.querySelector('#osd-add .osd-add-category'),
  error: document.querySelector('#osd-add .osd-add-error'),
  // Categoría elegida (índice en categories).
  index: 0,
  saving: false,
};
const confirmOsd = {
  el: document.getElementById('osd-confirm'),
  title: document.querySelector('#osd-confirm .osd-confirm-title'),
  timer: null,
};
// Tile que espera confirmación para ocultarse (Shift+H).
let pendingHide = null;

const ytReady = new Promise((resolve) => {
  window.onYouTubeIframeAPIReady = resolve;
});

// Una entrada de la config por grupo; un canal con varios lives tiene un tile por live.
const groups = [];
// Todos los tiles, en el orden del mosaico (el mismo que en el DOM).
const tiles = [];
let focusIndex = 0;
let columns = 1;
let configColumns = null;
// Índices de los tiles en el mosaico, en orden; los canales sin señal quedan fuera.
let visible = [];
let showOffline = false;
// Canal ampliado a pantalla completa (Enter), y cierre de su animación en curso.
let zoomed = false;
let zoomEnd = null;
// Volumen y silencio son globales, como en un televisor: se mantienen al cambiar de canal.
let volume = 100;
let muted = false;
// Último tile de video enfocado. Un tile de Polymarket no tiene audio: con el
// foco en él sigue sonando este, en vez de quedar todo en silencio.
let audioTile = null;
// Categorías de la config; el mosaico muestra una a la vez.
let categories = [];
let categoryIndex = 0;
// Categoría resaltada en el menú (c), o null con el menú cerrado. Después de
// las categorías va "Agregar canal" (índice categories.length).
let menuIndex = null;
// Menú de ajustes (o): índice de la fila elegida, o null si está cerrado.
let setupIndex = null;
// Ajustes guardados por main.js en settings.json.
let settings = { leveler: true };
// Ocultos con Shift+H en cualquier categoría, hasta reiniciar: streams de la
// config (por streamKey) y lives de canales (por videoId).
const hiddenStreams = new Set();
const hiddenIds = new Set();

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

// Stream HLS directo (.m3u8), reproducido con un <video> en vez de YouTube.
function isHls(url) {
  try {
    return new URL(url).pathname.toLowerCase().endsWith('.m3u8');
  } catch {
    return false;
  }
}

// Visualización de windy.com. windy.com no se deja embeber (frame-ancestors),
// así que su URL (?capa,lat,lon,zoom; /lat/lon marca un punto con detalle) se
// traduce al widget de embed.windy.com. Una URL de embed.windy.com va tal cual.
function windyEmbedUrl(value) {
  let u;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  if (u.hostname === 'embed.windy.com') return value;
  if (!/(^|\.)windy\.com$/.test(u.hostname)) return null;
  const tokens = decodeURIComponent(u.search.slice(1)).split(',');
  const numbers = tokens.filter((t) => /^-?\d+(\.\d+)?$/.test(t)).map(Number);
  const words = tokens.filter((t) => /^[a-zA-Z]\w*$/.test(t));
  const point = u.pathname.match(/^\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)/);
  const [lat, lon, zoom] = numbers.length >= 2 ? numbers : point ? [Number(point[1]), Number(point[2]), 8] : [];
  if (lat === undefined) return null;
  const params = new URLSearchParams({
    type: 'map',
    location: 'coordinates',
    metricRain: 'default',
    metricTemp: 'default',
    metricWind: 'default',
    zoom: String(zoom ?? 5),
    overlay: words.find((w) => !WINDY_PRODUCTS.includes(w)) || 'wind',
    product: words.find((w) => WINDY_PRODUCTS.includes(w)) || 'ecmwf',
    level: 'surface',
    lat: String(lat),
    lon: String(lon),
  });
  if (point) {
    params.set('detailLat', point[1]);
    params.set('detailLon', point[2]);
    params.set('detail', 'true');
    params.set('marker', 'true');
  }
  return `https://embed.windy.com/embed.html?${params}`;
}

// Polymarket y Windy no tienen audio: con el foco en ellos sigue sonando el último video.
function isSilent(stream) {
  return !!(stream.polymarket || stream.windy);
}

// Identifica un stream de la config entre categorías (el mismo canal puede estar en varias).
function streamKey(stream) {
  return stream.url || stream.channel || stream.polymarket || stream.windy || null;
}

// Lo escrito en "Agregar canal": handle o ID de canal, URL de canal o video de
// YouTube, URL .m3u8, URL de un evento de Polymarket o de windy.com. null si no se reconoce.
function parseStreamInput(text) {
  const value = text.trim();
  if (/^@?[\w.-]+$/.test(value)) return { channel: value };
  let u;
  try {
    u = new URL(value);
  } catch {
    return null;
  }
  if (/(^|\.)polymarket\.com$/.test(u.hostname) && u.pathname.startsWith('/event/')) return { polymarket: value };
  if (windyEmbedUrl(value)) return { windy: value };
  if (isHls(value)) return { url: value };
  if (/(^|\.)(youtube\.com|youtu\.be)$/.test(u.hostname)) {
    if (parseVideoId(value)) return { url: value };
    if (/^\/(@[^/]+|channel\/UC[\w-]{22}|c\/[^/]+|user\/[^/]+)/.test(u.pathname)) return { channel: value };
  }
  return null;
}

function setStatus(tile, text) {
  tile.statusEl.textContent = text;
}

// Pantalla de sin señal para canales caídos o sin configurar.
function setNoSignal(tile, text) {
  tile.el.classList.toggle('nosignal', !!text);
  if (text) {
    tile.el.dataset.nosignal = text;
    setOffline(tile, true);
  }
}

// Un canal sin señal sale del mosaico hasta que vuelva a reproducir. No basta
// con la pantalla de sin señal: cada reintento la quita mientras carga y la grilla
// saltaría cada 30 s.
function setOffline(tile, offline) {
  if (tile.offline === offline) return;
  tile.offline = offline;
  if (tiles.includes(tile)) layout();
}

// OSD de canal en la esquina superior derecha de la ventana.
function showChannelOsd(tile) {
  channelOsd.number.textContent = tile.number;
  channelOsd.name.textContent = tile.name;
  channelOsd.category.textContent = categories.length > 1 ? categories[categoryIndex].name : '';
  channelOsd.el.classList.toggle('muted', muted);
  channelOsd.el.hidden = false;
  clearTimeout(channelOsd.timer);
  channelOsd.timer = setTimeout(() => { channelOsd.el.hidden = true; }, CHANNEL_OSD_MS);
}

// Tile que suena: el enfocado o, si no tiene audio, el último video enfocado.
// Si ese ya no está en el mosaico (oculto con Shift+H, cerrado o sin señal),
// el video visible más cercano antes del foco. Al cerrar un live extra el
// foco pasa un momento por el tile fijo del canal, que suele estar sin señal.
function audioSource() {
  const focused = tiles[focusIndex];
  if (focused && !isSilent(focused.stream)) return focused;
  if (!visible.includes(tiles.indexOf(audioTile))) {
    const videos = visible.map((i) => tiles[i]).filter((t) => !isSilent(t.stream));
    audioTile = videos.filter((t) => tiles.indexOf(t) < focusIndex).pop() || videos[0] || null;
  }
  return audioTile;
}

function applyAudio() {
  const source = audioSource();
  tiles.forEach((tile) => {
    const p = tile.player;
    if (!tile.ready) return;
    if (tile === source && !muted) {
      p.unMute();
      p.setVolume(volume);
    } else {
      p.mute();
    }
  });
}

function setFocus(i) {
  focusIndex = i;
  if (!isSilent(tiles[i].stream)) audioTile = tiles[i];
  tiles.forEach((tile, j) => {
    tile.el.classList.toggle('focused', j === focusIndex);
  });
  showChannelOsd(tiles[focusIndex]);
  applyAudio();
}

function createPlayer(tile) {
  clearTimeout(tile.retryTimer);
  if (tile.player) tile.player.destroy();
  closeMarket(tile);
  tile.player = null;
  tile.ready = false;
  tile.failed = false;
  tile.playerHost.replaceChildren();
  setNoSignal(tile, null);

  const { stream } = tile;
  if (stream.polymarket) {
    createMarket(tile);
    return;
  }
  if (stream.windy) {
    createWindy(tile);
    return;
  }
  if (stream.url && isHls(stream.url)) {
    createVideo(tile);
    return;
  }
  if (!stream.url && !stream.channel) {
    setNoSignal(tile, 'Sin canal');
    setStatus(tile, '');
    return;
  }
  // El live de un tile de canal lo asigna syncLives().
  const videoId = stream.channel ? tile.videoId : parseVideoId(stream.url || '');
  if (!videoId) {
    setNoSignal(tile, 'Sin señal');
    setStatus(tile, stream.channel ? 'Sin live, reintentando…' : `URL inválida: ${stream.url}`);
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
      setNoSignal(tile, 'Sin señal');
      setStatus(tile, `Error ${e.data}`);
      // Un canal sin live activo puede volver a transmitir: reintentar.
      if (stream.channel) markFailed(tile);
    },
  };
  const div = document.createElement('div');
  div.className = 'player';
  tile.playerHost.append(div);
  tile.player = new YT.Player(div, { videoId, playerVars, events });
}

// Tile de un stream HLS: un <video> con hls.js. tile.player es un adaptador
// con la misma interfaz que usan applyAudio y destroy() del YT.Player.
function createVideo(tile) {
  const video = document.createElement('video');
  video.className = 'player';
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;
  tile.playerHost.append(video);
  setStatus(tile, 'Cargando…');

  let hls = null;
  // Tras destroy(), o con el tile cerrado u oculto, los eventos del video ya no cuentan.
  const alive = () => tile.player === player && video.isConnected;
  const fail = (text) => {
    if (!alive()) return;
    setNoSignal(tile, 'Sin señal');
    setStatus(tile, text);
    clearTimeout(tile.retryTimer);
    tile.retryTimer = setTimeout(() => createPlayer(tile), ENDED_RETRY_MS);
  };
  const player = {
    mute: () => { video.muted = true; },
    unMute: () => { video.muted = false; },
    setVolume: (v) => { video.volume = v / 100; },
    destroy: () => {
      if (hls) hls.destroy();
      video.removeAttribute('src');
      video.load();
    },
  };
  tile.player = player;
  tile.ready = true;

  video.addEventListener('playing', () => {
    setStatus(tile, '');
    setNoSignal(tile, null);
    setOffline(tile, false);
  });
  video.addEventListener('waiting', () => setStatus(tile, 'Buffering…'));
  // Sin controles, una pausa nunca es intencional: retomar.
  video.addEventListener('pause', () => {
    if (alive() && !video.ended) video.play().catch(() => {});
  });
  video.addEventListener('ended', () => fail('Reintentando…'));
  video.addEventListener('error', () => fail(`Error ${video.error?.code ?? ''}`.trim()));

  const url = tile.stream.url;
  if (window.Hls?.isSupported()) {
    hls = new Hls();
    let recovered = false;
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal) return;
      // Un error de decodificación suele recuperarse sin recargar el stream.
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !recovered) {
        recovered = true;
        hls.recoverMediaError();
        return;
      }
      fail(`Error ${data.details}`);
    });
    hls.loadSource(url);
    hls.attachMedia(video);
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = url;
  } else {
    fail('HLS no soportado');
    return;
  }
  video.play().catch(() => {});
  applyAudio();
}

// El live del tile terminó o falló: syncLives() lo reintenta, le asigna otro
// live o, si es un live extra que ya no está, cierra el tile.
function markFailed(tile) {
  tile.failed = true;
  clearTimeout(tile.group.timer);
  tile.group.timer = setTimeout(() => syncLives(tile.group), ENDED_RETRY_MS);
}

// main busca los lives actuales del canal y se reparten uno por tile: el
// primero queda en el tile fijo del canal y cada live extra abre un tile propio.
// Solo se cambia o cierra un tile cuyo reproductor terminó o falló, así un
// scrape incompleto de YouTube no corta un live que sigue reproduciendo.
function syncLives(group) {
  clearTimeout(group.timer);
  const sync = group.sync = {};
  const [primary] = group.tiles;
  window.livetv.findLives(group.stream.channel)
    .then((lives) => {
      if (group.sync !== sync) return;
      const ids = lives.map((l) => l.id);
      const shown = (id) => group.tiles.some((t) => t.videoId === id);
      group.tiles.slice(1).filter((t) => t.failed && !ids.includes(t.videoId)).forEach(removeTile);
      if (!primary.hidden && (!primary.videoId || (primary.failed && !ids.includes(primary.videoId)))) {
        primary.videoId = ids.find((id) => !shown(id)) || null;
        createPlayer(primary);
      }
      group.tiles.filter((t) => t.failed && !t.hidden).forEach(createPlayer);
      const max = group.stream.max || Infinity;
      lives.filter((l) => !shown(l.id) && !hiddenIds.has(l.id))
        .slice(0, max - group.tiles.length).forEach((l) => addTile(group, l));
    })
    .catch((err) => {
      if (group.sync !== sync) return;
      console.warn(`No se pudo buscar el live de ${group.stream.channel}:`, err);
      if (!primary.player && !primary.hidden) {
        setNoSignal(primary, 'Sin señal');
        setStatus(primary, 'Reintentando…');
      }
    })
    .finally(() => {
      if (group.sync !== sync) return;
      const retry = group.tiles.some((t) => !t.hidden && (t.failed || !t.videoId));
      group.timer = setTimeout(() => syncLives(group), retry ? ENDED_RETRY_MS : LIVES_POLL_MS);
    });
}

// Tile de Windy: el iframe del widget, sin player (tile.ready queda false y
// applyAudio lo ignora). Se recarga cada WINDY_RELOAD_MS con createPlayer.
function createWindy(tile) {
  const src = windyEmbedUrl(tile.stream.windy);
  if (!src) {
    setNoSignal(tile, 'Sin señal');
    setStatus(tile, `URL inválida: ${tile.stream.windy}`);
    return;
  }
  const frame = document.createElement('iframe');
  frame.src = src;
  frame.addEventListener('load', () => setStatus(tile, ''));
  tile.playerHost.append(frame);
  setStatus(tile, 'Cargando…');
  tile.retryTimer = setTimeout(() => createPlayer(tile), WINDY_RELOAD_MS);
}

// Tile de Polymarket: no tiene reproductor, muestra la probabilidad de cada
// outcome con su sparkline del día. Los precios llegan por el WebSocket del
// CLOB; el evento completo se vuelve a pedir cada LIVES_POLL_MS para rearmar
// los rows (mercados cerrados, cambios de orden) y detectar que se resolvió.
function createMarket(tile) {
  const market = tile.market = { rows: [], ws: null, timer: null, ping: null, reconnect: null, loaded: false };
  setStatus(tile, 'Cargando…');
  loadMarket(tile, market);
}

function loadMarket(tile, market) {
  const { stream } = tile;
  window.livetv.findMarket(stream.polymarket)
    .then(async (data) => {
      const rows = data.rows.slice(0, stream.outcomes || MARKET_ROWS);
      const histories = await Promise.all(rows.map((r) => window.livetv.priceHistory(r.tokenId).catch(() => [])));
      if (tile.market !== market) return;
      market.loaded = true;
      stopMarketSocket(market);
      market.rows = rows.map((r, k) => ({ ...r, bid: null, ask: null, last: null, history: histories[k] }));
      renderMarket(tile, market, data);
      setStatus(tile, '');
      setNoSignal(tile, null);
      setOffline(tile, false);
      if (data.closed) return;
      connectMarket(tile, market);
      market.timer = setTimeout(() => loadMarket(tile, market), LIVES_POLL_MS);
    })
    .catch((err) => {
      if (tile.market !== market) return;
      console.warn(`No se pudo leer el mercado ${stream.polymarket}:`, err);
      // Con datos ya en pantalla se siguen mostrando; el WebSocket sigue vivo.
      if (!market.loaded) {
        setNoSignal(tile, 'Sin señal');
        setStatus(tile, 'Reintentando…');
      }
      market.timer = setTimeout(() => loadMarket(tile, market), ENDED_RETRY_MS);
    });
}

function closeMarket(tile) {
  const { market } = tile;
  if (!market) return;
  tile.market = null;
  clearTimeout(market.timer);
  stopMarketSocket(market);
}

function stopMarketSocket(market) {
  const { ws } = market;
  market.ws = null;
  clearInterval(market.ping);
  clearTimeout(market.reconnect);
  if (ws) ws.close();
}

function connectMarket(tile, market) {
  const ws = market.ws = new WebSocket(MARKET_WS);
  ws.onopen = () => {
    ws.send(JSON.stringify({ assets_ids: market.rows.map((r) => r.tokenId), type: 'market' }));
    market.ping = setInterval(() => ws.send('PING'), MARKET_PING_MS);
  };
  ws.onmessage = (e) => {
    let msgs;
    try {
      msgs = [].concat(JSON.parse(e.data));
    } catch {
      return; // PONG
    }
    msgs.forEach((m) => onMarketMessage(market, m));
  };
  ws.onclose = () => {
    if (market.ws !== ws) return;
    clearInterval(market.ping);
    market.reconnect = setTimeout(() => connectMarket(tile, market), MARKET_RECONNECT_MS);
  };
}

function onMarketMessage(market, msg) {
  const row = (id) => market.rows.find((r) => r.tokenId === id);
  const best = (levels, pick) => (levels?.length ? pick(...levels.map((l) => Number(l.price))) : null);
  switch (msg.event_type) {
    case 'book': {
      const r = row(msg.asset_id);
      if (!r) return;
      r.bid = best(msg.bids, Math.max);
      r.ask = best(msg.asks, Math.min);
      updateRow(market, r);
      break;
    }
    case 'price_change':
      (msg.price_changes || []).forEach((c) => {
        const r = row(c.asset_id);
        if (!r) return;
        r.bid = c.best_bid != null ? Number(c.best_bid) : r.bid;
        r.ask = c.best_ask != null ? Number(c.best_ask) : r.ask;
        updateRow(market, r);
      });
      break;
    case 'last_trade_price': {
      const r = row(msg.asset_id);
      if (!r) return;
      r.last = Number(msg.price);
      updateRow(market, r);
      break;
    }
  }
}

// Precio que muestra polymarket.com: punto medio del libro, o el último trade
// si el spread es muy amplio.
function updateRow(market, row) {
  const mid = row.bid != null && row.ask != null && row.ask - row.bid <= MARKET_MAX_SPREAD
    ? (row.bid + row.ask) / 2 : null;
  const price = mid ?? row.last;
  if (price == null || price === row.price) return;
  row.price = price;
  const t = Date.now() / 1000;
  const lastPoint = row.history[row.history.length - 1];
  // Un punto por minuto basta para el sparkline.
  if (lastPoint && t - lastPoint.t < 60) lastPoint.p = price;
  else row.history.push({ t, p: price });
  renderRow(row);
  market.footer.textContent = `EN VIVO · ${new Date().toLocaleTimeString('es-CL')}`;
}

function renderMarket(tile, market, data) {
  const root = document.createElement('div');
  root.className = 'market';
  root.style.setProperty('--rows', market.rows.length);
  const title = document.createElement('div');
  title.className = 'market-title';
  title.textContent = data.title;
  const list = document.createElement('div');
  list.className = 'market-rows';
  market.rows.forEach((row) => {
    const el = document.createElement('div');
    el.className = 'market-row';
    const label = document.createElement('span');
    label.className = 'market-label';
    label.textContent = row.label;
    row.pctEl = document.createElement('span');
    row.pctEl.className = 'market-pct';
    row.deltaEl = document.createElement('span');
    row.deltaEl.className = 'market-delta';
    const bar = document.createElement('div');
    bar.className = 'market-bar';
    row.barEl = document.createElement('span');
    bar.append(row.barEl);
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'market-spark');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('preserveAspectRatio', 'none');
    row.lineEl = document.createElementNS(SVG_NS, 'polyline');
    row.lineEl.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.append(row.lineEl);
    el.append(label, row.pctEl, row.deltaEl, bar, svg);
    list.append(el);
    renderRow(row);
  });
  market.footer = document.createElement('div');
  market.footer.className = 'market-footer';
  market.footer.textContent = data.closed ? 'RESULTADO FINAL' : `EN VIVO · ${new Date().toLocaleTimeString('es-CL')}`;
  root.append(title, list, market.footer);
  tile.playerHost.replaceChildren(root);
}

function renderRow(row) {
  const { price, history } = row;
  row.pctEl.textContent = `${Math.round(price * 100)}%`;
  row.barEl.style.width = `${price * 100}%`;
  // Variación del día en puntos porcentuales.
  const delta = history.length ? (price - history[0].p) * 100 : 0;
  row.deltaEl.textContent = Math.abs(delta) < 0.05 ? '' : `${delta > 0 ? '▲' : '▼'} ${Math.abs(delta).toFixed(1)}`;
  row.deltaEl.classList.toggle('up', delta > 0);
  row.deltaEl.classList.toggle('down', delta < 0);
  // Eje Y fijo de 0 a 100 % para que los rows se puedan comparar.
  const end = Date.now() / 1000;
  row.lineEl.setAttribute('points', history
    .filter((h) => h.t >= end - DAY_S)
    .map((h) => `${(100 - (end - h.t) / DAY_S * 100).toFixed(2)},${(100 - h.p * 100).toFixed(2)}`)
    .join(' '));
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
      setNoSignal(tile, 'Sin señal');
      setStatus(tile, 'Reintentando…');
      if (tile.stream.channel) markFailed(tile);
      else tile.retryTimer = setTimeout(() => createPlayer(tile), ENDED_RETRY_MS);
      break;
  }
}

function makeTile(group) {
  const el = document.createElement('div');
  el.className = 'tile';
  const playerHost = document.createElement('div');
  const statusEl = document.createElement('div');
  statusEl.className = 'status';
  const ring = document.createElement('div');
  ring.className = 'focus-ring';
  el.append(playerHost, statusEl, ring);
  const tile = {
    group, stream: group.stream, el, playerHost, statusEl,
    player: null, market: null, ready: false, offline: false, failed: false, hidden: false, videoId: null, title: '',
  };
  el.addEventListener('click', () => setFocus(tiles.indexOf(tile)));
  return tile;
}

// Los lives extra de un canal se numeran CH 07-2, CH 07-3… y llevan el título del live.
function renumber(group) {
  group.tiles.forEach((tile, k) => {
    tile.number = `CH ${String(group.index + 1).padStart(2, '0')}${k ? `-${k + 1}` : ''}`;
    tile.name = k && tile.title ? `${group.name}: ${tile.title}` : group.name;
    tile.el.dataset.channel = tile.name;
  });
}

// Abre un tile para un live extra, junto a los demás tiles del canal. Queda
// fuera del mosaico hasta reproducir, como un canal que se reintenta.
function addTile(group, live) {
  const focused = tiles[focusIndex];
  const last = group.tiles[group.tiles.length - 1];
  const tile = makeTile(group);
  tile.videoId = live.id;
  tile.title = live.title;
  tile.offline = true;
  last.el.after(tile.el);
  tiles.splice(tiles.indexOf(last) + 1, 0, tile);
  group.tiles.push(tile);
  focusIndex = tiles.indexOf(focused);
  renumber(group);
  layout();
  createPlayer(tile);
}

function removeTile(tile) {
  const focused = tiles[focusIndex];
  const { group } = tile;
  clearTimeout(tile.retryTimer);
  if (tile.player) tile.player.destroy();
  closeMarket(tile);
  tile.el.remove();
  tiles.splice(tiles.indexOf(tile), 1);
  group.tiles.splice(group.tiles.indexOf(tile), 1);
  renumber(group);
  if (focused === tile) setFocus(tiles.indexOf(group.tiles[0]));
  else focusIndex = tiles.indexOf(focused);
  layout();
}

// Oculta un stream hasta reiniciar la app y cierra su reproductor. Un live
// extra cierra su tile; el tile fijo de un canal queda oculto sin player, y
// los demás lives del canal siguen apareciendo como tiles extra.
function hideTile(tile) {
  const { group } = tile;
  if (tile.videoId) hiddenIds.add(tile.videoId);
  if (tile !== group.tiles[0]) {
    removeTile(tile);
    return;
  }
  const key = streamKey(tile.stream);
  if (key) hiddenStreams.add(key);
  clearTimeout(tile.retryTimer);
  if (tile.player) tile.player.destroy();
  closeMarket(tile);
  tile.player = null;
  tile.ready = false;
  tile.hidden = true;
  tile.playerHost.replaceChildren();
  layout();
}

function askHide(tile) {
  // No se oculta el último stream: el mosaico quedaría vacío.
  if (tiles.filter((t) => !t.hidden).length <= 1) return;
  pendingHide = tile;
  confirmOsd.title.textContent = `¿Ocultar ${tile.name}?`;
  confirmOsd.el.hidden = false;
  clearTimeout(confirmOsd.timer);
  confirmOsd.timer = setTimeout(() => closeConfirm(), CONFIRM_MS);
}

function closeConfirm() {
  pendingHide = null;
  confirmOsd.el.hidden = true;
  clearTimeout(confirmOsd.timer);
}

function buildGrid(streams) {
  // Si en otra categoría se ocultaron todos los streams de esta, se muestran
  // igual: el mosaico no puede quedar vacío.
  const hide = (stream) => hiddenStreams.has(streamKey(stream)) &&
    !streams.every((s) => hiddenStreams.has(streamKey(s)));
  streams.forEach((stream) => addGroup(stream, hide(stream)));
  layout();
  groups.forEach(startGroup);
}

// Agrega al final del mosaico el tile fijo de un stream de la config. No
// arranca el player: falta layout() y startGroup().
function addGroup(stream, hidden) {
  const name = stream.name || streamKey(stream) || 'Sin canal';
  const group = { stream, index: groups.length, name, tiles: [], timer: null, sync: null };
  const tile = makeTile(group);
  tile.hidden = hidden;
  group.tiles.push(tile);
  groups.push(group);
  tiles.push(tile);
  grid.append(tile.el);
  renumber(group);
  return group;
}

function startGroup(group) {
  if (!group.stream.channel) {
    if (!group.tiles[0].hidden) createPlayer(group.tiles[0]);
    return;
  }
  setStatus(group.tiles[0], 'Cargando…');
  syncLives(group);
}

// Cierra los tiles de la categoría actual (players, mercados y timers) y abre
// los de la categoría i. Las demás categorías no quedan reproduciendo.
function showCategory(i) {
  zoomEnd?.();
  zoomed = false;
  grid.classList.remove('zoomed');
  closeConfirm();
  groups.forEach((group) => {
    clearTimeout(group.timer);
    group.sync = null;
  });
  tiles.forEach((tile) => {
    clearTimeout(tile.retryTimer);
    if (tile.player) tile.player.destroy();
    closeMarket(tile);
  });
  groups.length = 0;
  tiles.length = 0;
  visible = [];
  focusIndex = 0;
  audioTile = null;
  grid.replaceChildren();

  categoryIndex = i;
  configColumns = categories[i].columns;
  buildGrid(categories[i].streams);
  // Un canal puede quedar fuera del mosaico ya al crearse (URL inválida, sin canal).
  setFocus(visible[0]);
}

function stepCategory(delta) {
  const n = categories.length;
  if (n > 1) showCategory((categoryIndex + delta + n) % n);
}

// Menú OSD de categorías (c): ↑↓ para elegir, Enter o el número para abrirla.
function openMenu() {
  menuIndex = categoryIndex;
  renderMenu();
  menu.el.hidden = false;
}

function closeMenu() {
  menuIndex = null;
  menu.el.hidden = true;
}

// Íconos de Lucide para las acciones al final del menú.
const ICON_PLUS = '<path d="M5 12h14"/><path d="M12 5v14"/>';
const ICON_SLIDERS = '<path d="M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4"/>';

// Acciones al final del menú de categorías, después de las categorías.
const MENU_ACTIONS = [
  { icon: ICON_PLUS, name: 'Agregar canal', run: () => openAddForm() },
  { icon: ICON_SLIDERS, name: 'Ajustes', run: () => openSetup() },
];

function renderMenu() {
  const item = (key, name) => {
    const li = document.createElement('li');
    const keyEl = document.createElement('span');
    const nameEl = document.createElement('span');
    keyEl.className = 'osd-menu-key';
    keyEl.textContent = key;
    nameEl.className = 'osd-menu-name';
    nameEl.textContent = name;
    li.append(keyEl, nameEl);
    return li;
  };
  const actions = MENU_ACTIONS.map((action, k) => {
    const li = item('', action.name);
    li.className = k ? 'action next' : 'action';
    li.firstChild.innerHTML = `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${action.icon}</svg>`;
    return li;
  });
  menu.list.replaceChildren(...categories.map((category, k) => {
    const li = item(k < 9 ? String(k + 1) : '', category.name);
    li.classList.toggle('current', k === categoryIndex);
    return li;
  }), ...actions);
  menu.list.children[menuIndex].classList.add('selected');
}

function pickCategory(i) {
  closeMenu();
  if (i !== categoryIndex) showCategory(i);
}

// Con el menú abierto las demás teclas no hacen nada, como en un televisor.
function onMenuKey(e) {
  const n = categories.length + MENU_ACTIONS.length;
  switch (e.key) {
    case 'ArrowUp': case 'k':
      menuIndex = (menuIndex - 1 + n) % n;
      renderMenu();
      break;
    case 'ArrowDown': case 'j':
      menuIndex = (menuIndex + 1) % n;
      renderMenu();
      break;
    case 'Enter': case ' ':
      if (menuIndex >= categories.length) MENU_ACTIONS[menuIndex - categories.length].run();
      else pickCategory(menuIndex);
      break;
    case 'a': openAddForm(); break;
    case 'o': openSetup(); break;
    case 'c': case 'Escape': closeMenu(); break;
    default:
      if (/^[1-9]$/.test(e.key) && Number(e.key) <= categories.length) pickCategory(Number(e.key) - 1);
  }
  e.preventDefault();
}

// Menú de ajustes (o, o desde el menú de categorías): ↑↓ para elegir, Enter
// para cambiar. Cada cambio se guarda al momento.
function openSetup() {
  closeMenu();
  setupIndex = 0;
  renderSetup();
  setupMenu.el.hidden = false;
}

function closeSetup() {
  setupIndex = null;
  setupMenu.el.hidden = true;
}

function renderSetup() {
  setupMenu.list.replaceChildren(...SETUP_ITEMS.map((item, k) => {
    const li = document.createElement('li');
    const text = document.createElement('div');
    const label = document.createElement('div');
    const description = document.createElement('div');
    const toggle = document.createElement('span');
    text.className = 'osd-setup-text';
    label.textContent = item.label;
    description.className = 'osd-setup-description';
    description.textContent = item.description;
    toggle.className = settings[item.key] ? 'switch on' : 'switch';
    text.append(label, description);
    li.append(text, toggle);
    li.classList.toggle('selected', k === setupIndex);
    return li;
  }));
}

function onSetupKey(e) {
  const n = SETUP_ITEMS.length;
  switch (e.key) {
    case 'ArrowUp': case 'k':
      setupIndex = (setupIndex - 1 + n) % n;
      renderSetup();
      break;
    case 'ArrowDown': case 'j':
      setupIndex = (setupIndex + 1) % n;
      renderSetup();
      break;
    case 'Enter': case ' ': {
      const { key } = SETUP_ITEMS[setupIndex];
      changeSettings({ [key]: !settings[key] });
      break;
    }
    case 'o': case 'Escape': closeSetup(); break;
  }
  e.preventDefault();
}

// Aplica los ajustes aquí (los videos HLS del renderer) y los guarda; main.js
// los aplica en los iframes de YouTube.
async function changeSettings(changes) {
  settings = { ...settings, ...changes };
  window.livetvLeveler(settings.leveler);
  renderSetup();
  settings = await window.livetv.setSettings(changes);
}

// Formulario "Agregar canal" (desde el menú de categorías). El stream se
// guarda en el archivo de config y se abre al final de su categoría.
function openAddForm() {
  closeMenu();
  addForm.index = categoryIndex;
  addForm.source.value = '';
  addForm.name.value = '';
  addForm.error.textContent = '';
  renderAddCategory();
  addForm.el.hidden = false;
  addForm.source.focus();
}

function closeAddForm() {
  addForm.el.hidden = true;
  document.activeElement?.blur();
}

function renderAddCategory() {
  addForm.categoryName.textContent = categories[addForm.index].name;
}

// Las teclas que no son del formulario quedan para los campos de texto.
function onAddKey(e) {
  const fields = [addForm.source, addForm.name, addForm.category];
  const pos = fields.indexOf(document.activeElement);
  switch (e.key) {
    case 'Escape': closeAddForm(); break;
    case 'Enter': saveAddForm(); break;
    case 'ArrowUp': case 'ArrowDown': case 'Tab': {
      const d = e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey) ? -1 : 1;
      fields[(Math.max(pos, 0) + d + fields.length) % fields.length].focus();
      break;
    }
    case 'ArrowLeft': case 'ArrowRight': {
      if (pos !== 2) return;
      const n = categories.length;
      addForm.index = (addForm.index + (e.key === 'ArrowLeft' ? -1 : 1) + n) % n;
      renderAddCategory();
      break;
    }
    default: return;
  }
  e.preventDefault();
}

async function saveAddForm() {
  if (addForm.saving) return;
  const parsed = parseStreamInput(addForm.source.value);
  if (!parsed) {
    addForm.error.textContent = 'No se reconoce el canal';
    return;
  }
  const category = categories[addForm.index];
  const key = streamKey(parsed);
  if (category.streams.some((s) => streamKey(s) === key)) {
    addForm.error.textContent = `Ya está en ${category.name}`;
    return;
  }
  const name = addForm.name.value.trim();
  addForm.saving = true;
  addForm.error.textContent = 'Guardando…';
  addForm.error.classList.add('busy');
  let stream;
  try {
    stream = await window.livetv.addStream({
      category: category.index,
      categoryName: category.configName,
      stream: name ? { name, ...parsed } : parsed,
    });
  } catch (err) {
    addForm.error.textContent = err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    return;
  } finally {
    addForm.saving = false;
    addForm.error.classList.remove('busy');
  }
  addForm.error.textContent = '';
  closeAddForm();
  category.streams.push(stream);
  // Volver a agregar un stream oculto con Shift+H lo muestra de nuevo.
  hiddenStreams.delete(key);
  if (addForm.index === categoryIndex) {
    const group = addGroup(stream, false);
    layout();
    startGroup(group);
  } else {
    showCategory(addForm.index);
  }
  setFocus(tiles.indexOf(groups.find((g) => g.stream === stream).tiles[0]));
}

// Arma la grilla con los tiles visibles. Los ocultos no se destruyen: siguen
// reintentando fuera de pantalla y vuelven al mosaico al reproducir.
function layout() {
  const shown = (tile) => !tile.hidden && (showOffline || !tile.offline);
  visible = tiles.flatMap((tile, i) => (shown(tile) ? [i] : []));
  // Si ningún canal tiene señal, mostrar todos en vez de una pantalla negra.
  if (!visible.length) visible = tiles.flatMap((tile, i) => (tile.hidden ? [] : [i]));
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
    el.dataset.channel = `CH ${String(groups.length + k - n + 1).padStart(2, '0')}`;
    el.dataset.nosignal = 'Sin canal';
    grid.append(el);
  }

  // Si el canal con foco salió del mosaico, pasar al siguiente visible.
  if (tiles[focusIndex]?.el.classList.contains('focused') && !visible.includes(focusIndex)) {
    setFocus(visible.find((i) => i > focusIndex) ?? visible[0]);
  }
}

// Amplía o reduce el tile enfocado en un solo movimiento continuo: viaja de
// su celda a la pantalla completa mientras se despega del mosaico (crece algo
// más e inclina hacia el centro, con el máximo a mitad de camino) y el resto se
// desenfoca, oscurece y se aleja. Es un FLIP: el tile ya está en pantalla
// completa (el iframe con su tamaño final) y se anima su transform desde la
// celda. El recorrido se muestrea en ZOOM_FRAMES keyframes lineales y la easing
// se aplica a la animación entera, así no frena en ningún punto intermedio. Se
// animan los tiles y no #grid: un ancestro con transform rompería el
// position: fixed del tile ampliado.
function setZoom(on) {
  zoomEnd?.();
  if (on === zoomed) return;
  zoomed = on;
  const tile = tiles[focusIndex];
  grid.classList.remove('zoomed');
  const r = tile.el.getBoundingClientRect();
  const W = window.innerWidth;
  const H = window.innerHeight;
  const dx = r.left + r.width / 2 - W / 2;
  const dy = r.top + r.height / 2 - H / 2;
  const sx = r.width / W;
  const sy = r.height / H;
  const tiltY = (Math.sign(dx) || 1) * -ZOOM_TILT[0];
  const tiltX = (Math.sign(dy) || 1) * ZOOM_TILT[1];
  // p va de 0 (celda) a 1 (pantalla completa); lift sube y baja con máximo en 0.5.
  const tileFrame = (p) => {
    const lift = Math.sin(Math.PI * p);
    const grow = 1 + (ZOOM_LIFT - 1) * lift;
    const glow = 0.35 * lift;
    const shade = 0.9 * lift;
    return {
      transform: `${PERSPECTIVE} translate(${dx * (1 - p)}px, ${dy * (1 - p)}px) ` +
        `scale(${(sx + (1 - sx) * p) * grow}, ${(sy + (1 - sy) * p) * grow}) ` +
        `rotateY(${tiltY * lift}deg) rotateX(${tiltX * lift}deg)`,
      boxShadow: `0 0 ${60 * lift}px rgba(60, 255, 60, ${glow}), 0 ${30 * lift}px ${80 * lift}px rgba(0, 0, 0, ${shade})`,
    };
  };
  const otherFrame = (p) => ({
    transform: `${PERSPECTIVE} translateZ(${-300 * p}px)`,
    filter: `blur(${16 * p}px) brightness(${1 - 0.85 * p})`,
    opacity: Math.min(1, 2 - 2 * p),
  });
  // Al reducir se recorre el mismo camino al revés (Enter o Escape).
  const frames = (fn) => Array.from({ length: ZOOM_FRAMES + 1 }, (_, i) => {
    const offset = i / ZOOM_FRAMES;
    return { offset, ...fn(on ? offset : 1 - offset) };
  });
  const opts = { duration: ZOOM_MS, easing: ZOOM_EASING };
  grid.classList.add('zoomed', 'zooming');
  const others = [
    ...visible.filter((i) => i !== focusIndex).map((i) => tiles[i].el),
    ...grid.querySelectorAll('.empty'),
  ];
  const anims = [
    tile.el.animate(frames(tileFrame), opts),
    ...others.map((el) => el.animate(frames(otherFrame), opts)),
  ];
  // Al terminar, o si se vuelve a pulsar Enter a medio camino, queda el estado final.
  const end = zoomEnd = () => {
    zoomEnd = null;
    anims.forEach((a) => a.cancel());
    grid.classList.remove('zooming');
    if (!on) grid.classList.remove('zoomed');
  };
  anims[0].onfinish = () => {
    if (zoomEnd === end) end();
  };
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

// Foco al primer tile visible del canal N (el principal si está en el mosaico).
function focusChannel(n) {
  const target = groups[n - 1]?.tiles.map((t) => tiles.indexOf(t)).find((i) => visible.includes(i));
  if (target === undefined) return false;
  setFocus(target);
  return true;
}

function onKey(e) {
  if (!tiles.length) {
    if (e.key === 'q' || e.key === 'Escape') window.livetv.quit();
    return;
  }
  if (!addForm.el.hidden) {
    onAddKey(e);
    return;
  }
  // Confirmación de Shift+H: H o Enter oculta; cualquier otra tecla cancela.
  if (pendingHide) {
    const tile = pendingHide;
    closeConfirm();
    if ((e.key === 'H' || e.key === 'Enter') && tiles.includes(tile)) hideTile(tile);
    e.preventDefault();
    return;
  }
  if (menuIndex !== null) {
    onMenuKey(e);
    return;
  }
  if (setupIndex !== null) {
    onSetupKey(e);
    return;
  }
  const tile = tiles[focusIndex];
  switch (e.key) {
    case 'ArrowLeft': case 'h': moveFocus(-1, 0); break;
    case 'ArrowRight': case 'l': moveFocus(1, 0); break;
    case 'ArrowUp': case 'k': moveFocus(0, -1); break;
    case 'ArrowDown': case 'j': moveFocus(0, 1); break;
    case 'Enter': case ' ':
      setZoom(!zoomed);
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
    case 'r':
      createPlayer(tile);
      if (tile.stream.channel) syncLives(tile.group);
      break;
    case 'H': askHide(tile); break;
    case 'c': openMenu(); break;
    case 'o': openSetup(); break;
    case '[': case 'PageUp': stepCategory(-1); break;
    case ']': case 'PageDown': stepCategory(1); break;
    case 's':
      showOffline = !showOffline;
      layout();
      break;
    case 'f': case 'F11': window.livetv.toggleFullscreen(); break;
    case '?': help.hidden = !help.hidden; break;
    case 'Escape':
      if (zoomed) setZoom(false);
      else if (!help.hidden) help.hidden = true;
      else window.livetv.quit();
      break;
    case 'q': window.livetv.quit(); break;
    default:
      if (!/^[1-9]$/.test(e.key) || !focusChannel(Number(e.key))) return;
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

// OSD de volumen abajo al centro. El volumen es global, como un televisor.
function showVolumeOsd() {
  osd.el.classList.toggle('muted', muted);
  osd.label.textContent = muted ? 'MUTE' : 'Volumen';
  osd.value.textContent = String(volume);
  osd.fill.style.width = `${volume}%`;
  osd.el.hidden = false;
  clearTimeout(osd.timer);
  osd.timer = setTimeout(() => { osd.el.hidden = true; }, OSD_MS);
}

// Los OSD están diseñados a 1920×1080 (como el design system); --ui los
// escala con zoom al tamaño de la ventana.
function scaleOsd() {
  const ui = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
  document.documentElement.style.setProperty('--ui', String(ui));
}

// Mover el mouse (o hacer clic) muestra el cursor; quieto, se oculta.
function wakeCursor() {
  document.body.classList.remove('idle');
  clearTimeout(wakeCursor.timer);
  wakeCursor.timer = setTimeout(() => document.body.classList.add('idle'), CURSOR_IDLE_MS);
}

function showMessage(text) {
  const el = document.getElementById('message');
  el.textContent = text;
  el.hidden = false;
}

async function main() {
  document.addEventListener('keydown', onKey);
  scaleOsd();
  window.addEventListener('resize', scaleOsd);
  wakeCursor();
  document.addEventListener('mousemove', wakeCursor);
  document.addEventListener('mousedown', wakeCursor);
  // Si un iframe llegara a tomar el foco, devolverlo al documento.
  window.addEventListener('blur', () => setTimeout(() => {
    if (document.activeElement?.tagName === 'IFRAME') document.activeElement.blur();
  }, 0));

  settings = await window.livetv.getSettings();
  window.livetvLeveler(settings.leveler);
  const config = await window.livetv.getConfig();
  if (config.error) {
    showMessage(config.error);
    return;
  }
  // Sin "categories", la lista "streams" es una sola categoría.
  categories = (config.categories || [{ streams: config.streams }])
    .map((c, k) => ({
      // index y configName ubican la categoría en el archivo al agregar un canal.
      index: k,
      configName: c.name || '',
      name: c.name || `Categoría ${k + 1}`,
      streams: c.streams || [],
      columns: c.columns ?? config.columns ?? null,
    }))
    .filter((c) => c.streams.length);
  if (!categories.length) {
    showMessage(`No hay streams en ${config.file}`);
    return;
  }
  await ytReady;
  showCategory(0);
}

main();
