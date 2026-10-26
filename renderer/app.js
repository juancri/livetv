const ENDED_RETRY_MS = 30000;
// Cada cuánto se buscan lives nuevos en los canales que ya están transmitiendo.
const LIVES_POLL_MS = 120000;
const CHANNEL_OSD_MS = 3000;
const CONFIRM_MS = 5000;
const VOLUME_STEP = 5;
const OSD_SEGMENTS = 50;
const OSD_MS = 2500;
const ZOOM_MS = 1400;
const ZOOM_EASING = 'cubic-bezier(.45, 0, .25, 1)';
// Fracción de la animación en que el tile queda flotando delante del mosaico.
const ZOOM_HOLD = [0.35, 0.5];
// Al despegarse, el tile crece ZOOM_LIFT veces y se acerca al centro (ZOOM_PULL = 0.9: 10 %).
const ZOOM_LIFT = 1.15;
const ZOOM_PULL = 0.9;
const PERSPECTIVE = 'perspective(1200px)';
const MARKET_WS = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const MARKET_PING_MS = 10000;
const MARKET_RECONNECT_MS = 5000;
const MARKET_ROWS = 4;
// Como polymarket.com: con un spread mayor se muestra el último trade, no el punto medio.
const MARKET_MAX_SPREAD = 0.1;
const DAY_S = 86400;
const SVG_NS = 'http://www.w3.org/2000/svg';

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
  category: document.querySelector('#osd-channel .osd-category'),
  timer: null,
};
const menu = {
  el: document.getElementById('osd-menu'),
  list: document.querySelector('#osd-menu .osd-menu-list'),
};
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

// Identifica un stream de la config entre categorías (el mismo canal puede estar en varias).
function streamKey(stream) {
  return stream.url || stream.channel || stream.polymarket || null;
}

// Lo escrito en "Agregar canal": handle o ID de canal, URL de canal o video de
// YouTube, URL .m3u8 o URL de un evento de Polymarket. null si no se reconoce.
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
  channelOsd.category.textContent = categories.length > 1 ? categories[categoryIndex].name : '';
  channelOsd.el.classList.toggle('muted', muted);
  channelOsd.el.hidden = false;
  clearTimeout(channelOsd.timer);
  channelOsd.timer = setTimeout(() => { channelOsd.el.hidden = true; }, CHANNEL_OSD_MS);
}

// Tile que suena: el enfocado o, si es de Polymarket, el último video enfocado.
// Si ese ya no está (oculto con Shift+H o cerrado), el video visible más
// cercano antes del foco.
function audioSource() {
  const focused = tiles[focusIndex];
  if (!focused?.stream.polymarket) return focused;
  if (!tiles.includes(audioTile) || audioTile.hidden) {
    const videos = visible.map((i) => tiles[i]).filter((t) => !t.stream.polymarket);
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
  if (!tiles[i].stream.polymarket) audioTile = tiles[i];
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
  if (stream.url && isHls(stream.url)) {
    createVideo(tile);
    return;
  }
  if (!stream.url && !stream.channel) {
    setNoSignal(tile, 'SIN CANAL');
    setStatus(tile, '');
    return;
  }
  // El live de un tile de canal lo asigna syncLives().
  const videoId = stream.channel ? tile.videoId : parseVideoId(stream.url || '');
  if (!videoId) {
    setNoSignal(tile, 'SIN SEÑAL');
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
      setNoSignal(tile, 'SIN SEÑAL');
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
    setNoSignal(tile, 'SIN SEÑAL');
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
        setNoSignal(primary, 'SIN SEÑAL');
        setStatus(primary, 'Reintentando…');
      }
    })
    .finally(() => {
      if (group.sync !== sync) return;
      const retry = group.tiles.some((t) => !t.hidden && (t.failed || !t.videoId));
      group.timer = setTimeout(() => syncLives(group), retry ? ENDED_RETRY_MS : LIVES_POLL_MS);
    });
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
        setNoSignal(tile, 'SIN SEÑAL');
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
      setNoSignal(tile, 'SIN SEÑAL');
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
  confirmOsd.title.textContent = `¿OCULTAR ${tile.number}?`;
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
  const name = stream.name || stream.url || stream.channel || stream.polymarket || 'Sin canal';
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

function renderMenu() {
  const add = document.createElement('li');
  add.className = 'action';
  add.textContent = '+ AGREGAR CANAL';
  menu.list.replaceChildren(...categories.map((category, k) => {
    const li = document.createElement('li');
    li.textContent = `${k < 9 ? k + 1 : ' '} ${category.name}`;
    li.classList.toggle('current', k === categoryIndex);
    return li;
  }), add);
  menu.list.children[menuIndex].classList.add('selected');
}

function pickCategory(i) {
  closeMenu();
  if (i !== categoryIndex) showCategory(i);
}

