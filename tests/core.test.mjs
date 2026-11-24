// Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../core.js';
import { GitHubStore, SyncError, syncOnce } from '../sync.js';

const T0 = Date.UTC(2026, 10, 24, 17, 0, 0);
const H = 3600e3;
const ev = (id, k, t, u = t, extra = {}) => ({ id, k, t, u, ...extra });

test('newId: bucket is the UTC creation day and ids do not collide', () => {
  const id = C.newId(T0);
  assert.equal(C.bucketOf(id), '2026-11-24');
  assert.ok(C.clean(ev(id, 'pee', T0)), 'a fresh id passes clean()');
  const ids = new Set(Array.from({ length: 500 }, () => C.newId(T0)));
  assert.equal(ids.size, 500);
});

test('mergeEvents: newer copy wins, delete wins a tie, unknown ids are kept', () => {
  const a = [ev('2026-11-24-a', 'pee', T0, 10), ev('2026-11-24-b', 'feed', T0, 10)];
  const b = [ev('2026-11-24-a', 'poop', T0, 20), ev('2026-11-24-c', 'pee', T0, 5)];
  const m = C.mergeEvents(a, b);
  assert.deepEqual(m.map((e) => e.id), ['2026-11-24-a', '2026-11-24-b', '2026-11-24-c']);
  assert.equal(m[0].k, 'poop');
  const tie = C.mergeEvents([ev('2026-11-24-a', 'pee', T0, 10)], [ev('2026-11-24-a', 'pee', T0, 10, { x: true })]);
  assert.equal(tie[0].x, true);
  // order of arguments must not change the result
  assert.deepEqual(C.mergeEvents(b, a), m);
});

test('summarize: last of each kind, 24h counts, deleted and future entries ignored', () => {
  const list = [
    ev('2026-11-24-a', 'feed', T0 - 1 * H),
    ev('2026-11-24-b', 'feed', T0 - 3 * H),
    ev('2026-11-23-c', 'feed', T0 - 30 * H),
    ev('2026-11-24-d', 'pee', T0 - 2 * H),
    ev('2026-11-24-e', 'pee', T0 - 0.5 * H, T0, { x: true }),
    ev('2026-11-24-f', 'poop', T0 + 5 * H),
  ];
  const s = C.summarize(list, T0);
  assert.equal(s.last.feed.id, '2026-11-24-a');
  assert.equal(s.last.pee.id, '2026-11-24-d');
  assert.equal(s.last.poop, null);
  assert.deepEqual(s.day, { feed: 2, pee: 1, poop: 0, pump: 0 });
});

test('ago: wording at each scale', () => {
  assert.equal(C.ago(20e3), 'just now');
  assert.equal(C.ago(12 * 60e3), '12m');
  assert.equal(C.ago(65 * 60e3), '1h 05m');
  assert.equal(C.ago(51 * H), '2d 3h');
});

