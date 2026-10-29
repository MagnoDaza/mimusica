import { useEffect, useState } from 'react';
import { Check, Download, Globe, Mic, PlugZap, Search, ExternalLink, Loader2 } from 'lucide-react';
import { api, act, useApi } from '../lib.ts';
import { CopyField, Cover } from '../ui.tsx';

type S = { publicUrl: string; skillId: string; invocationName: string; envPublicUrl: boolean };

export function AlexaPage() {
  const { data: s, reload } = useApi<S>('/api/settings');
  const summary = useApi<any>('/api/summary');
  const [form, setForm] = useState<Partial<S>>({});
  const [check, setCheck] = useState<{ ok: boolean; error?: string } | null>(null);
  const [checking, setChecking] = useState(false);
  useEffect(() => { if (s) setForm({ publicUrl: s.publicUrl, skillId: s.skillId, invocationName: s.invocationName }); }, [s]);

  const save = async () => {
    await act(() => api('/api/settings', { method: 'PUT', body: form }), 'Guardado');
    reload();
  };
  const runCheck = async () => {
    setChecking(true);
    setCheck(await api('/api/alexa/check').catch((e) => ({ ok: false, error: e.message })));
    setChecking(false);
  };
  const endpoint = s?.publicUrl ? `${s.publicUrl}/alexa` : 'https://<tu-nas>.<tu-tailnet>.ts.net/alexa';
  const setup = summary.data?.setup ?? {};

  return (
    <div className="page">
      <div className="page-head">
        <div className="grow">
          <h1>Configurar Alexa</h1>
          <p className="sub">Tu propia skill, en modo desarrollo, en tu cuenta de Amazon. Sin suscripciones ni servidores de terceros.</p>
        </div>
      </div>

      <div className="split">
        <div className="card">
          <div className="steps">
            <Step n={1} done={!!setup.publicUrl} title="Publica el NAS con Tailscale Funnel">
              <p className="muted">Alexa llama a tu servidor desde Internet, por HTTPS. Funnel le da una dirección <span className="mono">*.ts.net</span> con certificado válido, sin abrir puertos del router. Solo se publica el puerto de Alexa (8081); esta consola sigue siendo privada.</p>
              <ol>
                <li>En <a href="https://login.tailscale.com/admin/dns" target="_blank" rel="noreferrer">Tailscale → DNS</a> activa <b>MagicDNS</b> y <b>HTTPS Certificates</b>.</li>
                <li>En <a href="https://login.tailscale.com/admin/acls/file" target="_blank" rel="noreferrer">Access controls</a> permite Funnel al nodo (el docker-compose usa <span className="mono">tag:mimusica</span>):</li>
              </ol>
              <CopyField label="Política" value={`"tagOwners": { "tag:mimusica": ["autogroup:admin"] },\n"nodeAttrs": [ { "target": ["tag:mimusica"], "attr": ["funnel"] } ]`} />
              <ol start={3}>
                <li>Crea una <a href="https://login.tailscale.com/admin/settings/keys" target="_blank" rel="noreferrer">auth key</a> (reutilizable no hace falta; marca la etiqueta <span className="mono">tag:mimusica</span>) y ponla en <span className="mono">TS_AUTHKEY</span> del archivo <span className="mono">.env</span>.</li>
                <li>Arranca el compose. Tu URL pública será <span className="mono">https://mimusica.&lt;tu-tailnet&gt;.ts.net</span>.</li>
              </ol>
              <div className="field">
                <label htmlFor="pub">URL pública</label>
                <div className="row">
                  <input id="pub" className="input mono" value={form.publicUrl ?? ''} disabled={s?.envPublicUrl}
                    onChange={(e) => setForm({ ...form, publicUrl: e.target.value })} placeholder="https://mimusica.tu-tailnet.ts.net" />
                  <button className="btn" onClick={runCheck} disabled={checking || !s?.publicUrl}>
                    {checking ? <Loader2 size={16} className="spin" /> : <PlugZap size={16} />}Comprobar
                  </button>
                </div>
                {s?.envPublicUrl && <span className="hint">Fijada con la variable PUBLIC_URL del docker-compose.</span>}
                {check && (check.ok
                  ? <span className="small" style={{ color: 'var(--ok)' }}>✓ Se llega al servidor desde Internet.</span>
                  : <span className="small" style={{ color: 'var(--err)' }}>No responde: {check.error ?? 'respuesta inesperada'}. ¿Está Funnel activo?</span>)}
              </div>
            </Step>

            <Step n={2} done={!!setup.skill} title="Crea la skill en Amazon">
              <ol>
                <li>Entra en la <a href="https://developer.amazon.com/alexa/console/ask" target="_blank" rel="noreferrer">consola de Alexa Skills <ExternalLink size={12} /></a> con <b>la misma cuenta de tus Echo</b> y pulsa <b>Create Skill</b>.</li>
                <li>Nombre: el que quieras. Idioma: <b>Spanish (ES)</b>, <b>(MX)</b> o <b>(US)</b> según tus Echo. Tipo: <b>Other → Custom</b>. Hosting: <b>Provision your own</b>. Plantilla: <b>Start from Scratch</b>.</li>
                <li>En <b>Build → Interfaces</b> activa <b>Audio Player</b> y guarda.</li>
                <li>En <b>Interaction Model → JSON Editor</b> arrastra el modelo de abajo, pulsa <b>Save</b> y luego <b>Build skill</b>. Cuando añadas mucha música nueva, descárgalo y pégalo otra vez: lleva los nombres de tus artistas y álbumes para que Alexa los entienda mejor.</li>
              </ol>
              <div className="row wrap">
                <div className="field grow" style={{ minWidth: 220 }}>
                  <label htmlFor="inv">Nombre de invocación</label>
                  <input id="inv" className="input" value={form.invocationName ?? ''} onChange={(e) => setForm({ ...form, invocationName: e.target.value })} />
                  <span className="hint">Mínimo dos palabras: «Alexa, pide a <b>{form.invocationName || 'mi biblioteca'}</b> que ponga…»</span>
                </div>
                <a className="btn primary" href="/api/alexa/model" download onClick={() => setTimeout(save, 0)}><Download size={16} />Modelo de interacción</a>
              </div>
              <ol start={5}>
                <li>En <b>Endpoint</b> elige <b>HTTPS</b>, pega esta URL en <i>Default Region</i> y en el desplegable de certificado elige <b>«My development endpoint has a certificate from a trusted certificate authority»</b>:</li>
              </ol>
              <CopyField label="Endpoint" value={endpoint} />
              <ol start={6}>
                <li>Copia el <b>Skill ID</b> (arriba en la página Endpoint, empieza por <span className="mono">amzn1.ask.skill.</span>) y pégalo aquí. Así el servidor rechaza peticiones de cualquier otra skill.</li>
              </ol>
              <div className="field">
                <label htmlFor="sid">Skill ID</label>
                <input id="sid" className="input mono" value={form.skillId ?? ''} onChange={(e) => setForm({ ...form, skillId: e.target.value })} placeholder="amzn1.ask.skill.xxxxxxxx-xxxx-…" />
              </div>
              <div><button className="btn primary" onClick={save}><Check size={16} />Guardar</button></div>
            </Step>

            <Step n={3} done={!!setup.firstRequest} title="Actívala y prueba">
              <ol>
                <li>En la pestaña <b>Test</b> de la consola cambia «Off» por <b>Development</b>. Ya está disponible en todos tus Echo, sin publicarla.</li>
                <li>Di: <b>«Alexa, abre {form.invocationName || 'mi biblioteca'}»</b>, o directamente <b>«Alexa, pide a {form.invocationName || 'mi biblioteca'} que ponga música de Queen»</b>.</li>
              </ol>
            </Step>
          </div>
        </div>

        <div className="col" style={{ gap: 20 }}>
          <Tester />
          <div className="card pad col" style={{ gap: 10 }}>
            <h2>Qué puedes decir</h2>
            {[
              'pon música de Shakira', 'pon el álbum Canción Animal', 'pon la canción Hotel California de Eagles', 'pon música jazz',
              'pon mi lista Favoritas', 'lee el libro El Principito', 'continúa donde lo dejé', 'qué suena',
              'añade esta canción a mi lista Gimnasio', 'no vuelvas a poner esta canción', 'pon la selección',
            ].map((u) => (
              <div key={u} className="row small"><Mic size={14} color="var(--accent)" /><span>«…{u}»</span></div>
            ))}
            <p className="faint small">Y durante la reproducción: «Alexa, siguiente / anterior / pausa / continúa / aleatorio / repite».</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function Step({ n, done, title, children }: { n: number; done?: boolean; title: string; children: React.ReactNode }) {
  return (
    <div className={`step ${done ? 'done' : ''}`}>
      <div className="step-num">{done ? <Check size={15} /> : n}</div>
      <div className="step-body"><h3>{title}</h3>{children}</div>
    </div>
  );
}

const FIELDS = [['query', 'Cualquier cosa'], ['artist', 'Artista'], ['album', 'Álbum'], ['song', 'Canción'], ['genre', 'Género'], ['playlist', 'Lista'], ['book', 'Audiolibro']] as const;

function Tester() {
  const [field, setField] = useState<(typeof FIELDS)[number][0]>('query');
  const [text, setText] = useState('');
  const [res, setRes] = useState<any>(null);
  const run = async (e: React.FormEvent) => {
    e.preventDefault();
    setRes(await act(() => api('/api/alexa/test', { body: { [field]: text } })));
  };
  return (
    <div className="card pad col" style={{ gap: 12 }}>
      <div className="row"><Globe size={18} color="var(--accent)" /><h2>Probar sin Echo</h2></div>
      <p className="muted small">Comprueba qué sonaría con una petición, usando la misma búsqueda que Alexa (tolera errores, acentos y palabras sueltas).</p>
      <form className="col" style={{ gap: 8 }} onSubmit={run}>
        <div className="row">
          <select className="select" style={{ width: 150 }} value={field} onChange={(e) => setField(e.target.value as any)}>
            {FIELDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder="ej. bohemian rapsody" />
        </div>
        <button className="btn" disabled={!text.trim()}><Search size={16} />Buscar como Alexa</button>
      </form>
      {res && (res.ok ? (
        <div className="col" style={{ gap: 8 }}>
          <div className="row"><span className="badge ok">Sonaría</span><b className="ellipsis">{res.name}</b><span className="faint small">{res.trackCount} pistas</span></div>
          {res.tracks.slice(0, 6).map((t: any) => (
            <div key={t.id} className="row small" style={{ gap: 10 }}>
              <Cover id={t.id} name={t.album || t.title} size={96} style={{ width: 28, borderRadius: 6 }} />
              <span className="ellipsis grow">{t.title} <span className="faint">— {t.artist}</span></span>
            </div>
          ))}
        </div>
      ) : <div className="row"><span className="badge err">Sin resultados</span><span className="small muted">Puedes enseñarle con un aprendizaje en Peticiones.</span></div>)}
    </div>
  );
}
