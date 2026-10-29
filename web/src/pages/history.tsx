import { useState } from 'react';
import { GraduationCap, Trash2, CheckCircle2, XCircle, ArrowRight, Bookmark, History as HistoryIcon, Pencil } from 'lucide-react';
import { api, act, useApi, useRoute, navigate, fmtAgo, fmtDuration } from '../lib.ts';
import { Empty, Modal } from '../ui.tsx';

const KEYS = [['query', 'Cualquier cosa'], ['artist', 'Artista'], ['album', 'Álbum'], ['song', 'Canción'], ['genre', 'Género'], ['playlist', 'Lista'], ['book', 'Libro']] as const;
const label = (k: string) => KEYS.find(([x]) => x === k)?.[1] ?? k;

function Criteria({ c }: { c: Record<string, any> }) {
  const entries = Object.entries(c ?? {}).filter(([k, v]) => v && k !== 'artistIsAlbumArtist' && k !== 'everything');
  if (c?.everything) return <span className="badge">Toda la música</span>;
  if (!entries.length) return <span className="faint">—</span>;
  return (
    <span className="row wrap" style={{ gap: 6 }}>
      {entries.map(([k, v]) => <span key={k} className="small"><span className="faint">{label(k)}:</span> {String(v)}</span>)}
    </span>
  );
}

export function HistoryPage() {
  const [, params] = useRoute();
  const tab = params.get('t') ?? 'peticiones';
  return (
    <div className="page">
      <div className="page-head">
        <div className="grow">
          <h1>Peticiones</h1>
          <p className="sub">Lo que se pidió, lo que se encontró, y cómo enseñarle cuando se equivoca.</p>
        </div>
      </div>
      <div className="tabs">
        {[['peticiones', 'Historial'], ['aprendizajes', 'Aprendizajes'], ['marcadores', 'Marcadores']].map(([k, l]) => (
          <button key={k} className={`tab ${tab === k ? 'active' : ''}`} onClick={() => navigate(`/historial?t=${k}`)}>{l}</button>
        ))}
      </div>
      {tab === 'peticiones' && <HistoryList />}
      {tab === 'aprendizajes' && <Learnings />}
      {tab === 'marcadores' && <Bookmarks />}
    </div>
  );
}

function HistoryList() {
  const [failed, setFailed] = useState(false);
  const { data, reload } = useApi<any[]>(`/api/history?failed=${failed ? 1 : 0}`, { poll: 10000 });
  const [teach, setTeach] = useState<any>(null);
  return (
    <>
      <div className="row">
        <div className="tabs">
          <button className={`tab ${!failed ? 'active' : ''}`} onClick={() => setFailed(false)}>Todas</button>
          <button className={`tab ${failed ? 'active' : ''}`} onClick={() => setFailed(true)}>Sin resultado</button>
        </div>
        <span className="spacer" />
        <button className="btn ghost sm" onClick={async () => { if (confirm('¿Borrar todo el historial?')) { await act(() => api('/api/history', { method: 'DELETE' }), 'Historial borrado'); reload(); } }}><Trash2 size={14} />Vaciar</button>
      </div>
      <div className="card">
        {data && !data.length && <Empty icon={<HistoryIcon size={22} />} title="Sin peticiones">Aquí verás cada cosa que pidas a Alexa.</Empty>}
        <div className="table-wrap">
          <table className="table">
            <tbody>
              {data?.map((h) => (
                <tr key={h.id}>
                  <td style={{ width: 28 }}>{h.success ? <CheckCircle2 size={18} color="var(--ok)" /> : <XCircle size={18} color="var(--err)" />}</td>
                  <td><Criteria c={h.criteria} /><div className="faint small">{fmtAgo(h.ts)}{h.utterance?.startsWith('(prueba') ? ' · prueba desde la consola' : ''}</div></td>
                  <td className="hide-sm" style={{ width: 24 }}><ArrowRight size={14} className="faint" /></td>
                  <td>
                    {h.success ? <Criteria c={h.found} /> : <span className="small" style={{ color: 'var(--err)' }}>No encontrado</span>}
                    {h.learning_id && <div className="small"><span className="badge accent"><GraduationCap size={11} />aprendizaje aplicado</span></div>}
                  </td>
                  <td className="num hide-sm">{h.success ? `${h.track_count} pistas` : ''}</td>
                  <td style={{ width: 120, textAlign: 'right' }}>
                    <button className="btn sm" onClick={() => setTeach(h)}><GraduationCap size={14} />Enseñar</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {teach && <LearningModal initial={{ criteria: teach.criteria, trained: teach.success ? teach.found : {} }} onClose={() => setTeach(null)} />}
    </>
  );
}

function Learnings() {
  const { data, reload } = useApi<any[]>('/api/learnings');
  const [edit, setEdit] = useState<any>(null);
  return (
    <>
      <div className="row"><p className="muted grow">Cuando Alexa oye algo de una forma concreta, lo sustituye por lo que de verdad querías.</p>
        <button className="btn primary" onClick={() => setEdit({ criteria: {}, trained: {} })}><GraduationCap size={16} />Nuevo aprendizaje</button></div>
      <div className="card">
        {data && !data.length && <Empty icon={<GraduationCap size={22} />} title="Sin aprendizajes">Ej.: si dices «pon a los beatles» y Alexa entiende «los bitles», enséñale que eso es «The Beatles».</Empty>}
        {data?.map((l) => (
          <div key={l.id} className="list-item">
            <div className="grow row wrap"><span className="faint small">Si oye</span><Criteria c={l.criteria} /><ArrowRight size={14} className="faint" /><span className="faint small">pon</span><Criteria c={l.trained} /></div>
            <button className="btn ghost icon sm" aria-label="Editar" onClick={() => setEdit(l)}><Pencil size={15} /></button>
            <button className="btn ghost icon sm danger" aria-label="Borrar" onClick={async () => { await act(() => api(`/api/learnings/${l.id}`, { method: 'DELETE' }), 'Borrado'); reload(); }}><Trash2 size={15} /></button>
          </div>
        ))}
      </div>
      {edit && <LearningModal initial={edit} onClose={() => { setEdit(null); reload(); }} />}
    </>
  );
}

// Defined at module level so inputs keep focus while typing.
function Grid({ value, set, keys }: { value: Record<string, string>; set: (v: Record<string, string>) => void; keys: readonly (readonly [string, string])[] }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 }}>
      {keys.map(([k, l]) => (
        <div key={k} className="field"><label className="small">{l}</label>
          <input className="input" value={value[k] ?? ''} onChange={(e) => set({ ...value, [k]: e.target.value })} /></div>
      ))}
    </div>
  );
}