test('local time round trip and day labels', () => {
  const v = C.toLocalInput(T0);
  assert.match(v, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  assert.equal(C.fromLocalInput(v), T0);
  assert.equal(C.fromLocalInput('nonsense'), null);
  assert.equal(C.dayLabel(T0, T0), 'Today');
  assert.equal(C.dayLabel(T0 - 24 * H, T0), 'Yesterday');
});

test('groupByDay: newest first with per-day counts', () => {
  const g = C.groupByDay([
    ev('2026-11-24-a', 'feed', T0), ev('2026-11-24-b', 'pee', T0 - H), ev('2026-11-22-c', 'poop', T0 - 48 * H),
  ], T0);
  assert.equal(g.length, 2);
  assert.equal(g[0].label, 'Today');
  assert.deepEqual(g[0].items.map((e) => e.id), ['2026-11-24-a', '2026-11-24-b']);
  assert.deepEqual(g[1].count, { feed: 0, pee: 0, poop: 1, pump: 0 });
  assert.equal(C.tally(g[0].count), '1 feed · 1 pee · 0 poops');
});

test('detail and csv', () => {
  assert.equal(C.detail(ev('2026-11-24-a', 'feed', T0, T0, { side: 'L', min: 15 })), 'Started left · 15 min');
  assert.equal(C.detail(ev('2026-11-24-a', 'feed', T0, T0, { side: 'bottle', oz: 2.5, note: 'sleepy' })), 'Bottle · 2.5 oz · sleepy');
  assert.equal(C.detail(ev('2026-11-24-a', 'pee', T0)), '');
  const csv = C.toCsv([ev('2026-11-24-a', 'feed', T0, T0, { side: 'R', note: 'said "hi", twice', by: 'Dad' }), ev('2026-11-24-b', 'pee', T0, T0, { x: true })]);
  const lines = csv.trim().split('\n');
  assert.equal(lines.length, 2, 'header + one live row');
  assert.ok(lines[1].includes('"said ""hi"", twice"'));
});

test('setup link: round trip, accents, and rubbish is refused', () => {
  const s = C.encodeSetup({ t: 'github_pat_abc', r: 'someone/babylog-data', b: 'Zoë' });
  assert.doesNotMatch(s, /[+/=]/);
  assert.deepEqual(C.decodeSetup(s), { t: 'github_pat_abc', r: 'someone/babylog-data', b: 'Zoë' });
  assert.equal(C.decodeSetup('not-a-link'), null);
  assert.equal(C.decodeSetup(C.encodeSetup({ t: 'x', r: 'https://evil.example/a/b' })), null);
});

test('clean: drops unknown fields and bad entries', () => {
  assert.equal(C.clean({ id: 'nope', k: 'feed', t: T0 }), null);
  assert.equal(C.clean({ id: '2026-11-24-a', k: 'nap', t: T0 }), null);
  const c = C.clean({ id: '2026-11-24-a', k: 'pee', t: T0, u: 5, side: 'L', oz: 3, evil: '<script>', note: '  wet  ' });
  assert.deepEqual(c, { id: '2026-11-24-a', k: 'pee', t: T0, u: 5, note: 'wet' });
});

// ---- sync, against an in-memory stand-in for the GitHub repo ------------------------------------

function fakeGitHub() {
  const files = {}; // "days/2026-11-24.json" -> { sha, content(base64) }
  let n = 0;
  const calls = [];
  const res = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
  const fetchImpl = async (url, opts) => {
    const path = url.split('/contents/')[1];
    calls.push(`${opts.method} ${path}`);
    if (fetchImpl.down) throw new TypeError('network');
    if (opts.headers.Authorization !== 'Bearer good') return res(401, {});
    if (fetchImpl.hidden) return res(404, {}); // a key that was not given this repo: GitHub answers "not found" to everything
    if (path === undefined) return res(200, {}); // the repo itself
    if (opts.method === 'GET' && path === 'days') {
      const names = Object.keys(files);
      if (!names.length) return res(404, {});
      return res(200, names.map((p) => ({ name: p.slice(5), sha: files[p].sha })));
    }
    if (opts.method === 'GET') return files[path] ? res(200, files[path]) : res(404, {});
    const body = JSON.parse(opts.body);
    if (fetchImpl.raceOnce) { const race = fetchImpl.raceOnce; fetchImpl.raceOnce = null; race(); }
    const cur = files[path];
    if ((cur && cur.sha !== body.sha) || (!cur && body.sha)) return res(409, {});
    files[path] = { sha: `sha${n += 1}`, content: body.content };
    return res(200, { content: { sha: files[path].sha } });
  };
  const read = (day) => JSON.parse(C.b64decode(files[`days/${day}.json`].content));
  const write = (day, events) => { files[`days/${day}.json`] = { sha: `sha${n += 1}`, content: C.b64encode(JSON.stringify(events)) }; };
  return { fetchImpl, files, calls, read, write };
}

const phone = () => ({ events: {}, dirty: {}, shas: {} });
const log = (st, e) => { st.events[e.id] = e; st.dirty[C.bucketOf(e.id)] = e.u; };

test('sync: two phones end up with the same log', async () => {
  const gh = fakeGitHub();
  const store = new GitHubStore('good', 'o/r', gh.fetchImpl);
  const dad = phone(); const mom = phone();
  log(dad, ev('2026-11-24-a', 'feed', T0, 1));
  log(mom, ev('2026-11-24-b', 'pee', T0, 2));
  await syncOnce(store, dad);
  assert.equal(await syncOnce(store, mom), true, 'mom picked up dad\'s entry');
  assert.equal(await syncOnce(store, dad), true, 'dad picked up mom\'s entry');
  assert.deepEqual(Object.keys(dad.events).sort(), ['2026-11-24-a', '2026-11-24-b']);
  assert.deepEqual(Object.keys(mom.events).sort(), ['2026-11-24-a', '2026-11-24-b']);
  assert.deepEqual(dad.dirty, {});
  assert.equal(gh.read('2026-11-24').length, 2);
});

test('sync: a delete on one phone reaches the other', async () => {
  const gh = fakeGitHub();
  const store = new GitHubStore('good', 'o/r', gh.fetchImpl);
  const dad = phone(); const mom = phone();
  log(dad, ev('2026-11-24-a', 'poop', T0, 1));
  await syncOnce(store, dad); await syncOnce(store, mom);
  log(mom, ev('2026-11-24-a', 'poop', T0, 9, { x: true }));
  await syncOnce(store, mom); await syncOnce(store, dad);
  assert.equal(dad.events['2026-11-24-a'].x, true);
});

test('sync: a save that loses a race re-reads and keeps both entries', async () => {
  const gh = fakeGitHub();
  const store = new GitHubStore('good', 'o/r', gh.fetchImpl);
  const dad = phone();
  log(dad, ev('2026-11-24-a', 'feed', T0, 1));
  // the other phone writes between dad's read and dad's write
  gh.fetchImpl.raceOnce = () => gh.write('2026-11-24', [ev('2026-11-24-z', 'pee', T0, 3)]);
  await syncOnce(store, dad);
  assert.deepEqual(gh.read('2026-11-24').map((e) => e.id), ['2026-11-24-a', '2026-11-24-z']);
  assert.ok(dad.events['2026-11-24-z'], 'dad also has the racing entry');
  assert.equal(gh.calls.filter((c) => c.startsWith('PUT')).length, 2, 'one refused save, one good');
});

test('sync: nothing new means no upload', async () => {
  const gh = fakeGitHub();
  const store = new GitHubStore('good', 'o/r', gh.fetchImpl);
  const dad = phone();
  log(dad, ev('2026-11-24-a', 'feed', T0, 1));
  await syncOnce(store, dad);
  gh.calls.length = 0;
  assert.equal(await syncOnce(store, dad), false);
  assert.deepEqual(gh.calls, ['GET days'], 'one cheap listing, no reads, no writes');
});

test('sync: bad key and no signal fail loudly and keep the entry queued', async () => {
  const gh = fakeGitHub();
  const dad = phone();
  log(dad, ev('2026-11-24-a', 'feed', T0, 1));
  await assert.rejects(syncOnce(new GitHubStore('bad', 'o/r', gh.fetchImpl), dad), (e) => e instanceof SyncError && e.kind === 'auth');
  gh.fetchImpl.down = true;
  await assert.rejects(syncOnce(new GitHubStore('good', 'o/r', gh.fetchImpl), dad), (e) => e.kind === 'offline');
  assert.deepEqual(Object.keys(dad.dirty), ['2026-11-24'], 'still queued');
  assert.ok(dad.events['2026-11-24-a']);
});

test('sync: an entry edited while a save is in flight stays queued', async () => {
  const gh = fakeGitHub();
  const store = new GitHubStore('good', 'o/r', gh.fetchImpl);
  const dad = phone();
  log(dad, ev('2026-11-24-a', 'feed', T0, 1));
  gh.fetchImpl.raceOnce = () => log(dad, ev('2026-11-24-a', 'feed', T0, 50, { side: 'L' }));
  await syncOnce(store, dad);
  assert.deepEqual(Object.keys(dad.dirty), ['2026-11-24']);
  await syncOnce(store, dad);
  assert.deepEqual(dad.dirty, {});
  assert.equal(gh.read('2026-11-24')[0].side, 'L');
});

test('Home Screen steps: the copied text is the shown steps, numbered, with the link and the real button names', () => {
  const url = 'https://example.test/babylog/';
  const steps = C.installSteps(url);
  const text = C.installText(url);
  assert.equal(steps.length, 4);
  assert.ok(steps[0].endsWith(url));
  steps.forEach((s, i) => assert.ok(text.includes(`${i + 1}. ${s}`), `step ${i + 1} is in the copied text`));
  for (const name of ['Add to Home Screen', 'Share button', 'walks you through']) assert.ok(text.includes(name), name);
  assert.ok(!/[—]/.test(text));
});

test('sync: a key that cannot see the repo is reported, never shown as shared', async () => {
  const gh = fakeGitHub();
  gh.fetchImpl.hidden = true;
  const store = new GitHubStore('good', 'o/r', gh.fetchImpl);
  const empty = phone();
  await assert.rejects(syncOnce(store, empty), (e) => e instanceof SyncError && e.kind === 'missing' && /cannot see/.test(e.message));
  const dad = phone();
  log(dad, ev('2026-11-24-a', 'feed', T0, 1));
  await assert.rejects(syncOnce(store, dad), (e) => e.kind === 'missing');
  assert.deepEqual(Object.keys(dad.dirty), ['2026-11-24'], 'the entry stays queued');
  gh.fetchImpl.hidden = false;
  assert.equal(await syncOnce(store, empty), false, 'an empty log on a visible repo is fine');
  await syncOnce(store, dad);
  assert.deepEqual(dad.dirty, {});
});

test('next side: the opposite of where the latest breast feed started', () => {
  const now = T0 + 10 * 3600e3;
  const f = (n, hoursAgo, extra) => ev(`2026-11-24-n${n}`, 'feed', now - hoursAgo * 3600e3, T0, extra);
  assert.equal(C.nextSide([], now), null);
  assert.deepEqual(C.nextSide([f(1, 3, { side: 'L' })], now), { last: 'L', next: 'R' });
  assert.deepEqual(C.nextSide([f(1, 3, { side: 'L' }), f(2, 1, { side: 'R' })], now), { last: 'R', next: 'L' });
  // a bottle in between does not change which breast is next
  assert.deepEqual(C.nextSide([f(1, 3, { side: 'L' }), f(2, 1, { side: 'bottle' })], now), { last: 'L', next: 'R' });
  // latest breast feed has no side marked: say nothing rather than guess from an older one
  assert.equal(C.nextSide([f(1, 3, { side: 'L' }), f(2, 1, {})], now), null);
  assert.equal(C.nextSide([f(1, 3, { side: 'L' }), f(2, 1, { side: 'B' })], now), null);
  // a deleted feed and a pee are ignored
  assert.deepEqual(C.nextSide([f(1, 3, { side: 'L' }), { ...f(2, 1, { side: 'R' }), x: true }, ev('2026-11-24-n3', 'pee', now - 60e3, T0)], now), { last: 'L', next: 'R' });
});

test('pump: its own kind, with ounces and minutes, counted only when there is one', () => {
  const p = C.clean(ev('2026-11-24-p1', 'pump', T0, T0, { oz: 3.5, min: 18, side: 'L' }));
  assert.deepEqual(p, { id: '2026-11-24-p1', k: 'pump', t: T0, u: T0, oz: 3.5, min: 18 }); // a pump has no side
  assert.equal(C.detail(p), '3.5 oz · 18 min');
  assert.equal(C.clean(ev('2026-11-24-p2', 'pee', T0, T0, { oz: 2 })).oz, undefined);
  assert.equal(C.tally({ feed: 1, pee: 0, poop: 0, pump: 0 }), '1 feed · 0 pees · 0 poops');
  assert.equal(C.tally({ feed: 1, pee: 0, poop: 0, pump: 2 }), '1 feed · 0 pees · 0 poops · 2 pumps');
  assert.equal(C.summarize([p], T0 + 60e3).last.pump.id, '2026-11-24-p1');
  assert.ok(C.toCsv([p]).includes('pump,,18,3.5'));
  // pumping empties both sides, so it does not change which side a feed starts on
  assert.deepEqual(C.nextSide([ev('2026-11-24-f', 'feed', T0, T0, { side: 'L' }), ev('2026-11-24-p3', 'pump', T0 + 60e3)], T0 + 120e3), { last: 'L', next: 'R' });
});

test('how much: only where it means something, in half ounces', () => {
  assert.equal(C.hasAmount({ k: 'pump' }), true);
  assert.equal(C.hasAmount({ k: 'feed', side: 'bottle' }), true);
  assert.equal(C.hasAmount({ k: 'feed', side: 'L' }), false);
  assert.equal(C.hasAmount({ k: 'pee' }), false);
  assert.equal(C.stepOz(undefined, 0.5), 0.5);
  assert.equal(C.stepOz(2, 0.5), 2.5);
  assert.equal(C.stepOz(0, -0.5), 0);
  assert.equal(C.stepOz(20, 0.5), 20);
});

test('how long: the newest feed or pump runs until Done, and is never guessed', () => {
  const now = T0 + 3 * 3600e3;
  const m = 60e3;
  const feed = ev('2026-11-24-r1', 'feed', now - 8 * m);
  assert.equal(C.running([feed], now).id, feed.id);
  assert.equal(C.minutesSince(feed.t, now), 8);
  assert.equal(C.minutesSince(now, now), 1); // never zero minutes
  assert.equal(C.running([{ ...feed, min: 8 }], now), null);               // finished
  assert.equal(C.running([ev('2026-11-24-r2', 'feed', now - 91 * m)], now), null); // forgotten: left blank
  assert.equal(C.running([{ ...feed, x: true }], now), null);              // deleted
  assert.equal(C.running([ev('2026-11-24-r3', 'pee', now - m)], now), null);
  // a pee after it does not hide it; a newer pump takes over
  assert.equal(C.running([feed, ev('2026-11-24-r4', 'pee', now - m)], now).id, feed.id);
  const pump = ev('2026-11-24-r5', 'pump', now - 2 * m);
  assert.equal(C.running([feed, pump], now).id, pump.id);
  // the newest one is finished: an older unfinished one stays blank rather than come back
  assert.equal(C.running([feed, { ...pump, min: 2 }], now), null);
});

test('whose phone: Mom is asked the side, Dad starts on Bottle, both can change it', () => {
  assert.deepEqual(C.feedDefaults({ feed: 'bottle' }), { side: 'bottle' });
  assert.deepEqual(C.feedDefaults({ feed: 'breast' }), {});
  assert.deepEqual(C.feedDefaults({}), {});
  assert.equal(C.ROLES.mom.feed, 'breast');
  assert.equal(C.ROLES.dad.feed, 'bottle');
  assert.equal(C.ROLES.dad.other, 'Mom');
});

test('first-run guide: each phone gets only the screen it still needs', () => {
  const base = { iphone: true, standalone: false, hasToken: false, hasRole: false, later: false, skippedConnect: false };
  assert.equal(C.firstScreen(base), 'install');                                        // Safari on an iPhone
  assert.equal(C.firstScreen({ ...base, later: true }), 'who');                        // "not now"
  assert.equal(C.firstScreen({ ...base, standalone: true }), 'connect');               // Home Screen, no log yet
  assert.equal(C.firstScreen({ ...base, standalone: true, hasToken: true }), 'who');   // the invite carried over
  assert.equal(C.firstScreen({ ...base, standalone: true, skippedConnect: true }), 'who');
  assert.equal(C.firstScreen({ ...base, standalone: true, hasToken: true, hasRole: true }), null);
  assert.equal(C.firstScreen({ ...base, iphone: false }), 'who');                      // a computer: no Home Screen step
  assert.equal(C.firstScreen({ ...base, iphone: false, hasRole: true }), null);
});

test('invite: found in a whole text message, a link or the bare code; anything else is refused', () => {
  const code = C.encodeSetup({ t: 'github_pat_abc', r: 'someone/babylog-data', b: 'Jubilee' });
  const want = { t: 'github_pat_abc', r: 'someone/babylog-data', b: 'Jubilee' };
  assert.deepEqual(C.findSetup(`Tap this to set up Jubilee. https://x.test/babylog/#s=${code}`), want);
  assert.deepEqual(C.findSetup(`https://x.test/babylog/#s=${code}\n`), want);
  assert.deepEqual(C.findSetup(code), want);
  assert.equal(C.findSetup('see you at 5'), null);
  assert.equal(C.findSetup(''), null);
  assert.equal(C.findSetup(undefined), null);
  assert.equal(C.sameSetup({ token: 'github_pat_abc', repo: 'someone/babylog-data' }, want), true);
  assert.equal(C.sameSetup({ token: 'other', repo: 'someone/babylog-data' }, want), false);
  assert.equal(C.sameSetup({ token: '', repo: '' }, null), false);
});

test('invite card: goes away once someone else has logged', () => {
  const mine = ev('2026-11-24-i1', 'pee', T0, T0, { by: 'Dad' });
  assert.equal(C.othersHaveLogged([mine], 'Dad'), false);
  assert.equal(C.othersHaveLogged([mine, ev('2026-11-24-i2', 'pee', T0)], 'Dad'), false); // no name on it: not proof
  assert.equal(C.othersHaveLogged([mine, ev('2026-11-24-i3', 'feed', T0, T0, { by: 'Mom' })], 'Dad'), true);
  assert.equal(C.othersHaveLogged([{ ...ev('2026-11-24-i4', 'feed', T0, T0, { by: 'Mom' }), x: true }], 'Dad'), false);
});
