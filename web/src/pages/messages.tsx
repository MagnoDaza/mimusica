import { useState } from 'react';
import { AlertTriangle, Bell, Info, Trash2, X, XCircle } from 'lucide-react';
import { api, act, useApi, fmtAgo } from '../lib.ts';
import { Empty } from '../ui.tsx';

const CONTEXTS = [['', 'Todo'], ['library', 'Biblioteca'], ['streaming', 'Reproducción'], ['alexa', 'Alexa'], ['system', 'Sistema']];

export function MessagesPage() {
  const { data, reload, setData } = useApi<any[]>('/api/messages?limit=300', { poll: 8000 });
  const [ctx, setCtx] = useState('');
  const [level, setLevel] = useState('');
  const list = (data ?? []).filter((m) => (!ctx || m.context === ctx) && (!level || m.level === level));

  return (
    <div className="page">
      <div className="page-head">
        <div className="grow"><h1>Mensajes</h1><p className="sub">Lo que pasa en el servidor: escaneos, reproducciones y avisos.</p></div>
        <button className="btn" onClick={async () => { await act(() => api('/api/messages', { method: 'DELETE' }), 'Mensajes borrados'); reload(); }}><Trash2 size={16} />Borrar todo</button>
      </div>
      <div className="row wrap">
        <div className="tabs">{CONTEXTS.map(([k, l]) => <button key={k} className={`tab ${ctx === k ? 'active' : ''}`} onClick={() => setCtx(k)}>{l}</button>)}</div>
        <div className="tabs">
          {[['', 'Todos'], ['warning', 'Avisos'], ['error', 'Errores']].map(([k, l]) => <button key={k} className={`tab ${level === k ? 'active' : ''}`} onClick={() => setLevel(k)}>{l}</button>)}
        </div>
      </div>
      <div className="card">
        {data && !list.length && <Empty icon={<Bell size={22} />} title="Todo tranquilo">No hay mensajes con estos filtros.</Empty>}
        {list.map((m) => (
          <div key={m.id} className="msg">
            <div className={`msg-icon ${m.level}`}>
              {m.level === 'error' ? <XCircle size={16} /> : m.level === 'warning' ? <AlertTriangle size={16} /> : <Info size={16} />}
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 550 }}>{m.title}</div>
              {m.description && <div className="msg-desc">{m.description}</div>}
              <div className="faint small" style={{ marginTop: 4 }}>{fmtAgo(m.ts)} · {CONTEXTS.find(([k]) => k === m.context)?.[1]}</div>
            </div>
            <button className="btn ghost icon sm" aria-label="Descartar" onClick={async () => {
              setData(data!.filter((x) => x.id !== m.id));
              await api(`/api/messages/${m.id}`, { method: 'DELETE' });
            }}><X size={15} /></button>
          </div>
        ))}
      </div>
    </div>
  );
}
