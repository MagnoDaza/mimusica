// Spoken responses (Spanish; the same strings serve es-ES, es-MX and es-US).

const pick = (list: string[]) => list[Math.floor(Math.random() * list.length)];
// Examples only ~30 % of the time; otherwise a short, varied greeting.
const welcomeShort = ['¿Qué te pongo?', '¿Qué quieres escuchar?', 'Hola. ¿Qué te apetece escuchar?', 'Dime qué pongo.',
  '¿Qué música te pongo hoy?', 'Te escucho. ¿Qué suena?', '¿Qué te apetece?'];
const welcomeTips = [
  '¿Qué quieres escuchar? Por ejemplo: pon música de Queen, o pon el álbum Thriller.',
  '¿Qué te pongo? Puedes pedirme un artista, un álbum, una canción o una de tus listas.',
  '¿Qué quieres escuchar? Si ya suena algo, también puedes decir: añade una canción a la cola.',
  '¿Qué te pongo? Prueba con: continúa donde lo dejé.',
];

const es: Record<string, string | ((...a: string[]) => string)> = {
  welcome: () => (Math.random() < 0.3 ? pick(welcomeTips) : pick(welcomeShort)),
  reprompt: '¿Qué te pongo?',
  playing: (name) => `Poniendo ${name}.`,
  resuming: (name) => `Continuando ${name}.`,
  startsWith: (title) => `Empieza con ${title}.`,
  albumsOf: (count, artist, list, example) =>
    `Tienes ${count === '1' ? 'un álbum' : `${count} álbumes`} de ${artist}: ${list}. ¿Cuál te pongo? Di, por ejemplo: el álbum ${example}.`,
  whichAlbum: '¿Qué álbum te pongo?',
  whichArtist: 'Vale, busquemos. ¿De qué artista?',
  whichSong: (artist) => `¿Qué canción de ${artist}?`,
  noAlbums: (artist) => `No tengo álbumes de ${artist} en tu biblioteca.`,
  notFound: (what) => `No encontré ${what} en tu biblioteca.`,
  didntCatch: 'No te entendí bien. ¿Qué quieres escuchar?',
  nothingPlayable: 'No hay pistas que se puedan reproducir.',
  nothingToNavigate: 'No hay nada sonando ahora.',
  nothingPlaying: 'Ahora no está sonando nada de tu biblioteca.',
  atEnd: 'Es la última pista de la lista.',
  atStart: 'Es la primera pista de la lista.',
  noSimilar: (title) => `No encontré nada parecido a ${title}.`,
  noPlays: 'Todavía no has escuchado nada desde Mi Música. Pide algo y lo iré aprendiendo.',
  noPlaysOf: (artist) => `Todavía no has escuchado nada de ${artist} desde Mi Música.`,
  emptyLibrary: 'Tu biblioteca está vacía. Añade una carpeta desde la consola web.',
  noSelection: 'No hay ninguna selección. Créala desde la consola web.',
  nowPlaying: (title, artist, album) =>
    `Suena ${title}${artist ? `, de ${artist}` : ''}${album ? `, del álbum ${album}` : ''}.`,
  addedToPlaylist: (title, list) => `Añadí ${title} a tu lista ${list}.`,
  addedNewPlaylist: (title, list) => `Creé la lista ${list} y añadí ${title}.`,
  whatToQueue: '¿Qué canción añado a la cola?',
  queuedEnd: (what, n) => (n === '1' ? `Añadí ${what} al final de la cola.` : `Añadí ${n} canciones de ${what} al final de la cola.`),
  queuedNext: (what, n) => (n === '1' ? `Vale, después de esta suena ${what}.` : `Vale, después de esta suenan ${n} canciones de ${what}.`),
  upNext: (title, artist) => `Después suena ${title}${artist ? `, de ${artist}` : ''}.`,
  ignored: 'Vale, no volveré a poner esta canción.',
  ShuffleOn: 'Modo aleatorio activado.',
  ShuffleOff: 'Modo aleatorio desactivado.',
  LoopOn: 'Repetición activada.',
  LoopOff: 'Repetición desactivada.',
  help: (inv) =>
    `Puedes decir: pide a ${inv} que ponga música de un artista, el álbum que quieras, una canción, un género o tu lista favorita. ` +
    'También: busca una canción, añade una canción a la cola, pon una canción a continuación, qué suena, qué viene después, un disco al azar, algo parecido a esto, lo más escuchado, siguiente, anterior, aleatorio, o continúa donde lo dejé. ¿Qué te pongo?',
  fallback: 'No sé hacer eso todavía. Prueba con: pon música de, seguido del artista.',
  noPublicUrl: 'Falta configurar la dirección pública del servidor en la consola web.',
  internalError: 'Algo falló en el servidor de música. Revisa los mensajes en la consola web.',
};

export function t(key: string, ...args: string[]): string {
  const v = es[key];
  if (typeof v === 'function') return v(...args);
  return v ?? key;
}
