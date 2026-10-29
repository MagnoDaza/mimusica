# Especificación funcional — Mi Música (NAS + Alexa)

Comportamiento observado en MyMedia for Alexa (servidor local v. 2022, Mono/.NET) y
cómo lo reproduce esta app. Es una reimplementación propia: no reutiliza código.

La diferencia de arquitectura: en el original la skill vive en la nube de Bizmodeller y
habla con el servidor local por websocket (`GetPlaylistRequest`, `GetPlaylistItemRequest`,
`NotifyPlaybackUpdate`…). Aquí la skill es **tuya** y su endpoint es el propio contenedor,
publicado con Tailscale Funnel. Los mensajes push se convierten en llamadas internas.

## 1. Biblioteca

| Regla | Original | Aquí |
|---|---|---|
| Formatos nativos | `.mp3 .m4a .m4b` | igual |
| Formatos extra (si "formatos adicionales" activo) | `.flac .wma .aif .aiff .ogg .wav` | igual + `.opus` |
| Listas importadas | `.m3u .m3u8 .pls .wpl .zpl` | `.m3u .m3u8 .pls .wpl` |
| Carpetas ignoradas | contienen `#snapshots`, `#recycle`, `@__thumb`, `@Recently-Snapshot`, archivos ocultos | igual + `@eaDir`, `.@__thumb`, `#recycle` |
| Fichero de exclusión | carpeta con `.mmaignore` (lista configurable separada por comas) se salta | igual |
| Huella de cambio | `mtime:tamaño` | igual |
| Título vacío | nombre del fichero sin extensión | igual |
| Artista vacío | usa artista del álbum | igual |
| Géneros | separados por `;`, recortados, en Title Case | igual |
| Audiolibro | extensión `.m4b` o género en lista (`Audiobook, Audio book, Comedy, Radio Drama`) | igual (lista editable) |
| Carátula | imagen incrustada; si no, `<nombre>.jpg/png`, `folder`, `cover`, `AlbumArtSmall` en la carpeta | igual |
| Reescaneo | cada 6 h (configurable) + manual + por pista | igual + vigilancia de cambios |
| Peculiaridades de códec | `mp3tagatend` (ID3v1 al final), `deferredmoov` (moov no al inicio), `alac`, frames ID3 problemáticos `TSO2 TCMP XRVA TSOC` | igual |

### Transcodificación (lo que Alexa no reproduce)
- `flac wma wav aif aiff ogg m4a alac` + `deferredmoov / mp42isom / mp3invalidtags` → **Recode** a MP3:
  `ffmpeg -i IN -ab {bitrate}k -ac 2 -vn -f mp3 [-af volume=replaygain=track] OUT` (bitrate por defecto 160).
- `mp3tagatend` → **Repackage**: `-codec copy` (sin recodificar).
- Al pedir la siguiente pista se precarga/transcodifica por adelantado.

## 2. Búsqueda por voz (núcleo)

Entrada: álbum, canción, artista, género, libro (+ capítulo, reanudar), lista, aleatorio.

1. **Aprendizajes** (sustituciones): si la petición coincide (sin mayúsculas) con un
   criterio guardado, se reemplaza por los valores "entrenados".
2. **Cascada de intentos** — se para en el primer acierto:
   - modo 0: solo si el término más largo tiene **2 palabras**: probar con las palabras juntas
     ("ac dc" → "acdc");
   - modo 1: búsqueda por palabras exactas;
   - modo 2: búsqueda difusa (cada palabra con tolerancia de errores);
   - modo 3 (solo si la petición es *únicamente* género o *únicamente* canción):
     reintentar tratando ese término como **artista** ("pon Queen" entendido como canción).
3. De los 10 mejores, si alguno coincide **exactamente** con lo pedido se prefiere; si no,
   el mejor puntuado. El valor encontrado sustituye al dicho.
4. Con los valores resueltos se seleccionan **todas** las pistas que coinciden exactamente
   (excluyendo ocultas; audiolibros solo cuando se pide libro).
5. Orden: álbum → disco, pista · libro → disco, pista, título · resto → álbum, disco, pista.
   Género fuerza aleatorio. Máximo 1000 pistas (muestra aleatoria si hay más).
6. Sin criterios: lista por defecto si está configurada; si no, **"Todo"** = 500 pistas
   aleatorias no ocultas y no audiolibro.
7. Nombre de la cola: "el álbum X", "música de X", "música X", "el álbum X de Y",
   "la canción X", "la canción X de Y", "X" (libro).
8. Se guarda **historial** (criterio, encontrado, entrenado, nº pistas, éxito).

### Listas
Búsqueda exacta y luego difusa sobre nombres de listas → si el nombre coincide con la
**etiqueta de una carpeta vigilada**, se reproduce esa carpeta (500 aleatorias); si no,
la lista guardada (aleatoria si se pide).

### Especiales
- `SPECIAL_LAST` — "continúa / sigue donde lo dejé": última cola + marcador global.
- Audiolibros: marcador por búsqueda (hash), se retoma **10 s antes** de donde se dejó.

## 3. Navegación de la cola
`Primera · Siguiente · Anterior · Actual · DesdeMarcador`, con **bucle** y **aleatorio**
(orden aleatorio estable por cola; los audiolibros nunca se barajan). Si un fichero no
existe se salta (hasta 10 intentos) y se avisa en Mensajes.

## 4. Eventos de reproducción
- Empieza: dispositivo → "sonando ahora", +1 reproducción, marcador "último", mensaje.
- Pausa/Parada: guarda posición en marcador del libro y en "último".
- Fallo: mensaje explicando el códec o posible problema de red.
- Durante la reproducción: "añade esta canción a la lista X", "no vuelvas a ponerla" (ocultar).

## 5. Consola web
Panel (resumen, sonando ahora, mensajes) · Carpetas vigiladas (añadir/etiquetar/quitar,
progreso, registro de importación) · Biblioteca (canciones/álbumes/artistas/géneros con
filtro, orden, paginación; ocultar/mostrar, reescanear, marcar audiolibro, añadir a lista)
· Listas (crear, renombrar, borrar, radios web, reordenar/quitar pistas, exportar M3U)
· Dispositivos (nombre, olvidar) · Historial de peticiones → crear aprendizaje
· Aprendizajes (CRUD) · Ajustes · Configuración de Alexa (URL pública, modelo de interacción).

## 6. Fuera de alcance (dependían de la nube de Bizmodeller)
Cuenta/emparejamiento Amazon vía Bizmodeller, suscripciones, compartir con otros usuarios
e invitaciones, actualizaciones automáticas, Last.fm, unidades de red Windows, iTunes.
