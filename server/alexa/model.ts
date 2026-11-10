/**
 * Builds the interaction model JSON to paste in the Alexa developer console (JSON Editor).
 * Slot catalogues are filled from the library so Alexa recognises your artist/album names.
 */
import { all } from '../db.ts';
import { settings } from '../settings.ts';

// shortcut: sizes verified to build on Amazon (2026-11); raise only after a successful test build.
const LIMITS = { query: 3000, artist: 2000, album: 2000, song: 3000, genre: 300, playlist: 300, book: 500 };

function clean(v: string) {
  // Amazon's build fails silently (validation OK, build FAILURE) on symbols and control chars in slot values.
  return v
    .replace(/[^\p{L}\p{M}\p{N} '.\-&]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
}

function values(rows: { v: string }[], limit: number) {
  const seen = new Set<string>();
  const out: { name: { value: string } }[] = [];
  for (const r of rows) {
    const v = clean(r.v ?? '');
    const k = v.toLowerCase();
    if (!v || seen.has(k)) continue;
    seen.add(k);
    out.push({ name: { value: v } });
    if (out.length >= limit) break;
  }
  // A custom slot type needs at least one value.
  return out.length ? out : [{ name: { value: 'ejemplo' } }];
}

function invocation(name: string) {
  const n = name
    .toLowerCase()
    .normalize('NFC')
    .replace(/[^a-záéíóúüñ ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return n.split(' ').length >= 2 ? n : 'mi biblioteca';
}

const verbs = ['pon', 'ponme', 'reproduce', 'reprodúceme', 'toca', 'tócame', 'quiero escuchar', 'quiero oír', 'escuchar',
  'me apetece escuchar', 'déjame escuchar', 'play'];
// Ways of saying "add to the queue" / "play after this one".
const adds = ['añade', 'agrega', 'mete', 'suma', 'pon'];
const queues = ['a la cola', 'a la cola de reproducción', 'al final de la cola', 'a la lista de reproducción', 'al final'];
const nexts = ['a continuación', 'después de esta', 'justo después', 'la siguiente', 'después', 'luego'];
const expandWith = (templates: string[], vars: Record<string, string[]>) => [...new Set(templates.flatMap((t) => {
  let out = [t];
  for (const [k, vs] of Object.entries(vars)) out = out.flatMap((x) => (x.includes(k) ? vs.map((v) => x.replaceAll(k, v)) : [x]));
  return out;
}))];
const expand = (templates: string[]) => expandWith(templates, { VERB: verbs });
// The same "what" in every form the search understands.
const whats = ['{query}', 'la canción {song}', 'el tema {song}', '{song} de {artist}', 'la canción {song} de {artist}',
  'el álbum {album}', 'el disco {album}', 'el álbum {album} de {artist}', 'música de {artist}', 'canciones de {artist}'];
const queueSlots = [{ name: 'query', type: 'MUSIC_QUERY' }, { name: 'song', type: 'MUSIC_SONG' }, { name: 'album', type: 'MUSIC_ALBUM' }, { name: 'artist', type: 'MUSIC_ARTIST' }];

export function buildInteractionModel() {
  // Most played first so catalogue limits keep what you actually listen to.
  const artists = all<{ v: string }>(`SELECT v FROM (
      SELECT artist AS v, SUM(play_count) AS p, COUNT(*) AS n FROM tracks WHERE hidden = 0 AND artist != '' GROUP BY artist_n
      UNION ALL
      SELECT album_artist AS v, SUM(play_count) AS p, COUNT(*) AS n FROM tracks WHERE hidden = 0 AND album_artist != '' GROUP BY album_artist_n
    ) ORDER BY p DESC, n DESC`);
  const albums = all<{ v: string }>(`SELECT album AS v FROM tracks WHERE hidden = 0 AND audiobook = 0 AND album != ''
      GROUP BY album_n ORDER BY SUM(play_count) DESC, COUNT(*) DESC`);
  const songs = all<{ v: string }>(`SELECT title AS v FROM tracks WHERE hidden = 0 AND audiobook = 0
      GROUP BY title_n ORDER BY SUM(play_count) DESC, MAX(last_played) DESC`);
  const genres = all<{ v: string }>('SELECT genre AS v FROM track_genres GROUP BY genre_n ORDER BY COUNT(*) DESC');
  const books = all<{ v: string }>("SELECT album AS v FROM tracks WHERE audiobook = 1 AND album != '' GROUP BY album_n");
  const playlists = all<{ v: string }>(`SELECT name AS v FROM playlists UNION SELECT label AS v FROM folders WHERE label != ''`);
  const query = [...artists.slice(0, 2500), ...albums.slice(0, 1500), ...songs.slice(0, 2000)];

  const types = [
    { name: 'MUSIC_QUERY', values: values(query, LIMITS.query) },
    { name: 'MUSIC_ARTIST', values: values(artists, LIMITS.artist) },
    { name: 'MUSIC_ALBUM', values: values(albums, LIMITS.album) },
    { name: 'MUSIC_SONG', values: values(songs, LIMITS.song) },
    { name: 'MUSIC_GENRE', values: values(genres, LIMITS.genre) },
    { name: 'MUSIC_PLAYLIST', values: values(playlists, LIMITS.playlist) },
    { name: 'MUSIC_BOOK', values: values(books, LIMITS.book) },
  ];

  const intents = [
    { name: 'PlayIntent', slots: [{ name: 'query', type: 'MUSIC_QUERY' }],
      samples: expand(['VERB {query}', 'VERB algo de {query}', 'que ponga {query}', 'que toque {query}']) },
    { name: 'PlayArtistIntent', slots: [{ name: 'artist', type: 'MUSIC_ARTIST' }],
      samples: expand(['VERB música de {artist}', 'VERB canciones de {artist}', 'VERB a {artist}', 'que ponga música de {artist}', 'que ponga canciones de {artist}']) },
    { name: 'PlayAlbumIntent', slots: [{ name: 'album', type: 'MUSIC_ALBUM' }, { name: 'artist', type: 'MUSIC_ARTIST' }],
      samples: [...expand(['VERB el álbum {album}', 'VERB el disco {album}', 'VERB el álbum {album} de {artist}', 'VERB el disco {album} de {artist}', 'que ponga el álbum {album}', 'que ponga el disco {album}']),
        'el álbum {album}', 'el disco {album}'] },
    { name: 'ListAlbumsIntent', slots: [{ name: 'artist', type: 'MUSIC_ARTIST' }],
      samples: ['qué álbumes tiene de {artist}', 'qué álbumes tienes de {artist}', 'qué álbumes hay de {artist}', 'qué discos tiene de {artist}',
        'qué discos tienes de {artist}', 'qué discos hay de {artist}', 'dime los álbumes de {artist}', 'dime los discos de {artist}',
        'cuáles álbumes tienes de {artist}', 'qué álbumes de {artist} tienes'] },
    { name: 'PlaySongIntent', slots: [{ name: 'song', type: 'MUSIC_SONG' }, { name: 'artist', type: 'MUSIC_ARTIST' }],
      samples: expand(['VERB la canción {song}', 'VERB el tema {song}', 'VERB la canción {song} de {artist}', 'VERB {song} de {artist}', 'que ponga la canción {song}']) },
    { name: 'PlayGenreIntent', slots: [{ name: 'genre', type: 'MUSIC_GENRE' }],
      samples: expand(['VERB música {genre}', 'VERB algo de música {genre}', 'VERB el género {genre}', 'que ponga música {genre}']) },
    { name: 'PlayPlaylistIntent', slots: [{ name: 'playlist', type: 'MUSIC_PLAYLIST' }],
      samples: expand(['VERB mi lista {playlist}', 'VERB la lista {playlist}', 'VERB la playlist {playlist}', 'VERB mi playlist {playlist}', 'que ponga mi lista {playlist}']) },
    { name: 'ShufflePlaylistIntent', slots: [{ name: 'playlist', type: 'MUSIC_PLAYLIST' }],
      samples: expand(['VERB mi lista {playlist} en aleatorio', 'VERB la lista {playlist} en modo aleatorio', 'mezcla mi lista {playlist}']) },
    { name: 'ReadBookIntent', slots: [{ name: 'book', type: 'MUSIC_BOOK' }, { name: 'chapter', type: 'AMAZON.NUMBER' }],
      samples: ['lee el libro {book}', 'lee {book}', 'pon el audiolibro {book}', 'pon el libro {book}', 'continúa el libro {book}',
        'lee el capítulo {chapter} de {book}', 'pon el capítulo {chapter} de {book}', 'que lea {book}'] },
    { name: 'PlayEverythingIntent', slots: [],
      samples: expand(['VERB música', 'VERB mi música', 'VERB todo', 'VERB cualquier cosa', 'VERB lo que sea', 'que ponga música']) },
    { name: 'EnqueueIntent', slots: queueSlots,
      samples: expandWith(['ADD WHAT QUEUE', 'que ADD WHAT QUEUE', 'ADD a la cola WHAT', 'encola WHAT', 'que encole WHAT'],
        { ADD: adds.filter((a) => a !== 'pon'), QUEUE: queues, WHAT: whats })
        .concat(expandWith(['pon WHAT QUEUE'], { QUEUE: queues.filter((q) => q !== 'al final'), WHAT: whats })) },
    { name: 'PlayNextIntent', slots: queueSlots,
      samples: expandWith(['pon WHAT NEXT', 'ponme WHAT NEXT', 'ADD WHAT NEXT', 'que suene WHAT NEXT', 'quiero escuchar WHAT NEXT', 'NEXT pon WHAT'],
        { ADD: adds.filter((a) => a !== 'pon'), NEXT: nexts, WHAT: whats }) },
    { name: 'UpNextIntent', slots: [],
      samples: ['qué viene después', 'qué suena después', 'qué canción viene después', 'cuál es la siguiente canción', 'qué es lo siguiente',
        'qué sigue', 'qué toca después', 'qué hay en la cola', 'qué hay después'] },
    { name: 'RandomAlbumIntent', slots: [{ name: 'artist', type: 'MUSIC_ARTIST' }],
      samples: [...expandWith(['VERB ALBUM', 'VERB ALBUM de {artist}'], {
        VERB: [...verbs, 'que ponga', 'que me ponga', 'que toque'],
        ALBUM: ['un álbum aleatorio', 'un álbum al azar', 'un álbum cualquiera', 'cualquier álbum', 'otro álbum',
          'un disco aleatorio', 'un disco al azar', 'un disco cualquiera', 'cualquier disco', 'otro disco'],
      }), 'sorpréndeme con un álbum', 'sorpréndeme con un disco', 'elige un álbum', 'elige un disco', 'elige tú un álbum',
      'sorpréndeme con un álbum de {artist}', 'elige un álbum de {artist}', 'elige un disco de {artist}'] },
    { name: 'RandomSongIntent', slots: [],
      samples: [...expandWith(['VERB SONG'], {
        VERB: [...verbs, 'que ponga', 'que me ponga', 'que toque'],
        SONG: ['una canción aleatoria', 'una canción al azar', 'una canción cualquiera', 'cualquier canción', 'otra canción',
          'canciones al azar', 'canciones aleatorias', 'música aleatoria', 'música al azar', 'algo al azar', 'algo aleatorio',
          'algo diferente', 'algo distinto', 'otra cosa'],
      }), 'sorpréndeme', 'sorpréndeme con algo', 'sorpréndeme con una canción', 'elige tú', 'elige una canción', 'lo que tú quieras'] },
    { name: 'PlaySelectionIntent', slots: [], samples: ['pon la selección', 'pon mi selección', 'reproduce la selección actual'] },
    { name: 'ResumeLastIntent', slots: [],
      samples: ['continúa donde lo dejé', 'sigue donde lo dejé', 'sigue con lo último', 'pon lo último', 'continúa lo último', 'retoma la música'] },
    { name: 'WhatsPlayingIntent', slots: [],
      samples: ['qué suena', 'qué está sonando', 'qué canción es esta', 'qué canción es', 'quién canta esto', 'qué es esto', 'cómo se llama esta canción'] },
    { name: 'AddToPlaylistIntent', slots: [{ name: 'playlist', type: 'MUSIC_PLAYLIST' }],
      samples: ['añade esta canción a {playlist}', 'añade esta canción a mi lista {playlist}', 'agrega esta canción a {playlist}',
        'agrega esta canción a mi lista {playlist}', 'guarda esta canción en {playlist}', 'añádela a {playlist}', 'agrégala a {playlist}'] },
    { name: 'IgnoreTrackIntent', slots: [],
      samples: ['no vuelvas a poner esta canción', 'no me pongas más esta canción', 'quita esta canción', 'no me gusta esta canción', 'oculta esta canción'] },
    ...['CancelIntent', 'HelpIntent', 'StopIntent', 'PauseIntent', 'ResumeIntent', 'NextIntent', 'PreviousIntent', 'StartOverIntent',
      'RepeatIntent', 'ShuffleOnIntent', 'ShuffleOffIntent', 'LoopOnIntent', 'LoopOffIntent', 'NavigateHomeIntent', 'FallbackIntent']
      .map((n) => ({ name: `AMAZON.${n}`, samples: [] as string[] })),
  ];

  return {
    interactionModel: {
      languageModel: {
        invocationName: invocation(settings().invocationName),
        intents,
        types,
      },
    },
  };
}
