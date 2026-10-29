import { useEffect, useMemo, useState } from 'react';
import {
  Search, EyeOff, Eye, RefreshCw, ListPlus, Mic, ChevronLeft, ChevronRight, ArrowUpDown, BookOpen, Play, Music2, X, Wand2,
} from 'lucide-react';
import { api, act, useApi, useDebounced, useRoute, navigate, fmtDuration, nf } from '../lib.ts';
import { Cover, Drawer, Empty, Modal, PlayFab, Skeleton } from '../ui.tsx';
import { usePlayer } from '../player.tsx';

type Track = {
  id: string; title: string; artist: string; album: string; genre: string; year: number; duration: number; codec: string;
  transcode: string; hidden: number; audiobook: number; play_count: number; has_art: number; path: string; track_no: number; disc: number;
};
type Page<T> = { total: number; page: number; size: number; rows: T[] };

const TABS = [
  ['canciones', 'Canciones'], ['albumes', 'Álbumes'], ['artistas', 'Artistas'], ['generos', 'Géneros'], ['audiolibros', 'Audiolibros'],
] as const;

export function LibraryPage() {
  const [, params] = useRoute();
  const tab = params.get('t') ?? 'albumes';
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const [detail, setDetail] = useState<{ type: 'album' | 'artist' | 'genre'; value: string } | null>(null);

  return (
    <div className="page">
      <div className="page-head">
        <div className="grow">
          <h1>Biblioteca</h1>
          <p className="sub">Todo lo que Alexa puede encontrar.</p>
        </div>
        <div className="search" style={{ width: 'min(340px, 100%)' }}>
          <Search size={16} />
          <input className="input" placeholder="Buscar canción, artista, álbum…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      <div className="tabs" role="tablist">
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`tab ${tab === k ? 'active' : ''}`} onClick={() => navigate(`/biblioteca?t=${k}`)}>{label}</button>
        ))}
      </div>
      {tab === 'canciones' && <TrackTable query={{ q: dq }} />}
      {tab === 'audiolibros' && <TrackTable query={{ q: dq, audiobook: '1' }} defaultSort="album" />}
      {tab === 'albumes' && <GroupGrid type="albums" q={dq} onOpen={(v) => setDetail({ type: 'album', value: v })} />}
      {tab === 'artistas' && <GroupGrid type="artists" q={dq} onOpen={(v) => setDetail({ type: 'artist', value: v })} />}
      {tab === 'generos' && <GroupGrid type="genres" q={dq} onOpen={(v) => setDetail({ type: 'genre', value: v })} />}
      {detail && <DetailDrawer {...detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------- grids

function GroupGrid({ type, q, onOpen }: { type: 'albums' | 'artists' | 'genres'; q: string; onOpen: (v: string) => void }) {
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [q, type]);
  const { data, loading } = useApi<Page<any>>(`/api/groups/${type}?q=${encodeURIComponent(q)}&page=${page}&size=60`);
  const player = usePlayer();

  const playGroup = async (name: string) => {
    const key = type === 'albums' ? 'album' : type === 'artists' ? 'artist' : 'genre';
    const r = await api<Page<Track>>(`/api/tracks?${key}=${encodeURIComponent(name)}&size=200&sort=${type === 'albums' ? 'track' : 'album'}`);
    player.play(r.rows);
  };

  if (loading && !data) {
    return <div className="tiles">{Array.from({ length: 12 }, (_, i) => <div key={i} className="col"><Skeleton h={160} r={10} /><Skeleton h={12} w="70%" /></div>)}</div>;
  }
  if (!data?.rows.length) {
    return <Empty icon={<Music2 size={22} />} title={q ? 'Sin resultados' : 'Tu biblioteca está vacía'}>
      {q ? `Nada coincide con «${q}».` : <>Añade una carpeta en <a href="#/carpetas">Carpetas</a> y espera a que termine el escaneo.</>}
    </Empty>;
  }
  return (
    <>
      <div className="tiles">
        {data.rows.map((g) => (
          <button key={g.name} className="tile" onClick={() => onOpen(g.name)}>
            <div style={{ position: 'relative' }}>
              <Cover id={g.art_id} name={g.name} round={type === 'artists'} />
              <PlayFab onClick={() => playGroup(g.name)} />
            </div>
            <div style={{ minWidth: 0 }}>
              <div className="tile-title ellipsis">{g.name}</div>
              <div className="tile-sub ellipsis">
                {type === 'albums' && <>{g.album_artist || g.artist}{g.year ? ` · ${g.year}` : ''}{g.audiobook ? ' · Audiolibro' : ''}</>}
                {type === 'artists' && <>{g.albums} {g.albums === 1 ? 'álbum' : 'álbumes'} · {g.tracks} canciones</>}
                {type === 'genres' && <>{g.tracks} canciones · {g.artists} artistas</>}
              </div>
            </div>
          </button>
        ))}
      </div>
      <Pager total={data.total} page={page} size={data.size} onPage={setPage} bare />
    </>
  );
}

function DetailDrawer({ type, value, onClose }: { type: 'album' | 'artist' | 'genre'; value: string; onClose: () => void }) {
  const { data } = useApi<Page<Track>>(`/api/tracks?${type}=${encodeURIComponent(value)}&size=500&sort=${type === 'album' ? 'track' : 'album'}`);
  const player = usePlayer();
  const rows = data?.rows ?? [];
  const first = rows.find((r) => r.has_art);
  const total = rows.reduce((n, r) => n + r.duration, 0);
  const isBook = rows.length > 0 && rows.every((r) => r.audiobook);
  const say = type === 'album' ? (isBook ? `lee el libro ${value}` : `pon el álbum ${value}`) : type === 'artist' ? `pon música de ${value}` : `pon música ${value}`;

  return (
    <Drawer onClose={onClose}>
      <div style={{ position: 'relative', padding: 24, overflow: 'hidden' }}>
        <div className={`hero-bg ${first ? '' : 'grad'}`} style={first ? { backgroundImage: `url(/art/${first.id}?s=300)` } : undefined} />
        <div className="row" style={{ position: 'relative', alignItems: 'flex-end', gap: 18 }}>
          <Cover id={first?.id} name={value} size={300} round={type === 'artist'} style={{ width: 120 }} />
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="hero-kicker">{type === 'album' ? (isBook ? 'Audiolibro' : 'Álbum') : type === 'artist' ? 'Artista' : 'Género'}</div>
            <div className="hero-title" style={{ fontSize: 26 }}>{value}</div>
            <div className="muted small">{rows.length} pistas · {fmtDuration(total)}</div>
          </div>
          <button className="btn ghost icon sm" onClick={onClose} aria-label="Cerrar" style={{ alignSelf: 'flex-start' }}><X size={18} /></button>
        </div>
        <div className="row wrap" style={{ position: 'relative', marginTop: 18 }}>
          <button className="btn primary" onClick={() => player.play(rows)} disabled={!rows.length}><Play size={16} fill="currentColor" />Escuchar aquí</button>
          {type === 'album' && (
            <button className="btn" onClick={() => act(() => api('/api/albums/audiobook', { body: { album: value, value: !isBook } }), isBook ? 'Ya no es audiolibro' : 'Marcado como audiolibro')}>
              <BookOpen size={16} />{isBook ? 'No es audiolibro' : 'Es un audiolibro'}
            </button>
          )}
        </div>
        <div className="card pad row" style={{ position: 'relative', marginTop: 16, padding: '10px 14px' }}>
          <Mic size={16} color="var(--accent)" /><span className="small">Dile a Alexa: <b>«{say}»</b></span>
        </div>
      </div>
      <div style={{ padding: '0 12px 24px' }}>
        <TrackTable rowsOverride={rows} compact />
      </div>
    </Drawer>
  );
}

// ---------------------------------------------------------------- track table

const SORTABLE: [string, string][] = [['title', 'Título'], ['artist', 'Artista'], ['album', 'Álbum'], ['duration', 'Duración'], ['playcount', 'Escuchas']];

export function TrackTable({ query = {}, rowsOverride, compact, defaultSort = 'artist' }: {
  query?: Record<string, string>; rowsOverride?: Track[]; compact?: boolean; defaultSort?: string;
}) {
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState(defaultSort);
  const [order, setOrder] = useState<'asc' | 'desc'>('asc');
  const [filter, setFilter] = useState<'all' | 'hidden' | 'transcode'>('all');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [addTo, setAddTo] = useState(false);
  const player = usePlayer();

  const qs = useMemo(() => {
    const p = new URLSearchParams({ ...query, page: String(page), size: '100', sort, order });
    if (filter === 'hidden') p.set('hidden', '1');
    if (filter === 'transcode') p.set('transcode', '1');
    return p.toString();
  }, [JSON.stringify(query), page, sort, order, filter]);
  useEffect(() => setPage(0), [JSON.stringify(query), filter]);
  const remote = useApi<Page<Track>>(rowsOverride ? null : `/api/tracks?${qs}`);
  const rows = rowsOverride ?? remote.data?.rows ?? [];
  const reload = () => remote.reload();

  const toggle = (id: string) => setSel((s) => {
    const n = new Set(s);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });
  const allSelected = rows.length > 0 && rows.every((r) => sel.has(r.id));
  const ids = [...sel];
  const bulk = async (path: string, msg: string) => {
    await act(() => api(path, { body: { ids } }), msg);
    setSel(new Set());
    reload();
  };

  const headerSort = (k: string) => {
    if (sort === k) setOrder(order === 'asc' ? 'desc' : 'asc');
    else { setSort(k); setOrder('asc'); }
  };

  return (
    <div className="section">
      {!compact && !rowsOverride && (
        <div className="row wrap">
          <div className="tabs">
            {([['all', 'Todas'], ['hidden', 'Ocultas'], ['transcode', 'Necesitan conversión']] as const).map(([k, l]) => (
              <button key={k} className={`tab ${filter === k ? 'active' : ''}`} onClick={() => setFilter(k)}>{l}</button>
            ))}
          </div>
          <span className="spacer" />
          {remote.data && <span className="faint small">{nf.format(remote.data.total)} canciones</span>}
        </div>
      )}
      {sel.size > 0 && (
        <div className="selection-bar">
          <b>{sel.size} seleccionadas</b>
          <span className="spacer" />
          <button className="btn sm" onClick={() => player.play(rows.filter((r) => sel.has(r.id)))}><Play size={14} />Escuchar</button>
          <button className="btn sm" onClick={() => setAddTo(true)}><ListPlus size={14} />A una lista</button>
          <button className="btn sm" title="Luego di «Alexa, pide a … que ponga la selección»"
            onClick={async () => { await act(() => api('/api/selection', { body: { ids } }), 'Selección lista: di «pon la selección»'); setSel(new Set()); }}>
            <Mic size={14} />Selección para Alexa
          </button>
          <button className="btn sm" onClick={() => bulk('/api/tracks/hide', 'Ocultadas: Alexa no las pondrá')}><EyeOff size={14} />Ocultar</button>
          <button className="btn sm" onClick={() => bulk('/api/tracks/unhide', 'Visibles de nuevo')}><Eye size={14} />Mostrar</button>
          <button className="btn sm" onClick={() => bulk('/api/tracks/rescan', 'Etiquetas releídas')}><RefreshCw size={14} />Releer</button>
          <button className="btn ghost icon sm" onClick={() => setSel(new Set())} aria-label="Quitar selección"><X size={15} /></button>
        </div>
      )}
      <div className={compact ? '' : 'card'}>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th className="check"><input type="checkbox" className="checkbox" checked={allSelected} aria-label="Seleccionar todo"
                  onChange={() => setSel(allSelected ? new Set() : new Set(rows.map((r) => r.id)))} /></th>
                {SORTABLE.map(([k, l]) => (
                  <th key={k} className={k === 'duration' || k === 'playcount' ? 'num hide-sm' : k === 'album' ? 'hide-sm' : ''}>
                    {rowsOverride ? l : <button onClick={() => headerSort(k)}>{l}{sort === k && <ArrowUpDown size={12} />}</button>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {remote.loading && !rowsOverride && !remote.data && Array.from({ length: 8 }, (_, i) => (
                <tr key={i}><td /><td colSpan={5}><Skeleton h={14} /></td></tr>
              ))}
              {rows.map((t, i) => (
                <tr key={t.id} className={sel.has(t.id) ? 'selected' : ''} style={{ opacity: t.hidden ? 0.5 : 1 }}
                  onDoubleClick={() => player.play(rows, i)}>
                  <td className="check"><input type="checkbox" className="checkbox" checked={sel.has(t.id)} onChange={() => toggle(t.id)} aria-label={`Seleccionar ${t.title}`} /></td>
                  <td style={{ maxWidth: 360 }}>
                    <div className="row" style={{ gap: 12 }}>
                      <button className="btn ghost icon sm" onClick={() => player.play(rows, i)} aria-label={`Escuchar ${t.title}`} style={{ padding: 0 }}>
                        <Cover id={t.has_art ? t.id : null} name={t.album || t.title} size={96} style={{ width: 34, borderRadius: 7 }} />
                      </button>
                      <div className="col" style={{ gap: 0, minWidth: 0 }}>
                        <span className="ellipsis" style={{ fontWeight: 550 }}>{compact && t.track_no ? `${t.track_no}. ` : ''}{t.title}</span>
                        <span className="row" style={{ gap: 6 }}>
                          {t.hidden ? <span className="badge">oculta</span> : null}
                          {t.transcode !== 'none' ? <span className="badge" title={t.codec}>{t.transcode === 'recode' ? 'se convierte' : 'se reempaqueta'}</span> : null}
                          {t.audiobook ? <span className="badge accent">audiolibro</span> : null}
                        </span>
                      </div>
                    </div>
                  </td>
                  <td className="ellipsis" style={{ maxWidth: 200 }}>{t.artist}</td>
                  <td className="ellipsis hide-sm muted" style={{ maxWidth: 220 }}>{t.album}</td>
                  <td className="num hide-sm">{fmtDuration(t.duration)}</td>
                  <td className="num hide-sm">{t.play_count || ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!rowsOverride && remote.data && remote.data.total > remote.data.size && (
          <Pager total={remote.data.total} page={page} size={remote.data.size} onPage={setPage} />
        )}
        {!rowsOverride && remote.data && !rows.length && (
          <Empty icon={<Wand2 size={22} />} title="Nada por aquí">No hay canciones con estos filtros.</Empty>
        )}
      </div>
      {addTo && <AddToPlaylist ids={ids} onClose={() => { setAddTo(false); setSel(new Set()); }} />}
    </div>
  );
}

export function Pager({ total, page, size, onPage, bare }: { total: number; page: number; size: number; onPage: (p: number) => void; bare?: boolean }) {
  const pages = Math.ceil(total / size);
  if (pages <= 1) return null;
  return (
    <div className="pager" style={bare ? { borderTop: 0 } : undefined}>
      <span>{page * size + 1}–{Math.min(total, (page + 1) * size)} de {nf.format(total)}</span>
      <button className="btn icon sm" disabled={page === 0} onClick={() => onPage(page - 1)} aria-label="Anterior"><ChevronLeft size={16} /></button>
      <button className="btn icon sm" disabled={page >= pages - 1} onClick={() => onPage(page + 1)} aria-label="Siguiente"><ChevronRight size={16} /></button>
    </div>
  );
}

export function AddToPlaylist({ ids, onClose }: { ids: string[]; onClose: () => void }) {
  const { data } = useApi<any[]>('/api/playlists');
  const [name, setName] = useState('');
  const lists = (data ?? []).filter((p) => p.kind === 'user');
  const add = async (pid: string, label: string) => {
    await act(() => api(`/api/playlists/${pid}/tracks`, { body: { ids } }), `Añadidas a ${label}`);
    onClose();
  };
  return (
    <Modal title={`Añadir ${ids.length} ${ids.length === 1 ? 'canción' : 'canciones'} a…`} onClose={onClose}>
      <form className="row" onSubmit={async (e) => {
        e.preventDefault();
        const p = await act(() => api('/api/playlists', { body: { name } }));
        if (p) await add(p.id, p.name);
      }}>
        <input className="input" placeholder="Nueva lista…" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn primary" disabled={!name.trim()}>Crear y añadir</button>
      </form>
      <div className="card">
        {lists.length === 0 && <div className="muted" style={{ padding: 16 }}>Aún no tienes listas propias.</div>}
        {lists.map((p) => (
          <button key={p.id} className="list-item btn ghost" style={{ width: '100%', height: 'auto', justifyContent: 'flex-start', borderRadius: 0 }} onClick={() => add(p.id, p.name)}>
            <Cover id={p.art_id} name={p.name} size={96} style={{ width: 36, borderRadius: 7 }} />
            <span className="grow ellipsis" style={{ textAlign: 'left' }}>{p.name}</span>
            <span className="faint small">{p.tracks}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}
