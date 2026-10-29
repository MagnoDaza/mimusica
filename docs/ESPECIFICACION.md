# Especificación funcional — Mi Música (NAS + Alexa)

Cómo se comporta la app: qué indexa, cómo convierte una petición de voz en una lista de
reproducción y qué hace durante la reproducción.

Arquitectura: la skill de Alexa es **tuya** y su endpoint es el propio contenedor, publicado
con Tailscale Funnel. No hay ningún servicio intermedio en la nube.

## 1. Biblioteca

| Regla | Comportamiento |
|---|---|
| Formatos nativos | `.mp3 .m4a .m4b` |
| Formatos extra (si "formatos adicionales" está activo) | `.flac .wma .aif .aiff .ogg .oga .opus .wav` |
| Listas importadas | `.m3u .m3u8 .pls .wpl` (rutas relativas, absolutas o de Windows) |
| Carpetas ignoradas | ocultas, `#snapshots`, `#recycle`, `@__thumb`, `@Recently-Snapshot`, `@eaDir`, `$RECYCLE.BIN` |
| Fichero de exclusión | una carpeta que contiene `.mmaignore` o `.nomedia` (lista configurable) se salta |
| Huella de cambio | `mtime:tamaño` — solo se releen los archivos que cambian |
| Título vacío | nombre del fichero sin extensión |
| Artista vacío | se usa el artista del álbum |
| Géneros | separados por `;` o `/`, recortados, en Title Case |
| Audiolibro | extensión `.m4b` o género en la lista (`Audiobook, Audio book, Audiolibro, Comedy, Radio Drama`, editable) |
| Carátula | imagen incrustada; si no, `<pista>`, `folder`, `cover`, `front`, `albumart` (`.jpg .png .webp`) en la carpeta |
| Reescaneo | vigilancia de cambios + cada 6 h (configurable) + manual, por carpeta o por pista |

### Lo que Alexa no reproduce bien
Al indexar se detectan estas particularidades:
- `mp3tagatend`: etiqueta ID3v1 al final del MP3.
- `mp3invalidtags`: frames ID3v2 `TSO2 TCMP XRVA TSOC`, que algunos Echo no toleran.
- `deferredmoov`: en M4A, el átomo `moov` no está al principio.
- `mp42isom`, `alac`.

Conversión con ffmpeg:
- **Recodificar a MP3**: formatos extra, `.m4a`, `alac`, `deferredmoov`, `mp42isom`, `mp3invalidtags`.
  `-c:a libmp3lame -b:a {bitrate}k -ac 2 [-af volume=replaygain=track]` (192 kbps por defecto).
- **Reempaquetar** sin recodificar (`-c:a copy`, sin metadatos): `mp3tagatend`.
- La pista siguiente se convierte por adelantado. Si la conversión tarda más de 2,5 s, el
  audio se sirve mientras se genera. Caché con límite de tamaño (4 GB por defecto).

## 2. Búsqueda por voz

Entrada: álbum, canción, artista, género, libro (+ capítulo), lista, o un texto libre
("pon X"), opcionalmente en aleatorio.

1. **Aprendizajes**: si la petición coincide (sin distinguir mayúsculas) con uno guardado,
   se sustituye por lo "enseñado".
2. **Cascada de intentos**, que se para en el primer acierto:
   - términos de **2 palabras** también se prueban juntos ("ac dc" → "acdc");
   - coincidencia por palabras exactas (sin acentos ni puntuación, ignorando artículos);
   - coincidencia tolerante a errores (distancia de edición por palabra);
   - si solo se pidió un género o solo una canción, se reintenta como **artista**.
3. De los 10 mejores candidatos se prefiere el que coincide **exactamente** con lo dicho;
   si no hay, el mejor puntuado. El valor encontrado sustituye al dicho.
4. Con los valores resueltos se seleccionan **todas** las pistas que coinciden exactamente,
   sin las ocultas (y sin audiolibros salvo que se pida un libro).
5. Orden: álbum → disco, pista · libro → disco, pista, título · resto → álbum, disco, pista.
   Los géneros suenan siempre en aleatorio. Máximo 1000 pistas (muestra si hay más).
6. Texto libre: se prueba artista, álbum, canción y género (primero exacto, luego
   tolerante); después listas y carpetas etiquetadas; por último audiolibros.
7. Sin criterios: la lista por defecto si está configurada; si no, **toda tu música**
   (500 pistas aleatorias, sin ocultas ni audiolibros).
8. Nombre que dice Alexa: "el álbum X", "música de X", "música X", "el álbum X de Y",
   "la canción X", "la canción X de Y", "X" (libro), "X, capítulo N".
9. Cada petición queda en el **historial** (pedido, encontrado, aprendizaje aplicado,
   nº de pistas, éxito).

### Listas y carpetas
Primero coincidencia exacta del nombre, luego tolerante, sobre listas propias, importadas,
radios y **etiquetas de carpeta**:
- Una carpeta etiquetada suena como lista: 500 pistas aleatorias de esa carpeta.
- Una radio se retransmite por HTTPS si su URL es http.

### Especiales
- **Continúa donde lo dejé**: la última cola reproducida, en la pista y posición exactas.
- **Audiolibros**: un marcador por libro; se retoma **10 s antes** de donde se dejó. Se
  puede pedir por capítulo (pista N).
- **La selección**: las canciones marcadas en la consola como "selección para Alexa".

## 3. Navegación de la cola
`primera · siguiente · anterior · actual`, con **repetir** y **aleatorio** por dispositivo.
El orden aleatorio es estable dentro de cada cola, y los audiolibros nunca se barajan. Un
archivo que ya no existe se salta (hasta 10 seguidos) y se avisa en Mensajes.

## 4. Eventos de reproducción
- **Empieza**: el dispositivo pasa a "sonando", suma una escucha, actualiza el marcador de
  "último" y el del libro.
- **Casi termina**: se encola la siguiente pista (`ENQUEUE` con `expectedPreviousToken`).
- **Pausa o parada**: se guarda la posición en el dispositivo y en los marcadores.
- **Fallo**: mensaje con la causa probable (códec o acceso externo) y salto a la siguiente.
- **Botones del Echo** (siguiente, anterior, play, pausa): se responden solo con directivas.
- **Por voz durante la reproducción**: "qué suena", "añade esta canción a la lista X" (la
  crea si no existe), "no vuelvas a ponerla" (la oculta y salta).

## 5. Consola web
Inicio (sonando ahora, guía de puesta en marcha, cifras, actividad) · Biblioteca
(canciones, álbumes, artistas, géneros, audiolibros; filtro, orden, paginación; ocultar,
mostrar, releer etiquetas, marcar audiolibro, añadir a lista, selección para Alexa) ·
Listas y radios (crear, renombrar, reordenar, quitar, exportar M3U) · Carpetas (añadir con
explorador, etiquetar, reescanear, registro de importación) · Dispositivos · Peticiones
(historial → enseñar, aprendizajes, marcadores) · Mensajes · Ajustes · Configurar Alexa
(guía, modelo de interacción, endpoint, probador sin Echo).
