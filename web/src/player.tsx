import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Pause, Play, SkipBack, SkipForward, X } from 'lucide-react';
import { Cover } from './ui.tsx';
import { fmtDuration } from './lib.ts';

export type PTrack = { id: string; title: string; artist?: string; album?: string; has_art?: number };

type Ctx = { play: (list: PTrack[], index?: number) => void; current?: PTrack };
const PlayerCtx = createContext<Ctx>({ play: () => {} });
export const usePlayer = () => useContext(PlayerCtx);

/** In-browser preview player (the console's way to listen; Alexa plays on its own). */
export function PlayerProvider({ children }: { children: ReactNode }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [list, setList] = useState<PTrack[]>([]);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [dur, setDur] = useState(0);
  const current = list[idx];

  useEffect(() => {
    const a = audio.current;
    if (!a || !current) return;
    a.src = `/stream/${current.id}`;
    void a.play().catch(() => setPlaying(false));
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: current.title, artist: current.artist ?? '', album: current.album ?? '',
        artwork: current.has_art ? [{ src: `/art/${current.id}?s=512`, sizes: '512x512', type: 'image/jpeg' }] : [],
      });
    }
  }, [current?.id]);

  const play = (l: PTrack[], i = 0) => {
    setList(l);
    setIdx(i);
  };
  const next = () => idx < list.length - 1 && setIdx(idx + 1);
  const prev = () => (time > 3 && audio.current ? (audio.current.currentTime = 0) : idx > 0 && setIdx(idx - 1));
  const close = () => {
    audio.current?.pause();
    setList([]);
  };

  return (
    <PlayerCtx.Provider value={{ play, current }}>
      {children}
      <audio
        ref={audio}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onDurationChange={(e) => setDur(e.currentTarget.duration)}
        onEnded={next}
      />
      {current && (
        <div className="player">
          <div className="row" style={{ minWidth: 0 }}>
            <Cover id={current.has_art ? current.id : null} name={current.album || current.title} size={96} />
            <div className="col" style={{ gap: 0, minWidth: 0 }}>
              <div className="ellipsis" style={{ fontWeight: 600 }}>{current.title}</div>
              <div className="ellipsis muted small">{current.artist}</div>
            </div>
          </div>
          <div className="col" style={{ alignItems: 'center', gap: 2 }}>
            <div className="player-controls">
              <button className="btn ghost icon sm" onClick={prev} aria-label="Anterior"><SkipBack size={17} /></button>
              <button className="fab" onClick={() => (playing ? audio.current?.pause() : audio.current?.play())} aria-label={playing ? 'Pausa' : 'Reproducir'}>
                {playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" />}
              </button>
              <button className="btn ghost icon sm" onClick={next} disabled={idx >= list.length - 1} aria-label="Siguiente"><SkipForward size={17} /></button>
            </div>
            <div className="player-time">
              <span>{fmtDuration(time)}</span>
              <input type="range" min={0} max={dur || 0} step={1} value={time}
                onChange={(e) => audio.current && (audio.current.currentTime = Number(e.target.value))} aria-label="Posición" />
              <span>{fmtDuration(dur)}</span>
            </div>
          </div>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <span className="faint small hide-sm">Vista previa en este navegador</span>
            <button className="btn ghost icon sm" onClick={close} aria-label="Cerrar reproductor"><X size={17} /></button>
          </div>
        </div>
      )}
    </PlayerCtx.Provider>
  );
}
