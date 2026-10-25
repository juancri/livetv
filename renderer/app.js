const ENDED_RETRY_MS = 30000;
// Cada cuánto se buscan lives nuevos en los canales que ya están transmitiendo.
const LIVES_POLL_MS = 120000;
const CHANNEL_OSD_MS = 3000;
const CONFIRM_MS = 5000;
const VOLUME_STEP = 5;
const OSD_SEGMENTS = 50;
const OSD_MS = 2500;
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
  timer: null,
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
      lives.filter((l) => !shown(l.id) && !group.hiddenIds.has(l.id))
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
  if (tile.videoId) group.hiddenIds.add(tile.videoId);
  if (tile !== group.tiles[0]) {
    removeTile(tile);
    return;
  }
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
  streams.forEach((stream, index) => {
    const name = stream.name || stream.url || stream.channel || stream.polymarket || 'Sin canal';
    // hiddenIds: lives ocultados con Shift+H, para que syncLives no los vuelva a abrir.
    const group = { stream, index, name, tiles: [], hiddenIds: new Set(), timer: null, sync: null };
    const tile = makeTile(group);
    group.tiles.push(tile);
    groups.push(group);
    tiles.push(tile);
    grid.append(tile.el);
    renumber(group);
  });
  layout();
  groups.forEach((group) => {
    if (!group.stream.channel) {
      createPlayer(group.tiles[0]);
      return;
    }
    setStatus(group.tiles[0], 'Cargando…');
    syncLives(group);
  });
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
  // Confirmación de Shift+H: H o Enter oculta; cualquier otra tecla cancela.
  if (pendingHide) {
    const tile = pendingHide;
    closeConfirm();
    if ((e.key === 'H' || e.key === 'Enter') && tiles.includes(tile)) hideTile(tile);
    e.preventDefault();
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
    case 'r':
      createPlayer(tile);
      if (tile.stream.channel) syncLives(tile.group);
      break;
    case 'H': askHide(tile); break;
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
