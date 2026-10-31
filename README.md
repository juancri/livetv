# LiveTV

Mosaico de streams en vivo de YouTube (Electron). Solo el tile con foco (anillo blanco) tiene audio.

![Mosaico de canales](docs/screenshots/mosaico.jpg)

| Cambio de canal | Volumen |
|---|---|
| ![Banner de canal con logo, número, nombre y programa en curso](docs/screenshots/canal.jpg) | ![Indicador de volumen](docs/screenshots/volumen.jpg) |
| **Guía de programación** (`g`) | **Categorías** (`c`) |
| ![Guía de programación con vista previa en vivo](docs/screenshots/guia.jpg) | ![Menú de categorías](docs/screenshots/categorias.jpg) |
| **Agregar canal** | **Ajustes** (`o`) |
| ![Formulario para agregar un canal](docs/screenshots/agregar.jpg) | ![Menú de ajustes](docs/screenshots/ajustes.jpg) |
| **Polymarket** | **Ayuda** (`?`) |
| ![Tile de un mercado de Polymarket](docs/screenshots/polymarket.jpg) | ![Atajos de teclado](docs/screenshots/ayuda.jpg) |

## Uso

```sh
npm install
npm start                      # o: npm start -- --config /ruta/streams.json
```

La config se busca en `--config`, luego `~/.config/livetv/streams.json`, luego `./streams.json` (una config de ejemplo mínima). Para una propia sin tocar el repo: `mkdir -p ~/.config/livetv && cp streams.json ~/.config/livetv/`. `streams-jc.json` es una config de ejemplo completa (Chile, Argentina, internacionales, religiosos): `npm start -- --config streams-jc.json`.

```json
{
  "columns": null,
  "categories": [
    { "name": "Noticias", "streams": [
      { "name": "DW News", "channel": "UCknLrEdhRCp1aegoMqRaCZg" },
      { "name": "Reservado" }
    ]},
    { "name": "Música", "columns": 1, "streams": [
      { "name": "Lofi Girl", "url": "https://www.youtube.com/watch?v=0sfDth4lMLc" }
    ]}
  ]
}
```

Desde el menú de categorías (`c`) se puede **agregar un canal** sin editar el archivo: se escribe un handle (`@canal`), una URL de canal o video de YouTube, una URL `.m3u8`, la de un evento de Polymarket o la de un mapa de windy.com, un nombre opcional (si queda vacío se usa el título de YouTube o Polymarket) y la categoría (←→). Se guarda al final de esa categoría en el archivo de config (que se reescribe con formato JSON estándar) y se abre en el acto.

El mosaico muestra una categoría a la vez (al empezar, la primera); al cambiar se cierran los streams de la anterior. Un mismo canal puede repetirse en varias categorías. En vez de `categories` se puede usar directamente una lista `"streams": [...]`, que queda como una sola categoría.

