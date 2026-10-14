/*
 * Fraudible Cast receiver.
 * The phone sends book details, the cover and read-along text over the custom namespace (the TV never
 * talks to the homelab server for these, because an HTTPS page cannot fetch plain-HTTP LAN data).
 * Audio itself is played by the Cast framework from the stream URL the phone loads.
 */
const NS = 'urn:x-cast:dev.marcelhuber.fraudible';
const $ = (id) => document.getElementById(id);

const state = {
  book: null,          // {title, author, narrator, duration, chapters:[{title,start,end}], tracks:[{path,start}], tint:[a,b]}
  cover: null,         // data URL
  sentences: [],       // [{text, start, heading}]
  mode: 'now',         // 'now' | 'read'
  playing: false,
  rate: 1,
  posFromPhone: null,  // {t, at} fallback when the media element can't be mapped
  chunks: {},
  readInfo: null,      // {status: 'sending'|'none'|'error', message, sentences}
  readProgress: null,  // {got, n} while read-along chunks arrive
};

// ---- formatting -------------------------------------------------------------------------------
const hm = (s) => {
  s = Math.max(0, Math.round(s / 60));
  const h = Math.floor(s / 60), m = s % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
};
const clock = (s) => {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(sec).padStart(2, '0')}`;
};

// ---- position ---------------------------------------------------------------------------------
let player = null;
const media = $('media');

function trackOffset() {
  if (!state.book || !player) return null;
  const info = player.getMediaInformation && player.getMediaInformation();
  const url = (info && (info.contentUrl || info.contentId)) || media.currentSrc || '';
  const path = url.split('?')[0].replace(/^https?:\/\/[^/]+/, '');
  const t = state.book.tracks.find((tr) => tr.path === path);
  return t ? t.start : null;
}

function position() {
  const off = trackOffset();
  if (off !== null && !isNaN(media.currentTime)) return off + media.currentTime;
  if (state.book && state.book.fallback && !isNaN(media.currentTime)) return media.currentTime;
  if (state.posFromPhone) {
    const p = state.posFromPhone;
    return p.t + (state.playing ? ((Date.now() - p.at) / 1000) * state.rate : 0);
  }
  return 0;
}

// ---- text that scrolls when it does not fit ------------------------------------------------------
function setText(id, text) {
  const box = $(id), span = box.querySelector('span') || box;
  if (span.textContent === text) return;
  span.textContent = text;
  fit(box);
}
function fit(box) {
  if (!box.classList.contains('mq')) return;
  const span = box.querySelector('span');
  box.classList.remove('scroll');
  const over = span.scrollWidth - box.clientWidth;
  if (over > 4) {
    box.style.setProperty('--mq-shift', `${-(over + 48)}px`);
    box.style.setProperty('--mq-dur', `${Math.max(6, (over + 48) / 45)}s`);
    box.classList.add('scroll');
  }
}
function refit() { document.querySelectorAll('.mq').forEach(fit); }

// ---- rendering --------------------------------------------------------------------------------
function show(id) {
  for (const s of document.querySelectorAll('.screen')) s.classList.toggle('visible', s.id === id);
}

function applyBook() {
  const b = state.book;
  if (!b) return;
  const root = document.documentElement.style;
  if (b.tint) { root.setProperty('--tint', b.tint[0]); root.setProperty('--tint2', b.tint[1] || b.tint[0]); }
  setText('title', b.title || '');
  setText('byline', [b.author && `by ${b.author}`, b.narrator && `narrated by ${b.narrator}`].filter(Boolean).join('  ·  '));
  setText('read-title', b.title || '');
}

function applyCover() {
  if (!state.cover) return;
  $('cover').src = state.cover;
  $('read-cover').src = state.cover;
  $('backdrop-art').style.backgroundImage = `url("${state.cover}")`;
}

let lastSentence = -1;
let shown = 'idle';
function sentenceIndexAt(t) {
  const s = state.sentences;
  let lo = 0, hi = s.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (s[mid].start !== null && s[mid].start <= t) { ans = mid; lo = mid + 1; }
    else if (s[mid].start === null) { lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

function renderRead(t) {
  const idx = sentenceIndexAt(t);
  if (idx === lastSentence) return;
  lastSentence = idx;
  const box = $('read-text');
  box.dataset.status = '';
  if (idx < 0) { fillRead([{ text: '…', cls: 'line current' }]); return; }
  const lines = [];
  for (let i = Math.max(0, idx - 4); i <= Math.min(state.sentences.length - 1, idx + 5); i++) {
    const s = state.sentences[i];
    lines.push({ text: s.text, cls: 'line' + (i < idx ? ' past' : i > idx ? ' next' : ' current') + (s.heading ? ' heading' : '') });
  }
  fillRead(lines);
}

/** Puts [lines] into the read-along box and moves them so the current one sits in the middle of the screen. */
function fillRead(lines) {
  const box = $('read-text');
  const track = document.createElement('div');
  track.className = 'track';
  let cur = null;
  for (const l of lines) {
    const el = document.createElement('div');
    el.className = l.cls;
    el.textContent = l.text;
    track.appendChild(el);
    if (l.cls.includes('current')) cur = el;
  }
  box.replaceChildren(track);
  if (!cur) return;
  const h = box.clientHeight;
  // Centre the current sentence; one too tall for that starts near the top so its end stays on screen.
  let y = h / 2 - (cur.offsetTop + cur.offsetHeight / 2);
  if (cur.offsetHeight > h * 0.8) y = h * 0.08 - cur.offsetTop;
  track.style.transform = `translateY(${Math.round(y)}px)`;
}

function readStatusText() {
  const i = state.readInfo, p = state.readProgress;
  if (i && i.status === 'none') return 'This book has no read-along text yet.';
  if (i && i.status === 'error') return `Read-along failed: ${i.message || 'unknown error'}`;
  if (p) return `Loading the text… ${Math.round((p.got / p.n) * 100)}%`;
  if (i && i.status === 'sending') return 'Loading the text…';
  return 'Waiting for the text from your phone…';
}
function renderReadStatus() {
  lastSentence = -2;
  const text = readStatusText();
  const box = $('read-text');
  if (box.dataset.status === text) return;
  box.dataset.status = text;
  fillRead([{ text, cls: 'line status current' }]);
}

function tick() {
  const b = state.book;
  if (!b) { document.body.classList.add('idle'); if (shown !== 'idle') { shown = 'idle'; show('idle'); } return; }
  const t = position();
  document.body.classList.toggle('paused', !state.playing);
  $('state-text').textContent = state.playing ? 'Now playing' : 'Paused';
  $('read-state').textContent = state.playing ? '' : 'Paused';

  const ch = b.chapters || [];
  let ci = ch.findIndex((c) => t >= c.start && t < c.end);
  if (ci < 0) ci = ch.length ? ch.length - 1 : -1;
  const c = ci >= 0 ? ch[ci] : { title: '', start: 0, end: b.duration };
  const cLen = Math.max(1, c.end - c.start), cPos = Math.min(cLen, Math.max(0, t - c.start));
  $('chapter-label').textContent = ch.length > 1 ? `Chapter ${ci + 1} of ${ch.length}` : 'Progress';
  setText('chapter-title', c.title || b.title || '');
  $('chapter-fill').style.width = `${(cPos / cLen) * 100}%`;
  $('ch-elapsed').textContent = clock(cPos);
  $('ch-left').textContent = `-${clock(cLen - cPos)}`;
  const frac = b.duration ? Math.min(1, t / b.duration) : 0;
  $('book-fill').style.width = `${frac * 100}%`;
  $('read-fill').style.width = `${frac * 100}%`;
  $('book-line').style.visibility = b.duration ? 'visible' : 'hidden';
  $('book-left').textContent = `${hm(b.duration - t)} left  ·  ${Math.round(frac * 100)}% of the book`;
  $('speed').textContent = state.rate !== 1 ? `${state.rate.toFixed(2).replace(/0$/, '')}×` : '';
  setText('read-chapter', ch.length > 1 ? `Chapter ${ci + 1} of ${ch.length}  ·  ${c.title}` : '');

  const reading = state.mode === 'read';
  document.body.classList.toggle('reading', reading);
  document.body.classList.remove('idle');
  const screen = reading ? 'read' : 'now';
  if (shown !== screen) { shown = screen; show(screen); requestAnimationFrame(refit); }
  if (reading && state.sentences.length) renderRead(t);
  else if (reading) renderReadStatus();
}

// ---- messages from the phone ------------------------------------------------------------------
function onMessage(msg) {
  switch (msg.type) {
    case 'readinfo':
      state.readInfo = msg;
      break;
    case 'book':
      state.book = msg.book; state.sentences = []; state.readInfo = null; state.readProgress = null; lastSentence = -1;
      applyBook();
      break;
    case 'mode':
      state.mode = msg.readAlong ? 'read' : 'now'; lastSentence = -1;
      break;
    case 'pos':
      state.posFromPhone = { t: msg.t, at: Date.now() };
      if (typeof msg.playing === 'boolean') state.playing = msg.playing;
      if (msg.rate) state.rate = msg.rate;
      break;
    case 'chunk': {
      const key = `${msg.kind}:${msg.id}`;
      const c = (state.chunks[key] = state.chunks[key] || { parts: [], got: 0 });
      if (c.parts[msg.i] === undefined) { c.parts[msg.i] = msg.data; c.got++; }
      if (msg.kind === 'read') state.readProgress = { got: c.got, n: msg.n };
      if (c.got === msg.n) {
        const all = c.parts.join('');
        delete state.chunks[key];
        if (msg.kind === 'cover') { state.cover = all; applyCover(); }
        if (msg.kind === 'read') {
          try {
            state.sentences = JSON.parse(all).map((s) => ({ text: s[0], start: s[1], heading: !!s[2] }));
            state.readProgress = null;
          } catch (e) {
            state.readInfo = { status: 'error', message: `Could not read the text (${e.message})` };
          }
          lastSentence = -1;
        }
      }
      break;
    }
  }
  tick();
}

// ---- Cast framework ---------------------------------------------------------------------------
function startCast() {
  const context = cast.framework.CastReceiverContext.getInstance();
  player = context.getPlayerManager();
  player.setMediaElement(media);
  const E = cast.framework.events.EventType;
  const sync = () => {
    const ps = player.getPlayerState();
    state.playing = ps === cast.framework.messages.PlayerState.PLAYING || ps === cast.framework.messages.PlayerState.BUFFERING;
    state.rate = player.getPlaybackRate ? player.getPlaybackRate() || 1 : 1;
    tick();
  };
  [E.PLAYING, E.PAUSE, E.PLAYER_LOAD_COMPLETE, E.RATE_CHANGE, E.ENDED, E.MEDIA_STATUS].forEach((e) => player.addEventListener(e, sync));
  context.addCustomMessageListener(NS, (event) => onMessage(event.data));
  // Ask the phone for the book whenever a sender connects, and keep asking while we have none.
  const hello = (senderId) => { try { context.sendCustomMessage(NS, senderId, { type: 'hello' }); } catch (e) { /* not ready yet */ } };
  context.addEventListener(cast.framework.system.EventType.SENDER_CONNECTED, (e) => hello(e.senderId));
  setInterval(() => { if (!state.book && context.getSenders().length) hello(undefined); }, 4000);
  // Until the phone's details arrive, show what the stream itself says.
  player.addEventListener(E.PLAYER_LOAD_COMPLETE, () => {
    if (state.book) return;
    const info = player.getMediaInformation();
    const md = (info && info.metadata) || {};
    state.book = { title: md.title || md.albumName || 'Audiobook', author: md.artist || md.albumArtist || '', duration: (info && info.duration) || media.duration || 0, chapters: [], tracks: [], fallback: true };
    applyBook();
  });
  const options = new cast.framework.CastReceiverOptions();
  options.customNamespaces = { [NS]: cast.framework.system.MessageType.JSON };
  options.disableIdleTimeout = false;
  options.maxInactivity = 3600;
  context.start(options);
}

// ---- local demo (?demo=1) for designing without a TV -------------------------------------------
function startDemo() {
  const start = Date.now() - 754_000;
  state.playing = true; state.rate = 1.25;
  state.posFromPhone = { t: 754, at: Date.now() };
  const words = 'The cat could jump into my arms. It was something I had trained her to do. I could shake a bag of cat treats, and she would jump right up there. I cursed myself for not bringing cat treats out with me. The window on the first-floor apartment slid open. "What in god\'s name is going on out here?" Mrs. Parsons called, sticking her head out the window.'.split(/(?<=[.!?"])\s+/);
  onMessage({ type: 'book', book: {
    title: new URLSearchParams(location.search).get('title') || 'Dungeon Crawler Carl', author: 'Matt Dinniman', narrator: 'Jeff Hays', duration: 48660,
    chapters: [{ title: 'Opening Credits', start: 0, end: 60 }, { title: new URLSearchParams(location.search).get('chapter') || 'Chapter 1', start: 60, end: 1400 }, { title: 'Chapter 2', start: 1400, end: 2600 }],
    tracks: [], tint: ['#6b5a12', '#2a1f08'],
  } });
  const sentences = words.map((w, i) => [w, 700 + i * 9, 0]);
  onMessage({ type: 'chunk', kind: 'read', id: 1, i: 0, n: 1, data: JSON.stringify(sentences) });
  if (location.search.includes('read')) onMessage({ type: 'mode', readAlong: true });
  const cover = new URLSearchParams(location.search).get('cover');
  if (cover) { state.cover = cover; applyCover(); }
  setInterval(() => { state.posFromPhone = { t: (Date.now() - start) / 1000, at: Date.now() }; tick(); }, 250);
}

window.addEventListener('resize', refit);
if (document.fonts) document.fonts.ready.then(refit);
if (location.search.includes('demo')) startDemo();
else if (window.cast && cast.framework) startCast();
setInterval(tick, 250);
