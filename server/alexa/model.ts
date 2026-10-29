/**
 * Builds the interaction model JSON to paste in the Alexa developer console (JSON Editor).
 * Slot catalogues are filled from the library so Alexa recognises your artist/album names.
 */
import { all } from '../db.ts';
import { settings } from '../settings.ts';

const LIMITS = { query: 6000, artist: 3000, album: 3000, song: 4000, genre: 300, playlist: 300, book: 500 };

function clean(v: string) {
  return v
    .replace(/[{}\[\]<>"]/g, ' ')
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

const verbs = ['pon', 'ponme', 'reproduce', 'toca', 'quiero escuchar', 'quiero oír', 'escuchar', 'play'];
const expand = (templates: string[]) => [...new Set(templates.flatMap((t) => (t.includes('VERB') ? verbs.map((v) => t.replace('VERB', v)) : [t])))];

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
      samples: expand(['VERB el álbum {album}', 'VERB el disco {album}', 'VERB el álbum {album} de {artist}', 'VERB el disco {album} de {artist}', 'que ponga el álbum {album}', 'que ponga el disco {album}']) },
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
