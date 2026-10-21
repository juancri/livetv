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
- `channel`: ID del canal (`UC…`); sigue automáticamente el live actual del canal.
- Sin `url` ni `channel`: tile vacío "SIN CANAL".
- `columns`: opcional; por defecto `ceil(sqrt(N))`.

Los canales sin señal (error, live terminado, embed deshabilitado) y las celdas vacías se muestran con pantalla azul estilo VHS. Los `channel` y los lives terminados se reintentan cada 30 s.

## Teclas

| Tecla | Acción |
|---|---|
| ←↑→↓ / h j k l | mover foco |
| 1–9 | ir al tile N |
| Enter / Espacio | ampliar/restaurar el tile enfocado |
| m | silenciar/reactivar el audio (global) |
| + / − | volumen global, se mantiene al cambiar de canal (OSD en pantalla; quita el silencio) |
| r | recargar el stream enfocado |
| f / F11 | pantalla completa |
| ? | ayuda |
| Esc | cerrar ampliación/ayuda, o salir |
| q | salir |
