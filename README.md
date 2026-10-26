# LiveTV

Mosaico de streams en vivo de YouTube (Electron). Solo el tile con foco (borde verde) tiene audio.

## Uso

```sh
npm install
mkdir -p ~/.config/livetv && cp streams.example.json ~/.config/livetv/streams.json
npm start                      # o: npm start -- --config /ruta/streams.json
```

La config se busca en `--config`, luego `~/.config/livetv/streams.json`, luego `./streams.json`.

```json
{
  "columns": null,
  "streams": [
    { "name": "Lofi Girl", "url": "https://www.youtube.com/watch?v=0sfDth4lMLc" },
    { "name": "DW News", "channel": "UCknLrEdhRCp1aegoMqRaCZg" },
    { "name": "Reservado" }
  ]
}
```

- `url`: `watch?v=`, `youtu.be/`, `/live/`, `/embed/` o el ID de 11 caracteres. También acepta un stream HLS directo (URL `.m3u8`), que se reproduce con hls.js; si termina o falla se reintenta cada 30 s.
- `channel`: ID del canal (`UC…`), handle (`@nombre`) o URL del canal; sigue automáticamente el live actual. Si el canal transmite varios lives a la vez, cada uno ocupa su propio tile (`CH 07`, `CH 07-2`, …), que se cierra cuando ese live termina. Los lives nuevos se detectan cada 2 minutos.
- `max`: opcional, con `channel`; tope de tiles (lives simultáneos) para ese canal.
- `polymarket`: slug o URL (`polymarket.com/event/<slug>`) de un evento de Polymarket. El tile no tiene video: muestra la probabilidad de cada outcome, su variación del día y un sparkline de 24 h, actualizados en vivo. Ejemplo: `{ "name": "Brasil 2ª vuelta", "polymarket": "brazil-presidential-election" }`.
- `outcomes`: opcional, con `polymarket`; cuántos outcomes mostrar (por defecto 4, los más probables).
- Sin `url`, `channel` ni `polymarket`: tile vacío "SIN CANAL".
- `columns`: opcional; por defecto `ceil(sqrt(N))`.

Los canales sin señal (error, live terminado, embed deshabilitado) y las celdas vacías se muestran con pantalla azul estilo VHS. Los `channel` y los lives terminados se reintentan cada 30 s.

## Teclas

| Tecla | Acción |
|---|---|
| ←↑→↓ / h j k l | mover foco |
| 1–9 | ir al canal N |
| Enter / Espacio | ampliar/restaurar el tile enfocado |
| m | silenciar/reactivar el audio (global) |
| + / − | volumen global, se mantiene al cambiar de canal (OSD en pantalla; quita el silencio) |
| r | recargar el stream enfocado |
| Shift+H | ocultar el stream enfocado y cerrar su reproductor (pide confirmación: H/Enter sí, otra tecla no); vuelve al reiniciar la app |
| f / F11 | pantalla completa |
| ? | ayuda |
| Esc | cerrar ampliación/ayuda, o salir |
| q | salir |
