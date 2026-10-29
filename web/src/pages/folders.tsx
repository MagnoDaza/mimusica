import { useState } from 'react';
import { FolderOpen, FolderPlus, RefreshCw, Trash2, FileText, ChevronRight, CornerLeftUp, Tag, HardDrive, AlertTriangle } from 'lucide-react';
import { api, act, useApi, fmtAgo, nf } from '../lib.ts';
import { Empty, Modal } from '../ui.tsx';

type Folder = {
  id: string; path: string; label: string; status: string; track_count: number; playlist_count: number;
  error_count: number; identified: number; progress: number; error_message: string; last_scan: number;
};

export function FoldersPage() {
  const { data, reload } = useApi<Folder[]>('/api/folders', { poll: 2500 });
  const [adding, setAdding] = useState(false);
  const [log, setLog] = useState<{ id: string; text: string } | null>(null);
  const [labelFor, setLabelFor] = useState<Folder | null>(null);

  const showLog = async (f: Folder) => {
    try {
      const res = await fetch(`/api/folders/${f.id}/log`);
      setLog({ id: f.id, text: res.ok ? await res.text() : 'Sin registro todavía.' });
    } catch {
      setLog({ id: f.id, text: 'No se pudo cargar el registro.' });
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div className="grow">
          <h1>Carpetas</h1>
          <p className="sub">Se vigilan y reescanean solas. Una carpeta con un archivo <span className="mono">.mmaignore</span> se salta.</p>
        </div>
        <button className="btn" onClick={() => act(() => api('/api/rescan', { body: {} }), 'Reescaneo en marcha')}><RefreshCw size={16} />Reescanear todo</button>
        <button className="btn primary" onClick={() => setAdding(true)}><FolderPlus size={16} />Añadir carpeta</button>
      </div>

      <div className="card">
        {data && !data.length && (
          <Empty icon={<FolderOpen size={22} />} title="Añade tu música" action={<button className="btn primary" onClick={() => setAdding(true)}><FolderPlus size={16} />Elegir carpeta</button>}>
            Elige la carpeta del NAS que montaste en el contenedor (por defecto aparece como <span className="mono">/music</span>).
          </Empty>
        )}
        {data?.map((f) => (
          <div key={f.id} className="list-item" style={{ alignItems: 'flex-start', padding: '18px 20px' }}>
            <div className="cover" style={{ width: 42, background: 'var(--accent-soft)', color: 'var(--accent)' }}><FolderOpen size={20} /></div>
            <div className="grow col" style={{ gap: 8, minWidth: 0 }}>
              <div className="row wrap" style={{ gap: 8 }}>
                <span className="mono ellipsis" style={{ fontWeight: 600, fontSize: 13.5 }}>{f.path}</span>
                {f.label && <span className="badge accent"><Tag size={11} />{f.label}</span>}
                {f.status === 'scanning' && <span className="badge accent"><span className="dot live" />Escaneando</span>}
                {f.status === 'ok' && <span className="badge ok">Al día</span>}
                {f.status === 'error' && <span className="badge err">Error</span>}
                {f.status === 'pending' && <span className="badge">En cola</span>}
              </div>
              {f.status === 'scanning' && (
                <div className="col" style={{ gap: 4 }}>
                  <div className="progress"><div style={{ width: `${f.progress}%` }} /></div>
                  <span className="faint small">{f.progress}% de {nf.format(f.identified)} archivos</span>
                </div>
              )}
              {f.status === 'error' && <span className="small row" style={{ color: 'var(--err)' }}><AlertTriangle size={14} />{f.error_message}</span>}
              <span className="muted small">
                {nf.format(f.track_count)} canciones · {f.playlist_count} listas{f.error_count ? ` · ${f.error_count} con errores` : ''} · escaneada {fmtAgo(f.last_scan)}
              </span>
            </div>
            <div className="row" style={{ gap: 4 }}>
              <button className="btn ghost icon sm" title="Etiqueta" aria-label="Etiqueta" onClick={() => setLabelFor(f)}><Tag size={16} /></button>
              <button className="btn ghost icon sm" title="Registro del último escaneo" aria-label="Registro" onClick={() => showLog(f)}><FileText size={16} /></button>
              <button className="btn ghost icon sm" title="Reescanear" aria-label="Reescanear" onClick={() => act(() => api(`/api/folders/${f.id}/rescan`, { body: {} }), 'Reescaneando')}><RefreshCw size={16} /></button>
              <button className="btn ghost icon sm danger" title="Quitar" aria-label="Quitar" onClick={async () => {
                if (confirm(`¿Quitar ${f.path}? Los archivos no se borran; solo dejan de estar en la biblioteca.`)) {
                  await act(() => api(`/api/folders/${f.id}`, { method: 'DELETE' }), 'Carpeta quitada');
                  reload();
                }
              }}><Trash2 size={16} /></button>
            </div>
          </div>
        ))}
      </div>

      {adding && <AddFolder onClose={() => setAdding(false)} onDone={() => { setAdding(false); reload(); }} />}
      {log && (
        <Modal title="Registro de importación" wide onClose={() => setLog(null)}>
          <pre className="mono" style={{ margin: 0, maxHeight: '60vh', overflow: 'auto', whiteSpace: 'pre-wrap', color: 'var(--text-2)' }}>{log.text}</pre>
        </Modal>
      )}
      {labelFor && <LabelModal folder={labelFor} onClose={() => { setLabelFor(null); reload(); }} />}
    </div>
  );
}

function LabelModal({ folder, onClose }: { folder: Folder; onClose: () => void }) {
  const [label, setLabel] = useState(folder.label);
  return (
    <Modal title="Etiqueta de la carpeta" onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button>
        <button className="btn primary" onClick={async () => { await act(() => api(`/api/folders/${folder.id}`, { method: 'PATCH', body: { label } }), 'Etiqueta guardada'); onClose(); }}>Guardar</button></>}>
      <div className="field">
        <label htmlFor="lbl">Etiqueta</label>
        <input id="lbl" className="input" autoFocus value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Navidad" />
        <span className="hint">Con una etiqueta, la carpeta funciona como lista: «Alexa, pide a … que ponga mi lista {label || 'Navidad'}» reproduce esa carpeta en aleatorio.</span>
      </div>
    </Modal>
  );
}

