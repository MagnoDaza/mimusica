import { useEffect, useState, type ReactNode } from 'react';
import { Save, X, Lock, Wrench } from 'lucide-react';
import { api, act, useApi } from '../lib.ts';
import { Switch } from '../ui.tsx';

type S = {
  extraFormats: boolean; transcodeBitrate: number; replayGain: boolean; audiobookGenres: string[]; scanIgnoreFiles: string;
  rescanHours: number; defaultPlaylist: string; defaultPlaylistShuffle: boolean; sendAlbumArt: boolean; verboseLogging: boolean;
  autoImportPlaylists: boolean; requirePassword: boolean; hasPassword: boolean; mediaRoots: string[];
};

function Row({ title, desc, children }: { title: string; desc?: ReactNode; children: ReactNode }) {
  return (
    <div className="setting">
      <div className="text"><div className="t">{title}</div>{desc && <div className="d">{desc}</div>}</div>
      <div className="control">{children}</div>
    </div>
  );
}

export function SettingsPage() {
  const { data, reload } = useApi<S>('/api/settings');
  const playlists = useApi<any[]>('/api/playlists');
  const [s, setS] = useState<S | undefined>();
  const [genre, setGenre] = useState('');
  const [pw, setPw] = useState('');
  useEffect(() => { if (data) setS(data); }, [data]);
  if (!s) return null;
  const dirty = JSON.stringify(s) !== JSON.stringify(data);
  const set = <K extends keyof S>(k: K, v: S[K]) => setS({ ...s, [k]: v });
  const save = async () => { await act(() => api('/api/settings', { method: 'PUT', body: s }), 'Ajustes guardados'); reload(); };

  return (
    <div className="page">
      <div className="page-head">
        <div className="grow"><h1>Ajustes</h1></div>
        <button className="btn primary" disabled={!dirty} onClick={save}><Save size={16} />Guardar</button>
      </div>

      <section className="section">
        <h2>Formatos y calidad</h2>
        <div className="card">
          <Row title="Formatos adicionales" desc="Incluye FLAC, WMA, OGG, Opus, WAV y AIFF. Alexa no los reproduce de forma nativa: se convierten a MP3 al vuelo con ffmpeg.">
            <Switch checked={s.extraFormats} onChange={(v) => set('extraFormats', v)} label="Formatos adicionales" />
          </Row>
          <Row title="Calidad de conversión" desc="Bitrate del MP3 cuando hay que convertir. Más alto, más fiel y más pesado.">
            <select className="select" value={s.transcodeBitrate} onChange={(e) => set('transcodeBitrate', Number(e.target.value))}>
              {[128, 160, 192, 256, 320].map((b) => <option key={b} value={b}>{b} kbps</option>)}
            </select>
          </Row>
          <Row title="Normalizar volumen (ReplayGain)" desc="Aplica la ganancia de pista al convertir, para que no haya saltos de volumen.">
            <Switch checked={s.replayGain} onChange={(v) => set('replayGain', v)} label="ReplayGain" />
          </Row>
          <Row title="Enviar carátulas a Alexa" desc="Se ven en los Echo Show y en la app de Alexa.">
            <Switch checked={s.sendAlbumArt} onChange={(v) => set('sendAlbumArt', v)} label="Carátulas" />
          </Row>
        </div>
      </section>

      <section className="section">
        <h2>Biblioteca</h2>
        <div className="card">
          <Row title="Reescaneo automático" desc="Además de vigilar cambios, revisa todo cada cierto tiempo (útil en volúmenes de red).">
            <select className="select" value={s.rescanHours} onChange={(e) => set('rescanHours', Number(e.target.value))}>
              {[[0, 'Nunca'], [1, 'Cada hora'], [6, 'Cada 6 horas'], [12, 'Cada 12 horas'], [24, 'Cada día']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Row>
          <Row title="Importar listas de las carpetas" desc="Archivos .m3u, .m3u8, .pls y .wpl.">
            <Switch checked={s.autoImportPlaylists} onChange={(v) => set('autoImportPlaylists', v)} label="Importar listas" />
          </Row>
          <Row title="Archivos que excluyen una carpeta" desc="Separados por comas. Si una carpeta contiene uno, no se escanea.">
            <input className="input mono" value={s.scanIgnoreFiles} onChange={(e) => set('scanIgnoreFiles', e.target.value)} />
          </Row>
          <div className="setting" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
            <div className="text"><div className="t">Géneros de audiolibro</div><div className="d">Los álbumes con estos géneros (o archivos .m4b) se tratan como libros: solo suenan al pedir «lee…», en orden, y recuerdan dónde lo dejaste.</div></div>
            <div className="chips">
              {s.audiobookGenres.map((g) => (
                <span key={g} className="chip">{g}<button aria-label={`Quitar ${g}`} onClick={() => set('audiobookGenres', s.audiobookGenres.filter((x) => x !== g))}><X size={12} /></button></span>
              ))}
              <form onSubmit={(e) => { e.preventDefault(); if (genre.trim()) { set('audiobookGenres', [...s.audiobookGenres, genre.trim()]); setGenre(''); } }}>
                <input className="input" style={{ height: 28, width: 160 }} placeholder="Añadir género…" value={genre} onChange={(e) => setGenre(e.target.value)} />
              </form>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <h2>Alexa</h2>
        <div className="card">
          <Row title="Lista por defecto" desc="Lo que suena con «pon música» sin decir qué. Vacío = una mezcla de toda tu biblioteca.">
            <select className="select" value={s.defaultPlaylist} onChange={(e) => set('defaultPlaylist', e.target.value)}>
              <option value="">Toda mi música (aleatorio)</option>
              {(playlists.data ?? []).map((p) => <option key={p.id} value={p.name}>{p.name}</option>)}
            </select>
          </Row>
          <Row title="Lista por defecto en aleatorio">
            <Switch checked={s.defaultPlaylistShuffle} onChange={(v) => set('defaultPlaylistShuffle', v)} label="Aleatorio" />
          </Row>
        </div>
      </section>

      <section className="section">
        <h2>Seguridad</h2>
        <div className="card">
          <Row title="Contraseña de la consola" desc={s.hasPassword ? 'Activada. Déjala vacía y guarda para quitarla.' : 'Sin contraseña: cualquiera en tu red puede abrir esta consola.'}>
            <form className="row" style={{ width: '100%' }} onSubmit={async (e) => {
              e.preventDefault();
              await act(() => api('/api/password', { body: { password: pw } }), pw ? 'Contraseña activada' : 'Contraseña quitada');
              setPw('');
              reload();
            }}>
              <input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder={s.hasPassword ? 'Nueva contraseña' : 'Contraseña'} />
              <button className="btn"><Lock size={15} /></button>
            </form>
          </Row>
        </div>
      </section>

      <section className="section">
        <h2>Mantenimiento</h2>
        <div className="card">
          <Row title="Registro detallado" desc="Más información en los logs del contenedor (docker logs mimusica).">
            <Switch checked={s.verboseLogging} onChange={(v) => set('verboseLogging', v)} label="Registro detallado" />
          </Row>
          <Row title="Regenerar carátulas" desc="Borra la caché de imágenes; se vuelven a crear al verlas.">
            <button className="btn" onClick={() => act(() => api('/api/maintenance/clear-art', { body: {} }), 'Caché de carátulas borrada')}><Wrench size={15} />Regenerar</button>
          </Row>
          <Row title="Borrar conversiones" desc="Libera el espacio de los MP3 convertidos en caché.">
            <button className="btn" onClick={() => act(() => api('/api/maintenance/clear-transcodes', { body: {} }), 'Caché de conversiones borrada')}><Wrench size={15} />Borrar</button>
          </Row>
          <Row title="Reconstruir la biblioteca" desc="Vuelve a leer todas las etiquetas. Conserva listas propias, aprendizajes y canciones ocultas no se pierden si los archivos siguen ahí.">
            <button className="btn danger" onClick={async () => {
              if (confirm('¿Reconstruir toda la biblioteca? Puede tardar un rato.')) await act(() => api('/api/rescan', { body: { clearHistory: true } }), 'Reconstruyendo…');
            }}><Wrench size={15} />Reconstruir</button>
          </Row>
        </div>
        <p className="faint small">Carpetas montadas en el contenedor: <span className="mono">{s.mediaRoots.join(', ')}</span></p>
      </section>
    </div>
  );
}
