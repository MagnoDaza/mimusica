import { useState } from 'react';
import { Speaker, Pencil, Trash2, Shuffle, Repeat, ListMusic } from 'lucide-react';
import { api, act, useApi, fmtAgo, fmtDuration } from '../lib.ts';
import { Cover, Empty, Eq, Modal } from '../ui.tsx';

export function DevicesPage() {
  const { data: summary, reload } = useApi<any>('/api/summary', { poll: 5000 });
  const [editing, setEditing] = useState<any>(null);
  const [queueOf, setQueueOf] = useState<any>(null);
  const devices = summary?.devices ?? [];

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
  const { data } = useApi<any>(`/api/devices/${encodeURIComponent(device.id)}/queue`, { poll: 5000 });
  const items: any[] = data?.items ?? [];
  const left = data ? data.total - data.played - 1 : 0;
  return (
    <Modal wide title={`Cola de ${device.name || 'Echo'}`} onClose={onClose}>
      {data && <p className="muted small" style={{ marginTop: 0 }}>
        {data.radio ? 'Está sonando una radio: no tiene cola.' : `${data.name} · ${data.total} canciones · quedan ${Math.max(0, left)}`}
        {' '}Para añadir: «añade la canción X a la cola» o «pon X a continuación».
      </p>}
      {data && !items.length && !data.radio && <div className="muted">Cola vacía.</div>}
      <div className="card">
        {items.map((t, i) => {
          const now = t.pos === data.current;
          const past = data.offset + i < data.played;
          return (
            <div key={t.pos} className="list-item" ref={now ? (el) => el?.scrollIntoView({ block: 'center' }) : undefined}
              style={{ padding: '8px 12px', opacity: past || t.hidden ? 0.5 : 1, background: now ? 'var(--accent-soft)' : undefined }}>
              <span className="faint small" style={{ width: 32, textAlign: 'right' }}>{data.offset + i + 1}</span>
              <Cover id={t.has_art ? t.id : null} name={t.album || t.title} size={96} style={{ width: 36, borderRadius: 7 }} />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="ellipsis" style={{ fontWeight: 550 }}>{t.title}</div>
                <div className="ellipsis faint small">{[t.artist, t.album].filter(Boolean).join(' · ')}</div>
              </div>
              {now ? <span className="badge ok"><Eq />{device.state === 'playing' ? 'Sonando' : 'Aquí'}</span>
                : <span className="faint small">{fmtDuration(t.duration)}</span>}
            </div>
          );
        })}
      </div>
      {data && data.offset + items.length < data.total && <p className="faint small">…y {data.total - data.offset - items.length} más.</p>}
    </Modal>
  );
}
