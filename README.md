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

- `url`: `watch?v=`, `youtu.be/`, `/live/`, `/embed/` o el ID de 11 caracteres.
- `channel`: ID del canal (`UC…`), handle (`@nombre`) o URL del canal; sigue automáticamente el live actual. Si el canal transmite varios lives a la vez, cada uno ocupa su propio tile (`CH 07`, `CH 07-2`, …), que se cierra cuando ese live termina. Los lives nuevos se detectan cada 2 minutos.
- `max`: opcional, con `channel`; tope de tiles (lives simultáneos) para ese canal.
- Sin `url` ni `channel`: tile vacío "SIN CANAL".
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
| f / F11 | pantalla completa |
| ? | ayuda |
| Esc | cerrar ampliación/ayuda, o salir |
| q | salir |
