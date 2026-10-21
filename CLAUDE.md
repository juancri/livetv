# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Qué es

App Electron que muestra N streams en vivo de YouTube en un mosaico. Solo el tile con foco (borde verde) tiene audio; se navega con teclado. Sin build, sin tests, sin linter: JS plano (CommonJS en main, script clásico en el renderer).

## Comandos

```sh
npm install
npm start                                  # usa ~/.config/livetv/streams.json o ./streams.json
npm start -- --config /ruta/streams.json
node --check renderer/app.js               # única verificación estática disponible
```

Para inspeccionar la app en ejecución: `npx electron . --remote-debugging-port=9333` y usar CDP (`http://127.0.0.1:9333/json`). El target `page` es el renderer (expone `tiles`, `focusIndex`, `setFocus`, `applyAudio` como globales); cada reproductor de YouTube aparece como target `iframe` aparte, donde `#movie_player` es la API interna del player.

## Arquitectura

- **main.js**: lee la config (`--config` → `~/.config/livetv/streams.json` → `./streams.json`) y la entrega por IPC (`get-config`, también `toggle-fullscreen` y `quit`, expuestos en `preload.js` como `window.livetv`). Sirve `renderer/` desde un **servidor HTTP local en 127.0.0.1:puerto aleatorio**, no desde `file://`: los embeds de YouTube fallan sin un origin/Referer válido.
- **renderer/app.js**: toda la lógica de UI. Cada stream es un objeto `tile` (`el`, `player`, `ready`, `stream`, `name`) que envuelve un `YT.Player` de la IFrame API. `stream.url` → `YT.Player` con `videoId`; `stream.channel` (ID `UC…`, handle `@nombre` o URL de canal) → `main.js` busca el live actual (IPC `find-live`: canonical de `<canal>/live`) y se crea un `YT.Player` con ese `videoId`; se busca de nuevo en cada carga/reintento. No se usa `embed/live_stream?channel=…`: da Error 150 aunque el live sea embebible. `createPlayer(tile)` destruye y recrea el player (se usa para recargar y reintentar).
- **Audio**: `volume` y `muted` son globales (como un televisor), no por tile. `applyAudio()` desmutea solo el tile enfocado y silencia el resto; se llama al cambiar foco, en `onReady` y en cada `PLAYING`.

## Detalles no obvios

- **El reproductor de YouTube ignora `unMute()` si su iframe no recibió un gesto de usuario.** `main.js` lo resuelve en `did-frame-finish-load` ejecutando `frame.executeJavaScript('0', true)` (userGesture) en cada frame de youtube.com. Por eso además no se usa `mute: 1` en `playerVars` y se reaplica el audio al llegar a `PLAYING`. El switch `autoplay-policy=no-user-gesture-required` solo cubre la política de Chromium, no la del player.
- Los iframes tienen `pointer-events: none` para no robar el foco del teclado; los clics los recibe el tile.
- El borde de foco es un div `.focus-ring` superpuesto: un `border`/`outline` del propio tile queda tapado por el iframe.
- Pantalla azul VHS (`.tile.nosignal`, texto en `data-nosignal`): errores del player, live terminado (`ENDED`), URL inválida, entradas sin `url`/`channel` ("SIN CANAL") y celdas sobrantes de la grilla. Los `channel` con error y los lives terminados se reintentan cada 30 s.
- OSDs verdes globales estilo Sony (`#osd` volumen abajo, `#osd-channel` arriba a la derecha) en `.osd`, con fuente VT323 de Google Fonts. Los textos de UI van en español, salvo "MUTE".
- El user agent elimina `Electron/x` para que YouTube lo trate como Chrome.
