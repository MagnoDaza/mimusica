import { useEffect, useState } from 'react';
import { Plus, Radio, ListMusic, Trash2, Download, Pencil, ArrowUp, ArrowDown, X, Play, Mic, FileText } from 'lucide-react';
import { api, act, useApi, fmtDuration, fmtHours } from '../lib.ts';
import { Cover, Drawer, Empty, Modal, PlayFab } from '../ui.tsx';
import { usePlayer } from '../player.tsx';

type Playlist = { id: string; name: string; kind: 'user' | 'file' | 'webstream'; stream_url: string; source_path: string; tracks: number; seconds: number; art_id: string | null };

export function PlaylistsPage() {
  const { data, reload } = useApi<Playlist[]>('/api/playlists');
  const [creating, setCreating] = useState<'user' | 'webstream' | null>(null);
  const [open, setOpen] = useState<Playlist | null>(null);
  const player = usePlayer();

  const lists = (data ?? []).filter((p) => p.kind !== 'webstream');
  const radios = (data ?? []).filter((p) => p.kind === 'webstream');

  const playList = async (p: Playlist) => player.play(await api(`/api/playlists/${p.id}/tracks`));

  return (
    <div className="page">
      <div className="page-head">
        <div className="grow">
          <h1>Listas y radios</h1>
          <p className="sub">Las listas de tus carpetas (.m3u, .pls, .wpl) se importan solas.</p>
        </div>
        <button className="btn" onClick={() => setCreating('webstream')}><Radio size={16} />Nueva radio</button>
        <button className="btn primary" onClick={() => setCreating('user')}><Plus size={16} />Nueva lista</button>
      </div>

      <section className="section">
        <div className="section-head"><h2>Listas</h2></div>
        {data && !lists.length ? (
          <div className="card"><Empty icon={<ListMusic size={22} />} title="Sin listas todavía">
            Crea una aquí, añade canciones desde la Biblioteca, o di a Alexa «añade esta canción a mi lista Favoritas».
          </Empty></div>
        ) : (
          <div className="tiles">
            {lists.map((p) => (
              <button key={p.id} className="tile" onClick={() => setOpen(p)}>
                <div style={{ position: 'relative' }}>
                  <Cover id={p.art_id} name={p.name} />
                  {p.tracks > 0 && <PlayFab onClick={() => playList(p)} />}
                </div>
                <div style={{ minWidth: 0 }}>
                  <div className="tile-title ellipsis">{p.name}</div>
                  <div className="tile-sub ellipsis">{p.tracks} canciones{p.seconds ? ` · ${fmtHours(p.seconds)}` : ''}{p.kind === 'file' ? ' · importada' : ''}</div>
                </div>
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="section">
        <div className="section-head"><h2>Radios por internet</h2></div>
        <div className="card">
          {!radios.length && <Empty icon={<Radio size={22} />} title="Sin radios">Añade la URL del stream de tu emisora favorita y pídesela a Alexa por su nombre.</Empty>}
          {radios.map((r) => (
            <div key={r.id} className="list-item">
              <div className="cover" style={{ width: 40, background: 'var(--accent-soft)', color: 'var(--accent)' }}><Radio size={18} /></div>
              <div className="grow" style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>{r.name}</div>
                <div className="faint small ellipsis mono">{r.stream_url}</div>
              </div>
              <span className="badge hide-sm"><Mic size={12} />«pon la lista {r.name}»</span>
              <button className="btn ghost icon sm" aria-label="Borrar" onClick={async () => {
                if (confirm(`¿Borrar la radio ${r.name}?`)) { await act(() => api(`/api/playlists/${r.id}`, { method: 'DELETE' }), 'Radio borrada'); reload(); }
              }}><Trash2 size={16} /></button>
            </div>
          ))}
        </div>
      </section>

      {creating && <CreateModal kind={creating} onClose={() => setCreating(null)} onDone={() => { setCreating(null); reload(); }} />}
      {open && <PlaylistDrawer playlist={open} onClose={() => { setOpen(null); reload(); }} />}
    </div>
  );
}

function CreateModal({ kind, onClose, onDone }: { kind: 'user' | 'webstream'; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const radio = kind === 'webstream';
  const submit = async () => {
    const r = await act(() => api('/api/playlists', { body: { name, streamUrl: radio ? url : undefined } }), radio ? 'Radio añadida' : 'Lista creada');
    if (r) onDone();
  };
  return (
    <Modal title={radio ? 'Nueva radio' : 'Nueva lista'} onClose={onClose}
      footer={<><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={!name.trim() || (radio && !url.trim())} onClick={submit}>Crear</button></>}>
      <div className="field">
        <label htmlFor="pl-name">Nombre</label>
        <input id="pl-name" className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={radio ? 'Radio Clásica' : 'Para correr'} />
        <span className="hint">Es el nombre que dirás a Alexa: «pon mi lista {name || '…'}».</span>
      </div>
      {radio && (
        <div className="field">
          <label htmlFor="pl-url">URL del stream</label>
          <input id="pl-url" className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://… (.mp3, .aac, .m3u, .pls)" />
          <span className="hint">Si es http:// el servidor la retransmite por HTTPS, que es lo único que Alexa acepta.</span>
        </div>
      )}
    </Modal>
  );
}

function PlaylistDrawer({ playlist, onClose }: { playlist: Playlist; onClose: () => void }) {
  const { data, reload } = useApi<any[]>(`/api/playlists/${playlist.id}/tracks`);
  const [rows, setRows] = useState<any[]>([]);
  const [dirty, setDirty] = useState(false);
  const [name, setName] = useState(playlist.name);
  const [renaming, setRenaming] = useState(false);
  const player = usePlayer();
  useEffect(() => { if (data) { setRows(data); setDirty(false); } }, [data]);

  const move = (i: number, d: number) => {
    const n = rows.slice();
    const [x] = n.splice(i, 1);
    n.splice(i + d, 0, x);
    setRows(n);
    setDirty(true);
  };
  const remove = (i: number) => { setRows(rows.filter((_, j) => j !== i)); setDirty(true); };
  const save = async () => {
    await act(() => api(`/api/playlists/${playlist.id}/tracks`, { method: 'PUT', body: { order: rows.map((r) => r.id) } }), 'Lista guardada');
    reload();
  };
  const total = rows.reduce((n, r) => n + (r.duration || 0), 0);

  return (
    <Drawer onClose={onClose}>
      <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div className="row" style={{ alignItems: 'flex-end', gap: 18 }}>
          <Cover id={rows.find((r) => r.has_art)?.id} name={playlist.name} style={{ width: 112 }} />
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="hero-kicker">{playlist.kind === 'file' ? 'Lista importada' : 'Lista'}</div>
            {renaming ? (
              <form className="row" onSubmit={async (e) => { e.preventDefault(); await act(() => api(`/api/playlists/${playlist.id}`, { method: 'PATCH', body: { name } }), 'Renombrada'); setRenaming(false); }}>
                <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
                <button className="btn primary sm">Guardar</button>
              </form>
            ) : <div className="hero-title" style={{ fontSize: 26 }}>{name}</div>}
            <div className="muted small">{rows.length} canciones · {fmtDuration(total)}</div>
          </div>
          <button className="btn ghost icon sm" onClick={onClose} aria-label="Cerrar" style={{ alignSelf: 'flex-start' }}><X size={18} /></button>
        </div>
        {playlist.kind === 'file' && (
          <div className="card row small muted" style={{ padding: '10px 14px' }}><FileText size={15} />
            <span className="ellipsis mono">{playlist.source_path}</span>
          </div>
        )}
        <div className="row wrap">
          <button className="btn primary" disabled={!rows.length} onClick={() => player.play(rows)}><Play size={16} fill="currentColor" />Escuchar aquí</button>
          {dirty && <button className="btn" onClick={save}>Guardar cambios</button>}
          <span className="spacer" />
          <button className="btn ghost icon" title="Renombrar" aria-label="Renombrar" onClick={() => setRenaming(true)}><Pencil size={16} /></button>
          <a className="btn ghost icon" title="Exportar .m3u" aria-label="Exportar" href={`/api/playlists/${playlist.id}/export.m3u`}><Download size={16} /></a>
          <button className="btn ghost icon danger" title="Borrar lista" aria-label="Borrar" onClick={async () => {
            if (confirm(`¿Borrar la lista ${name}? Las canciones no se tocan.`)) {
              await act(() => api(`/api/playlists/${playlist.id}`, { method: 'DELETE' }), 'Lista borrada');
              onClose();
            }
          }}><Trash2 size={16} /></button>
        </div>
        {playlist.kind === 'file' && dirty && <p className="small" style={{ color: 'var(--warn)' }}>Es una lista importada: si cambia el archivo original, se volverá a importar.</p>}
        <div className="card">
          {!rows.length && <div className="muted" style={{ padding: 16 }}>Lista vacía. Añade canciones desde la Biblioteca.</div>}
          {rows.map((t, i) => (
            <div key={`${t.id}-${i}`} className="list-item" style={{ padding: '8px 12px', opacity: t.hidden ? 0.5 : 1 }}>
              <span className="faint small" style={{ width: 22, textAlign: 'right' }}>{i + 1}</span>
              <Cover id={t.has_art ? t.id : null} name={t.album || t.title} size={96} style={{ width: 36, borderRadius: 7 }} />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="ellipsis" style={{ fontWeight: 550 }}>{t.title}</div>
                <div className="ellipsis faint small">{t.artist}</div>
              </div>
              <button className="btn ghost icon sm" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Subir"><ArrowUp size={15} /></button>
              <button className="btn ghost icon sm" disabled={i === rows.length - 1} onClick={() => move(i, 1)} aria-label="Bajar"><ArrowDown size={15} /></button>
              <button className="btn ghost icon sm" onClick={() => remove(i)} aria-label="Quitar"><X size={15} /></button>
            </div>
          ))}
        </div>
      </div>
    </Drawer>
  );
}