function AddFolder({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [dir, setDir] = useState('');
  const [label, setLabel] = useState('');
  const { data, error } = useApi<{ dir: string; parent: string | null; entries: { name: string; path: string }[] }>(`/api/browse?dir=${encodeURIComponent(dir)}`);
  const add = async () => {
    const r = await act(() => api('/api/folders', { body: { path: dir, label } }), 'Carpeta añadida: escaneando…');
    if (r) onDone();
  };
  return (
    <Modal title="Añadir carpeta" wide onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={!dir} onClick={add}><FolderPlus size={16} />Añadir esta carpeta</button></>}>
      <div className="code" style={{ padding: '10px 12px' }}><HardDrive size={15} /><code>{dir || 'Elige una carpeta montada'}</code></div>
      <div className="card" style={{ maxHeight: 340, overflow: 'auto' }}>
        {error && <div style={{ padding: 16, color: 'var(--err)' }}>{error}</div>}
        {data?.parent !== null && data?.parent !== undefined && (
          <button className="list-item btn ghost" style={{ width: '100%', height: 'auto', justifyContent: 'flex-start', borderRadius: 0 }} onClick={() => setDir(data.parent ?? '')}>
            <CornerLeftUp size={16} /> Subir
          </button>
        )}
        {data?.entries.map((e) => (
          <button key={e.path} className="list-item btn ghost" style={{ width: '100%', height: 'auto', justifyContent: 'flex-start', borderRadius: 0, fontWeight: 500 }} onClick={() => setDir(e.path)}>
            <FolderOpen size={16} color="var(--accent)" /><span className="grow ellipsis" style={{ textAlign: 'left' }}>{e.name}</span><ChevronRight size={15} className="faint" />
          </button>
        ))}
        {data && !data.entries.length && (
          <div className="muted" style={{ padding: 16 }}>
            {data.dir ? 'No hay subcarpetas.' : 'No hay carpetas montadas. Revisa la sección volumes del docker-compose (…:/music:ro).'}
          </div>
        )}
      </div>
      <div className="field">
        <label htmlFor="flabel">Etiqueta (opcional)</label>
        <input id="flabel" className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Ej. Navidad, Infantil…" />
        <span className="hint">Te deja pedir esa carpeta por voz como si fuera una lista.</span>
      </div>
    </Modal>
  );
}
