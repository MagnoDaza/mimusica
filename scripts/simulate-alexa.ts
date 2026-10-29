// Drives the skill endpoint like an Echo would. Needs the server running with ALEXA_SKIP_VERIFY=1.
// Usage: node scripts/simulate-alexa.ts http://localhost:8080
const base = process.argv[2] ?? 'http://localhost:8080';
const deviceId = 'amzn1.ask.device.SIMULATED';
let token: string | undefined;
let offset = 0;
let activity = 'IDLE';

async function send(request: Record<string, unknown>) {
  const body = {
    version: '1.0',
    context: {
      System: { device: { deviceId }, application: { applicationId: 'amzn1.ask.skill.test' } },
      AudioPlayer: { token, offsetInMilliseconds: offset, playerActivity: activity },
    },
    request: { requestId: crypto.randomUUID(), timestamp: new Date().toISOString(), locale: 'es-ES', ...request },
  };
  const res = await fetch(`${base}/alexa`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = (await res.json()) as any;
  const r = json.response ?? {};
  const label = request.type === 'IntentRequest' ? `${(request.intent as any).name} ${JSON.stringify(Object.fromEntries(Object.entries((request.intent as any).slots ?? {}).map(([k, v]: any) => [k, v.value])))}` : String(request.type);
  const parts = [r.outputSpeech?.text && `🗣 "${r.outputSpeech.text}"`];
  for (const d of r.directives ?? []) {
    if (d.type === 'AudioPlayer.Play') {
      const s = d.audioItem.stream;
      parts.push(`▶ ${d.playBehavior} "${d.audioItem.metadata?.title}" token=${s.token.split('~')[1]} offset=${s.offsetInMilliseconds}${s.expectedPreviousToken ? ' prev=' + s.expectedPreviousToken.split('~')[1] : ''}`);
      if (d.playBehavior !== 'ENQUEUE') token = s.token;
    } else parts.push(`⏹ ${d.type}${d.clearBehavior ? ' ' + d.clearBehavior : ''}`);
  }
  console.log(`${label.padEnd(58)} ${parts.filter(Boolean).join('  ') || '(vacío)'}`);
  return json;
}

const intent = (name: string, slots: Record<string, string> = {}) =>
  send({ type: 'IntentRequest', intent: { name, slots: Object.fromEntries(Object.entries(slots).map(([k, v]) => [k, { name: k, value: v }])) } });
const audio = (type: string, extra: Record<string, unknown> = {}) => send({ type: `AudioPlayer.${type}`, token, offsetInMilliseconds: offset, ...extra });

await send({ type: 'LaunchRequest' });
await intent('PlayAlbumIntent', { album: 'a night at the opera' });
activity = 'PLAYING';
await audio('PlaybackStarted');
await audio('PlaybackNearlyFinished');
await intent('WhatsPlayingIntent');
await intent('AMAZON.NextIntent');
await audio('PlaybackStarted');
offset = 4200;
await intent('AMAZON.PauseIntent');
activity = 'STOPPED';
await audio('PlaybackStopped');
await intent('AMAZON.ResumeIntent');
activity = 'PLAYING';
await audio('PlaybackStarted');
offset = 0;
await intent('AMAZON.ShuffleOnIntent');
await intent('AddToPlaylistIntent', { playlist: 'para correr' });
await intent('IgnoreTrackIntent');
await send({ type: 'PlaybackController.NextCommandIssued' });
await intent('PlayIntent', { query: 'metallica' });
console.log('--- audiolibro: escuchar, pausar, retomar 10 s antes');
await intent('ReadBookIntent', { book: 'el principito' });
await intent('AMAZON.NextIntent');
await audio('PlaybackStarted');
offset = 65_000;
await audio('PlaybackStopped');
await intent('PlayArtistIntent', { artist: 'shakira' });
await audio('PlaybackStarted');
await intent('ReadBookIntent', { book: 'principito' });
console.log('--- continuar lo último');
await intent('ResumeLastIntent');
await intent('PlayPlaylistIntent', { playlist: 'favoritas' });
await intent('PlayEverythingIntent');
await intent('AMAZON.HelpIntent');