- `url`: `watch?v=`, `youtu.be/`, `/live/`, `/embed/` o el ID de 11 caracteres. También acepta un stream HLS directo (URL `.m3u8`), que se reproduce con hls.js; si termina o falla se reintenta cada 30 s.
- `channel`: ID del canal (`UC…`), handle (`@nombre`) o URL del canal; sigue automáticamente el live actual. Si el canal transmite varios lives a la vez, cada uno ocupa su propio tile (`CH 07`, `CH 07-2`, …), que se cierra cuando ese live termina. Los lives nuevos se detectan cada 2 minutos.
- `max`: opcional, con `channel`; tope de tiles (lives simultáneos) para ese canal.
- `epg`: opcional; de dónde sacar la programación del canal para la guía:
  - `mi.tv/<país>/<canal>`: [mi.tv](https://mi.tv), con el país y el canal de su URL (la página `mi.tv/cl/canales/chilevision` es `"epg": "mi.tv/cl/chilevision"`).
  - `3abn/<canal>`: la [programación de 3ABN](https://r.3abn.org/sched-app/#/); `<canal>` es `main`, `proc` (Proclaim), `dare` (Dare to Dream), `int` (International), `canada`, `praise` (Praise Him), `kids`, `lat` (Latino) o `radio`.

  Sin `epg`, la guía muestra el título del live que se está transmitiendo. Cada fuente es un módulo en `epg/`; para agregar otra, crear su módulo y sumarlo a `SOURCES` en `epg/index.js`.
- `logo`: opcional; URL de una imagen con el logo del canal para el indicador de canal y la guía (se muestra sobre una placa blanca). Sin `logo`, se usa el de mi.tv si tiene `epg` o el avatar del canal de YouTube.
- `polymarket`: slug o URL (`polymarket.com/event/<slug>`) de un evento de Polymarket. El tile no tiene video: muestra la probabilidad de cada outcome, su variación del día y un sparkline de 24 h, actualizados en vivo. Ejemplo: `{ "name": "Brasil 2ª vuelta", "polymarket": "brazil-presidential-election" }`.
- `outcomes`: opcional, con `polymarket`; cuántos outcomes mostrar (por defecto 4, los más probables).
- `windy`: URL de un mapa de windy.com (`https://www.windy.com/?wind,-33.45,-70.66,7`: capa, latitud, longitud y zoom, tal como queda en la barra de direcciones; con `/lat/lon` en el path se marca ese punto y se muestra su pronóstico) o una URL de `embed.windy.com` (el widget de "Embed" de Windy, con todas sus opciones). El tile no tiene audio y se recarga cada hora.
- Sin `url`, `channel`, `polymarket` ni `windy`: tile vacío "Sin canal".
- `columns`: opcional, global o por categoría; por defecto `ceil(sqrt(N))`.

Los canales sin señal (error, live terminado, embed deshabilitado) y las celdas vacías muestran una pantalla oscura con el motivo. Los `channel` y los lives terminados se reintentan cada 30 s.

Al **cambiar de canal** aparece un banner abajo con el logo (o las iniciales), el número y el nombre del canal y, a la derecha, el programa en curso: con `epg`, su horario, una barra de progreso, los minutos que quedan y lo que sigue; sin `epg`, el título del live. Siempre tiene el mismo formato, para leerlo de un vistazo al hacer zapping.

La **guía de programación** (`g`) tiene una fila por canal de la categoría, con la programación de los que tienen `epg`. El canal elegido se ve en vivo en el recuadro y su audio lo sigue; Enter lo sintoniza y lo amplía.

Los logos y la programación se guardan en `cache/` (ignorado por git): los logos valen 7 días y la programación 30 minutos; si renovarlos falla, se sigue usando lo guardado.

En **Ajustes** (`o`):

- **Nivelar volumen** (encendido por defecto): comprime el audio para que los canales fuertes y los suaves suenen parecido.
- **Reloj de 24 horas** (encendido por defecto): apagado, los horarios del banner, la guía y Polymarket se muestran como `6:30 p. m.`.

Los ajustes se guardan en `~/.config/livetv/settings.json`.

## Teclas

| Tecla | Acción |
|---|---|
| ←↑→↓ / h j k l | mover foco |
| 1–9 | ir al canal N |
| Enter / Espacio | ampliar/restaurar el tile enfocado |
| m | silenciar/reactivar el audio (global) |
| + / − | volumen global, se mantiene al cambiar de canal (OSD en pantalla; quita el silencio) |
| r | recargar el stream enfocado |
| Shift+H | ocultar el stream enfocado y cerrar su reproductor (pide confirmación: H/Enter sí, otra tecla no); queda oculto en todas las categorías hasta reiniciar la app |
| c | menú de categorías: ↑↓ / j k elegir, Enter o 1–9 abrir, c / Esc cerrar; al final, **Agregar canal** (o `a`) y **Ajustes** |
| g | guía de programación: ↑↓ canal, ←→ programa, Enter sintoniza, g / Esc cerrar |
| o | ajustes (nivelador de volumen, reloj de 24 horas) |
| [ / ] · RePág / AvPág | categoría anterior / siguiente |
| f / F11 | pantalla completa |
| ? | ayuda |
| Esc | cerrar ampliación/ayuda, o salir |
| q | salir |
