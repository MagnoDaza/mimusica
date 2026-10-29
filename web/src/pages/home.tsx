import { Check, Circle, Speaker, Music2, ArrowRight, AlertTriangle, Info, XCircle } from 'lucide-react';
import { useApi, nf, fmtHours, fmtAgo } from '../lib.ts';
import { Cover, Eq, PlayFab, Skeleton } from '../ui.tsx';
import { usePlayer } from '../player.tsx';

type Summary = {
  tracks: number; albums: number; artists: number; genres: number; seconds: number; playlists: number; folders: number;
  scanning: boolean; ffmpeg: boolean; publicUrl: string;
  devices: any[]; recent: any[];
  setup: { folders: boolean; publicUrl: boolean; skill: boolean; firstRequest: boolean };
};

function greeting() {
  const h = new Date().getHours();
  return h < 6 ? 'Buenas noches' : h < 13 ? 'Buenos días' : h < 20 ? 'Buenas tardes' : 'Buenas noches';
}

export function HomePage() {
  const { data: s } = useApi<Summary>('/api/summary', { poll: 5000 });
  const msgs = useApi<any[]>('/api/messages?limit=6', { poll: 10000 });
  const player = usePlayer();

  const setupDone = s && Object.values(s.setup).every(Boolean);
  const playing = s?.devices.filter((d) => d.state === 'playing' && d.title) ?? [];
  const hero = playing[0] ?? s?.devices.find((d) => d.title);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>{greeting()}</h1>
          <p className="sub">{s ? `${nf.format(s.tracks)} canciones listas para Alexa${s.scanning ? ' · escaneando…' : ''}` : ' '}</p>
        </div>
      </div>

      {hero ? (
        <div className="hero">
          <div className={`hero-bg ${hero.has_art ? '' : 'grad'}`} style={hero.has_art ? { backgroundImage: `url(/art/${hero.track_id}?s=300)` } : undefined} />
          <Cover id={hero.has_art ? hero.track_id : null} name={hero.album || hero.title} size={300} />
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="hero-kicker">
              {hero.state === 'playing' ? <><Eq /> Sonando en {hero.name}</> : <><Speaker size={14} /> Último en {hero.name} · {fmtAgo(hero.updated_at)}</>}
            </div>
            <div className="hero-title ellipsis">{hero.title}</div>
            <div className="hero-sub ellipsis">{[hero.artist, hero.album].filter(Boolean).join(' · ')}</div>
            {hero.queue_name && <div className="faint small" style={{ marginTop: 10 }}>De «{hero.queue_name}»</div>}
          </div>
          {playing.length > 1 && <span className="badge accent">+{playing.length - 1} altavoces</span>}
        </div>
      ) : s && setupDone ? (
        <div className="hero">
          <div className="hero-bg grad" />
          <div>
            <div className="hero-kicker"><Speaker size={14} /> Nada sonando</div>
            <div className="hero-title">«Alexa, pide a {'{'}tu skill{'}'} que ponga música»</div>
            <div className="hero-sub">Cuando suene algo lo verás aquí.</div>
          </div>
        </div>
      ) : null}

      {s && !setupDone && (
        <div className="card">
          <div className="card-head">
            <h2 className="grow">Pon tu biblioteca en marcha</h2>
            <span className="badge">{Object.values(s.setup).filter(Boolean).length} de 4</span>
          </div>
          <div className="steps">
            {[
              { done: s.setup.folders, title: 'Añade tu carpeta de música', desc: 'Elige la carpeta montada en el contenedor.', to: '#/carpetas', cta: 'Añadir carpeta' },
              { done: s.setup.publicUrl, title: 'Publica el servidor con Tailscale Funnel', desc: 'Alexa necesita llegar a tu NAS por HTTPS.', to: '#/alexa', cta: 'Ver cómo' },
              { done: s.setup.skill, title: 'Crea tu skill de Alexa', desc: 'Pega el modelo de interacción y la URL del endpoint.', to: '#/alexa', cta: 'Guía paso a paso' },
              { done: s.setup.firstRequest, title: 'Haz tu primera petición', desc: '«Alexa, abre mi biblioteca».', to: '#/alexa', cta: 'Probar' },
            ].map((st, i) => (
              <div key={i} className={`step ${st.done ? 'done' : ''}`}>
                <div className="step-num">{st.done ? <Check size={15} /> : i + 1}</div>
                <div className="row wrap">
                  <div className="grow">
                    <div style={{ fontWeight: 600, textDecoration: st.done ? 'line-through' : undefined, opacity: st.done ? 0.6 : 1 }}>{st.title}</div>
                    <div className="muted small">{st.desc}</div>
                  </div>
                  {!st.done && <a className="btn sm" href={st.to}>{st.cta}<ArrowRight size={14} /></a>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid-stats">
        {s
          ? [
              [nf.format(s.tracks), 'canciones'],
              [nf.format(s.albums), 'álbumes'],
              [nf.format(s.artists), 'artistas'],
              [nf.format(s.genres), 'géneros'],
              [fmtHours(s.seconds ?? 0), 'de música'],
              [nf.format(s.playlists), 'listas y radios'],
            ].map(([v, l]) => (
              <div key={l} className="card stat">
                <div className="stat-value">{v}</div>
                <div className="stat-label">{l}</div>
              </div>
            ))
          : Array.from({ length: 6 }, (_, i) => <div key={i} className="card stat"><Skeleton h={30} w="60%" /><div style={{ height: 6 }} /><Skeleton h={12} w="40%" /></div>)}
      </div>

      <div className="split">
        <section className="section">
          <div className="section-head"><h2>Sonó recientemente</h2><span className="spacer" /><a className="link" href="#/biblioteca">Ver biblioteca</a></div>
          {s?.recent.length ? (
            <div className="tiles">
              {s.recent.map((t: any, i: number) => (
                <button key={t.id} className="tile" onClick={() => player.play(s.recent, i)}>
                  <div style={{ position: 'relative' }}>
                    <Cover id={t.has_art ? t.id : null} name={t.album || t.title} />
                    <PlayFab onClick={() => player.play(s.recent, i)} />
                  </div>
                  <div>
                    <div className="tile-title ellipsis">{t.title}</div>
                    <div className="tile-sub ellipsis">{t.artist} · {fmtAgo(t.last_played)}</div>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <div className="card pad muted row"><Music2 size={18} /> Lo que pidas a Alexa aparecerá aquí.</div>
          )}
        </section>

        <section className="section">
          <div className="section-head"><h2>Actividad</h2><span className="spacer" /><a className="link" href="#/mensajes">Todo</a></div>
          <div className="card">
            {(msgs.data ?? []).length === 0 && <div className="pad muted" style={{ padding: 20 }}>Sin novedades.</div>}
            {(msgs.data ?? []).map((m) => (
              <div key={m.id} className="msg" style={{ gridTemplateColumns: '32px 1fr' }}>
                <div className={`msg-icon ${m.level}`}>
                  {m.level === 'error' ? <XCircle size={16} /> : m.level === 'warning' ? <AlertTriangle size={16} /> : <Info size={16} />}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div className="ellipsis" style={{ fontWeight: 550 }}>{m.title}</div>
                  <div className="faint small">{fmtAgo(m.ts)}</div>
                </div>
              </div>
            ))}
          </div>
          {s && !s.ffmpeg && (
            <div className="card pad row" style={{ borderColor: 'var(--warn)' }}>
              <Circle size={10} fill="var(--warn)" color="var(--warn)" />
              <span className="small">ffmpeg no está disponible: FLAC, WMA, OGG y WAV no sonarán en Alexa.</span>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