// Con el menú abierto las demás teclas no hacen nada, como en un televisor.
function onMenuKey(e) {
  const n = categories.length + 1;
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
      if (menuIndex === categories.length) openAddForm();
      else pickCategory(menuIndex);
      break;
    case 'a': openAddForm(); break;
    case 'c': case 'Escape': closeMenu(); break;
    default:
      if (/^[1-9]$/.test(e.key) && Number(e.key) <= categories.length) pickCategory(Number(e.key) - 1);
  }
  e.preventDefault();
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
  addForm.categoryName.textContent = `◀ ${categories[addForm.index].name} ▶`;
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
    addForm.error.textContent = 'NO SE RECONOCE EL CANAL';
    return;
  }
  const category = categories[addForm.index];
  const key = streamKey(parsed);
  if (category.streams.some((s) => streamKey(s) === key)) {
    addForm.error.textContent = `YA ESTÁ EN ${category.name.toUpperCase()}`;
    return;
  }
  const name = addForm.name.value.trim();
  addForm.saving = true;
  addForm.error.textContent = 'GUARDANDO…';
  let stream;
  try {
    stream = await window.livetv.addStream({
      category: category.index,
      categoryName: category.configName,
      stream: name ? { name, ...parsed } : parsed,
    });
  } catch (err) {
    addForm.error.textContent = err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '').toUpperCase();
    return;
  } finally {
    addForm.saving = false;
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
    el.dataset.nosignal = 'SIN CANAL';
    grid.append(el);
  }

  // Si el canal con foco salió del mosaico, pasar al siguiente visible.
  if (tiles[focusIndex]?.el.classList.contains('focused') && !visible.includes(focusIndex)) {
    setFocus(visible.find((i) => i > focusIndex) ?? visible[0]);
  }
}

// Amplía o reduce el tile enfocado en dos pasos: primero se despega del
// mosaico y queda flotando delante (el resto se desenfoca y oscurece), y luego
// vuela hacia la cámara hasta cubrir la pantalla. Es un FLIP: el tile ya está en
// pantalla completa (el iframe con su tamaño final) y se anima su transform
// desde la celda. Se animan los tiles y no #grid: un ancestro con transform
// rompería el position: fixed del tile ampliado.
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
  const cell = `${PERSPECTIVE} translate(${dx}px, ${dy}px) scale(${sx}, ${sy}) rotateY(0deg) rotateX(0deg)`;
  // Despegado: algo más grande, un poco hacia el centro e inclinado hacia él.
  const lifted = `${PERSPECTIVE} translate(${dx * ZOOM_PULL}px, ${dy * ZOOM_PULL}px) ` +
    `scale(${sx * ZOOM_LIFT}, ${sy * ZOOM_LIFT}) ` +
    `rotateY(${(Math.sign(dx) || 1) * -10}deg) rotateX(${(Math.sign(dy) || 1) * 6}deg)`;
  const full = `${PERSPECTIVE} translate(0px, 0px) scale(1, 1) rotateY(0deg) rotateX(0deg)`;
  // Al reducir se recorren los mismos keyframes al revés (Enter o Escape).
  const frames = (list) => (on ? list : list.map((f) => ({ ...f, offset: 1 - f.offset })).reverse());
  const step = (offset, props) => ({ offset, easing: ZOOM_EASING, ...props });
  const opts = { duration: ZOOM_MS };
  grid.classList.add('zoomed', 'zooming');
  const others = [
    ...visible.filter((i) => i !== focusIndex).map((i) => tiles[i].el),
    ...grid.querySelectorAll('.empty'),
  ];
  const glow = '0 0 60px rgba(60, 255, 60, 0.35), 0 30px 80px rgba(0, 0, 0, 0.9)';
  const anims = [
    tile.el.animate(frames([
      step(0, { transform: cell, boxShadow: '0 0 0 transparent, 0 0 0 transparent' }),
      step(ZOOM_HOLD[0], { transform: lifted, boxShadow: glow }),
      step(ZOOM_HOLD[1], { transform: lifted, boxShadow: glow }),
      step(1, { transform: full, boxShadow: '0 0 0 transparent, 0 0 0 transparent' }),
    ]), opts),
    ...others.map((el) => el.animate(frames([
      step(0, { transform: `${PERSPECTIVE} translateZ(0px)`, filter: 'blur(0px) brightness(1)', opacity: 1 }),
      step(ZOOM_HOLD[0], { transform: `${PERSPECTIVE} translateZ(-80px)`, filter: 'blur(8px) brightness(0.45)', opacity: 1 }),
      step(ZOOM_HOLD[1], { transform: `${PERSPECTIVE} translateZ(-80px)`, filter: 'blur(8px) brightness(0.45)', opacity: 1 }),
      step(1, { transform: `${PERSPECTIVE} translateZ(-300px)`, filter: 'blur(16px) brightness(0.15)', opacity: 0 }),
    ]), opts)),
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
