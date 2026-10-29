import { useEffect, useState, type ReactNode } from 'react';
import { X, Copy, Check, Play } from 'lucide-react';
import { gradientFor, initials, useToasts, toast } from './lib.ts';

export function Cover({ id, name, size = 300, round, className = '', style }: {
  id?: string | null; name: string; size?: number; round?: boolean; className?: string; style?: React.CSSProperties;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [id]);
  return (
    <div className={`cover ${round ? 'round' : ''} ${className}`} style={style}>
      {id && !failed ? (
        <img src={`/art/${id}?s=${size}`} alt="" loading="lazy" onError={() => setFailed(true)} />
      ) : (
        <div className="cover-fallback" style={{ background: gradientFor(name) }}>{initials(name || '?')}</div>
      )}
    </div>
  );
}

export function Modal({ title, onClose, children, footer, wide }: {
  title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h2 className="grow">{title}</h2>
          <button className="btn ghost icon sm" onClick={onClose} aria-label="Cerrar"><X size={18} /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Drawer({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="overlay drawer-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-modal="true">{children}</aside>
    </div>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-label={label} />
      <span />
    </label>
  );
}

export function Empty({ icon, title, children, action }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="icon-wrap">{icon}</div>
      <h3>{title}</h3>
      {children && <p style={{ maxWidth: 420 }}>{children}</p>}
      {action}
    </div>
  );
}

export function CopyField({ value, label }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Non-secure origins (http://nas:8080) have no clipboard API.
      const ta = document.createElement('textarea');
      ta.value = value;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setDone(true);
    toast(label ? `${label} copiado` : 'Copiado');
    setTimeout(() => setDone(false), 1500);
  };
  return (
    <div className="code">
      <code>{value}</code>
      <button className="btn ghost icon sm" onClick={copy} aria-label="Copiar">{done ? <Check size={15} /> : <Copy size={15} />}</button>
    </div>
  );
}

export function Toasts() {
  const list = useToasts();
  return (
    <div className="toasts" aria-live="polite">
      {list.map((t) => <div key={t.id} className={`toast ${t.kind === 'error' ? 'error' : ''}`}>{t.text}</div>)}
    </div>
  );
}

export function PlayFab({ onClick, label = 'Reproducir aquí' }: { onClick: (e: React.MouseEvent) => void; label?: string }) {
  return (
    <span className="play-fab">
      <span className="fab" role="button" tabIndex={-1} aria-label={label} title={label}
        onClick={(e) => { e.stopPropagation(); onClick(e); }}>
        <Play size={18} fill="currentColor" />
      </span>
    </span>
  );
}

export function Eq() {
  return <span className="eq" aria-hidden><i /><i /><i /></span>;
}

export function Skeleton({ h = 16, w = '100%', r }: { h?: number; w?: number | string; r?: number }) {
  return <div className="skeleton" style={{ height: h, width: w, borderRadius: r }} />;
}