function LearningModal({ initial, onClose }: { initial: { id?: string; criteria: any; trained: any }; onClose: () => void }) {
  const clean = (o: any) => Object.fromEntries(Object.entries(o ?? {}).filter(([k, v]) => typeof v === 'string' && KEYS.some(([x]) => x === k))) as Record<string, string>;
  const [criteria, setCriteria] = useState<Record<string, string>>(clean(initial.criteria));
  const [trained, setTrained] = useState<Record<string, string>>(clean(initial.trained));
  const save = async () => {
    const r = await act(() => initial.id
      ? api(`/api/learnings/${initial.id}`, { method: 'PUT', body: { criteria, trained } })
      : api('/api/learnings', { body: { criteria, trained } }), 'Aprendizaje guardado');
    if (r) onClose();
  };
  return (
    <Modal title="Enseñar a Alexa" wide onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn primary" onClick={save}>Guardar</button></>}>
      <h3>Cuando se pida exactamente…</h3>
      <Grid value={criteria} set={setCriteria} keys={KEYS} />
      <h3>…poner esto</h3>
      <Grid value={trained} set={setTrained} keys={KEYS.filter(([k]) => k !== 'query')} />
      <p className="faint small">Escribe los nombres tal y como aparecen en tu biblioteca. Puedes probarlo después en Configurar Alexa → Probar sin Echo.</p>
    </Modal>
  );
}

function Bookmarks() {
  const { data, reload } = useApi<any[]>('/api/bookmarks');
  return (
    <div className="card">
      {data && !data.length && <Empty icon={<Bookmark size={22} />} title="Sin marcadores">Los audiolibros recuerdan dónde te quedaste; aparecerán aquí.</Empty>}
      {data?.map((b) => (
        <div key={b.search_hash} className="list-item">
          <Bookmark size={18} color="var(--accent)" />
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="ellipsis" style={{ fontWeight: 550 }}>{b.album || 'Pista eliminada'}</div>
            <div className="faint small">{b.title} · minuto {fmtDuration(Math.floor(b.offset_ms / 1000))} · {fmtAgo(b.updated_at)}</div>
          </div>
          <button className="btn ghost icon sm danger" aria-label="Borrar" onClick={async () => { await act(() => api(`/api/bookmarks/${b.search_hash}`, { method: 'DELETE' }), 'Marcador borrado'); reload(); }}><Trash2 size={15} /></button>
        </div>
      ))}
    </div>
  );
}
