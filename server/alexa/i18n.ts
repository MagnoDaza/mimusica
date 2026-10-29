// Spoken responses (Spanish; the same strings serve es-ES, es-MX and es-US).

const es: Record<string, string | ((...a: string[]) => string)> = {
  welcome: '¿Qué quieres escuchar? Por ejemplo: pon música de Queen, o pon el álbum Thriller.',
  reprompt: '¿Qué te pongo?',
  playing: (name) => `Poniendo ${name}.`,
  resuming: (name) => `Continuando ${name}.`,
  notFound: (what) => `No encontré ${what} en tu biblioteca.`,
  didntCatch: 'No te entendí bien. ¿Qué quieres escuchar?',
  nothingPlayable: 'No hay pistas que se puedan reproducir.',
  nothingToNavigate: 'No hay nada sonando ahora.',
  nothingPlaying: 'Ahora no está sonando nada de tu biblioteca.',
  atEnd: 'Es la última pista de la lista.',
  atStart: 'Es la primera pista de la lista.',
  emptyLibrary: 'Tu biblioteca está vacía. Añade una carpeta desde la consola web.',
  noSelection: 'No hay ninguna selección. Créala desde la consola web.',
  nowPlaying: (title, artist, album) =>
    `Suena ${title}${artist ? `, de ${artist}` : ''}${album ? `, del álbum ${album}` : ''}.`,
  whichPlaylist: '¿A qué lista la añado?',
  addedToPlaylist: (title, list) => `Añadí ${title} a tu lista ${list}.`,
  addedNewPlaylist: (title, list) => `Creé la lista ${list} y añadí ${title}.`,
  ignored: 'Vale, no volveré a poner esta canción.',
  ShuffleOn: 'Modo aleatorio activado.',
  ShuffleOff: 'Modo aleatorio desactivado.',
  LoopOn: 'Repetición activada.',
  LoopOff: 'Repetición desactivada.',
  help: (inv) =>
    `Puedes decir: pide a ${inv} que ponga música de un artista, el álbum que quieras, una canción, un género o tu lista favorita. ` +
    'También: qué suena, siguiente, anterior, aleatorio, o continúa donde lo dejé. ¿Qué te pongo?',
  fallback: 'No sé hacer eso todavía. Prueba con: pon música de, seguido del artista.',
  noPublicUrl: 'Falta configurar la dirección pública del servidor en la consola web.',
  internalError: 'Algo falló en el servidor de música. Revisa los mensajes en la consola web.',
};

export function t(key: string, ...args: string[]): string {
  const v = es[key];
  if (typeof v === 'function') return v(...args);
  return v ?? key;
}
