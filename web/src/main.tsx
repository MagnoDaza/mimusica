import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Home, Library, ListMusic, FolderOpen, Speaker, History, Bell, Settings as Cog, Menu, Mic, Lock,
} from 'lucide-react';
import './styles.css';
import { api, setUnauthorizedHandler, useApi, useRoute } from './lib.ts';
import { Toasts } from './ui.tsx';
import { PlayerProvider } from './player.tsx';
import { HomePage } from './pages/home.tsx';
import { LibraryPage } from './pages/library.tsx';
import { PlaylistsPage } from './pages/playlists.tsx';
import { FoldersPage } from './pages/folders.tsx';
import { AlexaPage } from './pages/alexa.tsx';
import { DevicesPage } from './pages/devices.tsx';
import { HistoryPage } from './pages/history.tsx';
import { MessagesPage } from './pages/messages.tsx';
import { SettingsPage } from './pages/settings.tsx';

const NAV = [
  { to: '/', label: 'Inicio', icon: Home, page: HomePage },
  { to: '/biblioteca', label: 'Biblioteca', icon: Library, page: LibraryPage },
  { to: '/listas', label: 'Listas y radios', icon: ListMusic, page: PlaylistsPage },
  { section: 'Alexa' },
  { to: '/alexa', label: 'Configurar Alexa', icon: Mic, page: AlexaPage },
  { to: '/dispositivos', label: 'Dispositivos', icon: Speaker, page: DevicesPage },
  { to: '/historial', label: 'Peticiones', icon: History, page: HistoryPage },
  { section: 'Sistema' },
  { to: '/carpetas', label: 'Carpetas', icon: FolderOpen, page: FoldersPage },
  { to: '/mensajes', label: 'Mensajes', icon: Bell, page: MessagesPage },
  { to: '/ajustes', label: 'Ajustes', icon: Cog, page: SettingsPage },
] as const;

function Login({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  return (
    <div style={{ minHeight: '100%', display: 'grid', placeItems: 'center', padding: 16 }}>
      <form className="card pad col" style={{ width: 'min(380px, 100%)', gap: 16 }}
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await api('/api/login', { body: { password: pw } });
            onDone();
          } catch (e) {
            setErr((e as Error).message);
          }
        }}>
        <div className="row"><img src="/favicon.svg" className="brand-mark" alt="" /><span className="brand-name">Mi Música</span></div>
        <div className="field">
          <label htmlFor="pw">Contraseña</label>
          <input id="pw" className="input" type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} />
          {err && <span className="small" style={{ color: 'var(--err)' }}>{err}</span>}
        </div>
        <button className="btn primary"><Lock size={16} />Entrar</button>
      </form>
    </div>
  );
}

function App() {
  const [route] = useRoute();
  const [navOpen, setNavOpen] = useState(false);
  const [authed, setAuthed] = useState<boolean | undefined>();
  const msgs = useApi<any[]>(authed ? '/api/messages?limit=50' : null, { poll: 15000 });

  useEffect(() => {
    setUnauthorizedHandler(() => setAuthed(false));
    api<{ authed: boolean }>('/api/session').then((s) => setAuthed(s.authed)).catch(() => setAuthed(true));
  }, []);
  useEffect(() => setNavOpen(false), [route]);

  if (authed === undefined) return null;
  if (!authed) return <Login onDone={() => setAuthed(true)} />;

  const current = NAV.find((n) => 'to' in n && (n.to === route || (n.to !== '/' && route.startsWith(n.to)))) ?? NAV[0];
  const Page = 'page' in current ? current.page : HomePage;
  const warnings = (msgs.data ?? []).filter((m) => m.level !== 'info' && Date.now() - m.ts < 86400_000).length;

  return (
    <PlayerProvider>
      <div className={`shell ${navOpen ? 'nav-open' : ''}`}>
        {navOpen && <div className="scrim" onClick={() => setNavOpen(false)} />}
        <nav className="sidebar" aria-label="Principal">
          <div className="brand"><img src="/favicon.svg" className="brand-mark" alt="" /><span className="brand-name">Mi Música</span></div>
          {NAV.map((n, i) =>
            'section' in n ? (
              <div key={i} className="nav-label">{n.section}</div>
            ) : (
              <a key={n.to} href={`#${n.to}`} className={`nav-item ${n === current ? 'active' : ''}`}>
                <n.icon size={18} />
                {n.label}
                {n.to === '/mensajes' && warnings > 0 && <span className="badge warn">{warnings}</span>}
              </a>
            ),
          )}
          <div className="sidebar-foot">Tu música, en tu NAS, en tu Alexa.</div>
        </nav>
        <div style={{ minWidth: 0 }}>
          <div className="mobile-bar">
            <button className="btn ghost icon" onClick={() => setNavOpen(true)} aria-label="Menú"><Menu size={20} /></button>
            <img src="/favicon.svg" className="brand-mark" alt="" style={{ width: 26, height: 26 }} />
            <span className="brand-name" style={{ fontSize: 16 }}>Mi Música</span>
          </div>
          <main className="main">
            <Page />
          </main>
        </div>
      </div>
      <Toasts />
    </PlayerProvider>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
