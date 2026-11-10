import { useEffect, useRef, useState } from 'react';
import { Speaker, Pencil, Trash2, Shuffle, Repeat, ListMusic, ChevronUp, ChevronDown, ChevronsUp, X, Search, ListEnd, ListStart, Mic } from 'lucide-react';
import { api, act, useApi, useDebounced, useRoute, navigate, toast, fmtAgo, fmtDuration } from '../lib.ts';
import { Cover, Empty, Eq, Modal } from '../ui.tsx';

export function DevicesPage() {
  const { data: summary, reload } = useApi<any>('/api/summary', { poll: 5000 });
  const [editing, setEditing] = useState<any>(null);
  const devices: any[] = summary?.devices ?? [];
  // The open queue lives in the URL (#/dispositivos?cola=<id>) so Inicio can link straight to it.
  const [, params] = useRoute();
  const queueId = params.get('cola');
  const queueOf = queueId ? devices.find((x) => x.id === queueId) : undefined;
  const setQueueOf = (d: any) => navigate(d ? `/dispositivos?cola=${encodeURIComponent(d.id)}` : '/dispositivos');

  return (
    <div className="page">
      <div className="page-head">
        <div className="grow">
          <h1>Dispositivos</h1>
          <p className="sub">Los Echo aparecen solos la primera vez que usan la skill. Ponles nombre para reconocerlos.</p>
        </div>
      </div>
      {summary && !devices.length && (
        <div className="card"><Empty icon={<Speaker size={22} />} title="Aún no ha hablado ningún Echo">Cuando pidas algo a la skill desde un Echo, aparecerá aquí.</Empty></div>
      )}
      <div className="tiles" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
        {devices.map((d: any) => (
          <div key={d.id} className="card" style={{ overflow: 'hidden' }}>
            <div className="row" style={{ padding: 18, gap: 14 }}>
              <div className="cover" style={{ width: 44, background: 'var(--accent-soft)', color: 'var(--accent)', borderRadius: 12 }}><Speaker size={20} /></div>
              <div className="grow" style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 650 }} className="ellipsis">{d.name || 'Echo'}</div>
                <div className="faint small">Visto {fmtAgo(d.last_seen)}</div>
              </div>
              {d.state === 'playing' && <span className="badge ok"><Eq />Sonando</span>}
              {d.state === 'paused' && <span className="badge">En pausa</span>}
            </div>
            {d.title ? (
              <div className="row" style={{ padding: '14px 18px', background: 'var(--surface-2)', gap: 12 }}>
                <Cover id={d.has_art ? d.track_id : null} name={d.album || d.title} size={96} style={{ width: 46 }} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="ellipsis" style={{ fontWeight: 550 }}>{d.title}</div>
                  <div className="ellipsis muted small">{d.artist}{d.queue_name ? ` · ${d.queue_name}` : ''}</div>
                </div>
              </div>
            ) : (
              <div className="muted small" style={{ padding: '14px 18px', background: 'var(--surface-2)' }}>Sin reproducción reciente.</div>
            )}
            {!!d.requests?.length && (
              <div style={{ padding: '10px 18px 0' }}>
                <div className="faint small" style={{ marginBottom: 4 }}>Últimas peticiones</div>
                {d.requests.map((r: any) => (
                  <div key={r.ts} className="row small" style={{ gap: 6 }}>
                    <span className={`badge ${r.success ? 'ok' : 'warn'}`} style={{ padding: '0 6px' }}>{r.success ? '✓' : '✗'}</span>
                    <span className="ellipsis grow">{r.utterance.split(': ').slice(1).join(': ') || 'música'}</span>
                    <span className="faint">{fmtAgo(r.ts)}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="row" style={{ padding: '10px 12px' }}>
              <span className={`badge ${d.shuffle ? 'accent' : ''}`}><Shuffle size={12} />{d.shuffle ? 'Aleatorio' : 'En orden'}</span>
              <span className={`badge ${d.loop ? 'accent' : ''}`}><Repeat size={12} />{d.loop ? 'Repite' : 'Sin repetir'}</span>
              {d.locale && <span className="badge" title="Idioma del Echo: la skill debe tener este mismo idioma en Amazon">{d.locale}</span>}
              <span className="spacer" />
              {d.queue_id && <button className="btn ghost sm" onClick={() => setQueueOf(d)}><ListMusic size={15} />Cola</button>}
              <button className="btn ghost icon sm" aria-label="Renombrar" onClick={() => setEditing(d)}><Pencil size={15} /></button>
              <button className="btn ghost icon sm danger" aria-label="Olvidar" onClick={async () => {
                if (confirm(`¿Olvidar ${d.name}? Volverá a aparecer si usa la skill.`)) { await act(() => api(`/api/devices/${encodeURIComponent(d.id)}`, { method: 'DELETE' }), 'Olvidado'); reload(); }
              }}><Trash2 size={15} /></button>
            </div>
          </div>
        ))}
      </div>
      {!!devices.length && <Phrases />}
      {queueOf && <QueueView device={queueOf} onClose={() => setQueueOf(null)} />}
      {editing && <Rename device={editing} onClose={() => { setEditing(null); reload(); }} />}
    </div>
  );
}

function Rename({ device, onClose }: { device: any; onClose: () => void }) {
  const [name, setName] = useState(device.name);
  return (
    <Modal title="Nombre del dispositivo" onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button>
        <button className="btn primary" onClick={async () => { await act(() => api(`/api/devices/${encodeURIComponent(device.id)}`, { method: 'PATCH', body: { name } }), 'Guardado'); onClose(); }}>Guardar</button></>}>
      <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Echo del salón" />
    </Modal>
  );
}

function QueueView({ device, onClose }: { device: any; onClose: () => void }) {
  const { data, reload } = useApi<any>(`/api/devices/${encodeURIComponent(device.id)}/queue`, { poll: 5000 });
  const items: any[] = data?.items ?? [];
  const [busy, setBusy] = useState(false);
  const nowRef = useRef<HTMLDivElement>(null);
  const scrolled = useRef(false);
  // Center the playing song once, when the queue first loads: later polls must not yank the view while you browse.
  useEffect(() => {
    if (scrolled.current || !nowRef.current) return;
    scrolled.current = true;
    nowRef.current.scrollIntoView({ block: 'center' });
  }, [data]);
  const edit = async (pos: number, to?: number) => {
    // Rows are addressed by position: wait for the fresh list before allowing the next click.
    setBusy(true);
    await act(() => api(`/api/devices/${encodeURIComponent(device.id)}/queue/edit`, { body: { pos, to } }));
    await reload();
    setBusy(false);
  };
  const left = data ? data.total - data.played - 1 : 0;
  return (
    <Modal wide title={`Cola de ${device.name || 'Echo'}`} onClose={onClose}>
      {data && <p className="muted small" style={{ marginTop: 0 }}>
        {data.radio ? 'Está sonando una radio: no tiene cola.' : `${data.name} · ${data.total} canciones · quedan ${Math.max(0, left)}`}
        {' '}Para añadir: «añade la canción X a la cola» o «pon X a continuación». La siguiente canción puede estar ya cargada en el Echo: los cambios se notan a partir de la que viene después.
      </p>}
      {data && !data.radio && <AddSongs deviceId={device.id} onAdded={reload} />}
      {data && !items.length && !data.radio && <div className="muted">Cola vacía.</div>}
      <div className="card">
        {items.map((t, i) => {
          const now = t.pos === data.current;
          const past = data.offset + i < data.played;
          const upcoming = data.offset + i > data.played;
          const prev = items[i - 1], next = items[i + 1], first = items[data.played - data.offset + 1];
          return (
            <div key={t.pos} className="list-item" ref={now ? nowRef : undefined}
              style={{ padding: '8px 12px', opacity: past || t.hidden ? 0.5 : 1, background: now ? 'var(--accent-soft)' : undefined }}>
              <span className="faint small" style={{ width: 32, textAlign: 'right' }}>{data.offset + i + 1}</span>
              <Cover id={t.has_art ? t.id : null} name={t.album || t.title} size={96} style={{ width: 36, borderRadius: 7 }} />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="ellipsis" style={{ fontWeight: 550 }}>{t.title}</div>
                <div className="ellipsis faint small">{[t.artist, t.album].filter(Boolean).join(' · ')}</div>
              </div>
              {now ? <span className="badge ok"><Eq />{device.state === 'playing' ? 'Sonando' : 'Aquí'}</span>
                : <span className="faint small">{fmtDuration(t.duration)}</span>}
              {upcoming && !data.radio && <span className="row" style={{ gap: 2 }}>
                <button className="btn ghost icon sm" aria-label="Poner a continuación" title="Poner a continuación"
                  disabled={busy || first?.pos === t.pos} onClick={() => edit(t.pos, first.pos)}><ChevronsUp size={15} /></button>
                <button className="btn ghost icon sm" aria-label="Subir" title="Subir"
                  disabled={busy || first?.pos === t.pos} onClick={() => edit(t.pos, prev.pos)}><ChevronUp size={15} /></button>
                <button className="btn ghost icon sm" aria-label="Bajar" title="Bajar"
                  disabled={busy || !next} onClick={() => edit(t.pos, next.pos)}><ChevronDown size={15} /></button>
                <button className="btn ghost icon sm danger" aria-label="Quitar de la cola" title="Quitar de la cola"
                  disabled={busy} onClick={() => edit(t.pos)}><X size={15} /></button>
              </span>}
            </div>
          );
        })}
      </div>
      {data && data.offset + items.length < data.total && <p className="faint small">…y {data.total - data.offset - items.length} más.</p>}
    </Modal>
  );
}


/** Search the library and send songs to this Echo's queue. */
function AddSongs({ deviceId, onAdded }: { deviceId: string; onAdded: () => void }) {
  const [q, setQ] = useState('');
  const dq = useDebounced(q).trim();
  const { data } = useApi<any>(dq.length >= 2 ? `/api/tracks?q=${encodeURIComponent(dq)}&hidden=0&size=8` : null);
  const add = async (id: string, at: 'next' | 'end') => {
    const r = await act(() => api<any>(`/api/devices/${encodeURIComponent(deviceId)}/queue/add`, { body: { trackIds: [id], at } }));
    if (r?.message) toast(r.message);
    onAdded();
  };
  const rows: any[] = dq.length >= 2 ? data?.rows ?? [] : [];
  return (
    <div style={{ marginBottom: 12 }}>
      <div className="search">
        <Search size={16} />
        <input className="input" placeholder="Añadir a la cola: busca canción, artista o álbum…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {!!rows.length && <div className="card" style={{ marginTop: 6 }}>
        {rows.map((t) => (
          <div key={t.id} className="list-item" style={{ padding: '6px 12px' }}>
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="ellipsis" style={{ fontWeight: 550 }}>{t.title}</div>
              <div className="ellipsis faint small">{[t.artist, t.album].filter(Boolean).join(' · ')}</div>
            </div>
            <button className="btn ghost sm" title="Suena después de la siguiente canción" onClick={() => add(t.id, 'next')}><ListStart size={15} />Pronto</button>
            <button className="btn ghost sm" title="Al final de la cola" onClick={() => add(t.id, 'end')}><ListEnd size={15} />Al final</button>
          </div>
        ))}
      </div>}
      {dq.length >= 2 && data && !rows.length && <div className="faint small" style={{ marginTop: 6 }}>Nada con «{dq}».</div>}
    </div>
  );
}

/** What to say to the Echo, with the skill's real invocation name. */
function Phrases() {
  const { data: s } = useApi<any>('/api/settings');
  const inv = s?.invocationName || 'mi biblioteca';
  const groups: [string, string[]][] = [
    ['Para empezar', [`pide a ${inv} que ponga el álbum Back in Black`, `pide a ${inv} que ponga canciones de Shakira`, `pide a ${inv} que ponga salsa`, `pide a ${inv} que continúe donde lo dejé`]],
    ['Al azar', [`pide a ${inv} que ponga un disco al azar`, `pide a ${inv} que ponga algo parecido a esto`, `pide a ${inv} que ponga lo más escuchado`, `pide a ${inv} que ponga otra canción`]],
    ['Mientras suena', [`pide a ${inv} que añada Thunderstruck a la cola`, `pide a ${inv} que ponga Hells Bells a continuación`, `pide a ${inv} qué viene después`, `pide a ${inv} que guarde esta canción en favoritas`]],
    ['Sin decir el nombre (esto lo hace Alexa; «añade a favoritos» sin el nombre va a Amazon Music)', ['siguiente', 'anterior', 'pausa', 'continúa', 'aleatorio', 'repite']],
  ];
  return (
    <details className="card" style={{ marginTop: 16, padding: '14px 18px' }}>
      <summary style={{ cursor: 'pointer', fontWeight: 650 }}><Mic size={16} style={{ verticalAlign: -3, marginRight: 6 }} />Qué le puedes decir a tus Echo</summary>
      <div className="tiles" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', marginTop: 12 }}>
        {groups.map(([title, list]) => (
          <div key={title}>
            <div className="faint small" style={{ marginBottom: 4 }}>{title}</div>
            {list.map((x) => <div key={x} className="small" style={{ marginBottom: 3 }}>«Alexa, {x}»</div>)}
          </div>
        ))}
      </div>
      <p className="faint small" style={{ marginBottom: 0 }}>Las frases nuevas funcionan cuando pegas el modelo actualizado en la consola de Amazon y pulsas Build.</p>
    </details>
  );
}
