# Mi Música

Tu biblioteca de música del NAS, en tus Echo, con **tu propia skill de Alexa**.
Sin suscripciones ni servidores de terceros: el NAS habla directamente con Alexa a través de Tailscale Funnel.

```
Echo ──► Alexa (Amazon) ──HTTPS──► Tailscale Funnel ──► contenedor mimusica :8081  (solo /alexa, /stream, /art, /radio)
                                                         consola web           :8080  (solo tu red / tailnet)
```

## Qué hace

- Indexa MP3, M4A y M4B, y también FLAC, WMA, OGG, Opus, WAV y AIFF (los convierte a MP3 al vuelo con ffmpeg).
- Búsqueda por voz tolerante: errores ortográficos, acentos, «acdc» → «AC/DC», y género o canción que en realidad era un artista.
- Peticiones de artista, álbum, canción, género, lista, carpeta etiquetada, audiolibro (con marcador y capítulo), «toda mi música» y «continúa donde lo dejé».
- Durante la reproducción: siguiente, anterior, pausa, continuar, aleatorio, repetir, «qué suena», «añade esta canción a mi lista X» y «no vuelvas a ponerla».
- Importa listas `.m3u`, `.m3u8`, `.pls` y `.wpl`. Admite radios por internet (las de http:// se retransmiten por HTTPS).
- Aprendizajes: le enseñas qué debía sonar cuando entiende mal algo.
- Consola web: biblioteca con carátulas, listas, carpetas, dispositivos, historial, mensajes y ajustes.

La especificación funcional completa está en [docs/ESPECIFICACION.md](docs/ESPECIFICACION.md).

## Instalación en el NAS (UGREEN, Intel)

1. **Crea una carpeta** en el NAS, por ejemplo `/volume1/docker/mimusica`, y pon dentro solo estos archivos (no hace falta el código: la imagen ya viene compilada de GitHub):
   - [`docker-compose.yml`](docker-compose.yml)
   - [`tailscale/serve.json`](tailscale/serve.json)
   - `.env`, copiado de [`.env.example`](.env.example)
2. **Tailscale** (una sola vez, en https://login.tailscale.com):
   - *DNS*: activa **MagicDNS** y **HTTPS Certificates**. Apunta el *Tailnet name* (por ejemplo `tail1234.ts.net`).
   - *Access controls*: añade a la política
     ```json
     "tagOwners": { "tag:mimusica": ["autogroup:admin"] },
     "nodeAttrs": [ { "target": ["tag:mimusica"], "attr": ["funnel"] } ]
     ```
   - *Settings → Keys*: crea una **auth key** con la etiqueta `tag:mimusica`.
3. **Configura** el archivo `.env` a partir de `.env.example`:
   ```
   TS_AUTHKEY=tskey-auth-…
   TS_TAILNET=tail1234
   MUSIC_DIR=/volume1/Media/Music
   ```
4. **Arranca** desde la app Docker de UGOS (*Proyecto → Crear*, apuntando a esta carpeta) o por SSH:
   ```sh
   cd /volume1/docker/mimusica
   docker compose up -d
   ```
5. Abre **http://IP-DEL-NAS:8080**, añade tu carpeta de música y sigue la pestaña **Configurar Alexa**. Ahí están los pasos de la consola de Amazon, el modelo de interacción para descargar y la URL del endpoint.

> Si ya tienes un dispositivo llamado `mimusica` en Tailscale, el nuevo se llamará `mimusica-1`. Ajusta entonces `PUBLIC_URL` en el compose.

> Puedes parar el contenedor antiguo `mymediaforalexa`: no comparten puertos ni datos.

## Actualizaciones automáticas

Cada cambio en la rama `main` lanza [GitHub Actions](.github/workflows/docker.yml). El workflow comprueba los tipos, ejecuta una prueba con una sesión de Alexa simulada y publica `ghcr.io/magnodaza/mimusica:latest`.
En el NAS, el contenedor `mimusica-watchtower` mira cada hora si hay imagen nueva (cámbialo con `UPDATE_INTERVAL` en `.env`, en segundos). Si la hay, recrea `mimusica` con ella y borra la vieja.

- Solo actualiza el contenedor `mimusica` (usa el ámbito `mimusica`), así que no interfiere con otro Watchtower que ya tengas.
- No toca `tailscale`: si ese contenedor se recreara, la app perdería la red. Actualízalo a mano de vez en cuando con `docker compose pull tailscale && docker compose up -d`.
- Tus datos (`./data`) y tu música no se tocan al actualizar.
- Para publicar una versión con número, crea una etiqueta `v1.2.0`: genera también la imagen `:1.2.0`.

Si prefieres compilar en el NAS: `docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build`.

## Uso

«Alexa, pide a **mi biblioteca** que ponga música de Queen» · «…que ponga el álbum Thriller» ·
«…que ponga la canción Yesterday de los Beatles» · «…que ponga música jazz» · «…que ponga mi lista Favoritas» ·
«…que lea El Principito» · «…que continúe donde lo dejé» · «Alexa, pregunta a mi biblioteca qué suena».

El nombre de invocación se cambia en la consola (Configurar Alexa).

## Desarrollo

Necesitas Node 24 o superior. No hace falta compilar el servidor: Node ejecuta TypeScript directamente.

```sh
npm install
node scripts/make-test-library.ts ./testdata/music        # biblioteca de prueba
sh testdata/restart.sh                                     # servidor en :18080 (consola) y :18081 (público), sin verificar firmas
npm run dev:web                                            # consola con recarga en http://localhost:5173
node scripts/simulate-alexa.ts http://localhost:18080      # simula una sesión completa de un Echo
npm run typecheck && npx tsc --noEmit -p web
```

## Seguridad

- Al puerto público (8081) solo llegan `/alexa`, `/stream`, `/art`, `/radio` y `/health`. La consola no se publica.
- Cada petición a `/alexa` se verifica: firma SHA-256 de Amazon con cadena de certificados hasta una raíz de confianza, marca de tiempo de ±150 s y, si lo configuras, el ID de tu skill.
- Las URLs de audio y carátulas van firmadas con HMAC. Sin firma, el puerto público responde 403.
- La música se monta en solo lectura.
- Puedes poner contraseña a la consola en Ajustes.
