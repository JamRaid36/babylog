// Pure logic for the baby log. No DOM, no network: runs in the browser and under `node --test`.
//
// Event shape (short keys keep the synced files small):
//   id   "YYYY-MM-DD-<base36>"  the date part is the UTC day it was CREATED and never changes;
//                               it names the file ("bucket") the event is stored in
//   k    "feed" | "pee" | "poop" | "pump"
//   t    when it happened (ms since epoch)
//   u    when it was last changed (ms); the newer copy wins a merge
//   by   who logged it (free text, may be "")
//   x    true when deleted (kept as a tombstone so a delete reaches the other phone)
//   feed only: side "L" | "R" | "B" | "bottle" (the side it STARTED on); optional
//   feed and pump: min (how long, minutes), oz (ounces drunk or pumped); optional
//   note free text, optional

export const KINDS = ['feed', 'pee', 'poop', 'pump'];
export const KIND_LABEL = { feed: 'Feed', pee: 'Pee', poop: 'Poop', pump: 'Pump' };
const TIMED = ['feed', 'pump']; // the kinds that last a while and can carry minutes and ounces
export const hasAmount = (e) => !!e && (e.k === 'pump' || (e.k === 'feed' && e.side === 'bottle'));

// The feed or pump that is still going: the newest one, started in the last 90 minutes, with no
// length yet. Anything older was simply never finished off, and we do not invent a length for it.
export function running(events, now = Date.now()) {
  const e = live(events).find((x) => TIMED.includes(x.k) && x.t <= now + MIN);
  if (!e || e.min > 0 || now - e.t > 90 * MIN) return null;
  return e;
}
export function minutesSince(t, now = Date.now()) {
  return Math.max(1, Math.round((now - t) / MIN));
}
// Ounces move in halves and never go below zero or silly-high.
export function stepOz(oz, by) {
  return Math.min(20, Math.max(0, Math.round(((oz || 0) + by) * 2) / 2));
}
export const SIDE_LABEL = { L: 'Left', R: 'Right', B: 'Both sides', bottle: 'Bottle' };
// `side` on a feed is the side it STARTED on. How it reads under an entry:
export const SIDE_DETAIL = { L: 'Started left', R: 'Started right', B: 'Both sides', bottle: 'Bottle' };

// Which side to start the next feed on: the opposite of where the latest breast feed started.
// Bottle feeds are skipped. If the latest breast feed has no side marked, there is no honest answer: null.
export function nextSide(events, now = Date.now()) {
  for (const e of live(events)) {
    if (e.k !== 'feed' || e.t > now + MIN || e.side === 'bottle') continue;
    if (e.side === 'L') return { last: 'L', next: 'R' };
    if (e.side === 'R') return { last: 'R', next: 'L' };
    return null;
  }
  return null;
}

// Who holds this phone. It sets the name on what they log and what a Feed tap means there:
// Mom's phone asks which side; Dad's phone marks a feed as a bottle (one tap changes it).
export const ROLES = {
  mom: { me: 'Mom', feed: 'breast', other: 'Dad' },
  dad: { me: 'Dad', feed: 'bottle', other: 'Mom' },
};

// The side a brand-new feed starts with on this phone, before anyone taps anything.
export function feedDefaults(cfg) {
  return cfg && cfg.feed === 'bottle' ? { side: 'bottle' } : {};
}

// Is this the log this phone is already connected to?
export function sameSetup(cfg, setup) {
  return !!setup && !!cfg && cfg.token === setup.t && cfg.repo === setup.r;
}

// Pull our setup out of anything pasted or copied: a whole text message, a link, or the bare code.
export function findSetup(text) {
  const s = String(text || '').trim();
  const m = /#s=([\w-]+)/.exec(s);
  if (m) return decodeSetup(m[1]);
  return /^[\w-]{20,}$/.test(s) ? decodeSetup(s) : null;
}

// Which first-run screen this phone needs next, or null when it needs none.
//   install  in Safari on an iPhone: put it on the Home Screen
//   connect  on the Home Screen with no shared log yet
//   who      nobody has said whose phone this is
export function firstScreen({ iphone, standalone, hasToken, hasRole, later, skippedConnect }) {
  if (iphone && !standalone && !later) return 'install';
  if (iphone && standalone && !hasToken && !skippedConnect) return 'connect';
  if (!hasRole) return 'who';
  return null;
}

// Has anyone other than this phone's owner logged something? Then the other phone is already in.
export function othersHaveLogged(events, me) {
  return live(events).some((e) => e.by && e.by !== me);
}

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export function newId(now = Date.now(), rand = Math.random) {
  const day = new Date(now).toISOString().slice(0, 10);
  const tail = Math.floor(rand() * 36 ** 6).toString(36).padStart(6, '0');
  return `${day}-${now.toString(36)}${tail}`;
}

export function bucketOf(id) {
  return id.slice(0, 10);
}

// Union two lists of events by id. The copy with the newer `u` wins; on a tie a delete wins,
// so two phones that disagree at the same millisecond still converge on the same answer.
export function mergeEvents(a, b) {
  const out = new Map();
  for (const e of [...a, ...b]) {
    if (!e || typeof e.id !== 'string') continue;
    const cur = out.get(e.id);
    if (!cur) { out.set(e.id, e); continue; }
    const eu = e.u || 0;
    const cu = cur.u || 0;
    if (eu > cu || (eu === cu && e.x && !cur.x)) out.set(e.id, e);
  }
  return [...out.values()].sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
}

// True when both lists hold the same events at the same versions (used to skip a pointless upload).
export function sameEvents(a, b) {
  if (a.length !== b.length) return false;
  const key = (e) => `${e.id}@${e.u || 0}@${e.x ? 1 : 0}`;
  const seen = new Set(a.map(key));
  return b.every((e) => seen.has(key(e)));
}

// Not-deleted events, newest first.
export function live(events) {
  return events.filter((e) => !e.x).sort((p, q) => q.t - p.t);
}

// Latest event of each kind, and counts over the 24 hours before `now`.
export function summarize(events, now = Date.now()) {
  const last = { feed: null, pee: null, poop: null, pump: null };
  const day = { feed: 0, pee: 0, poop: 0, pump: 0 };
  for (const e of live(events)) {
    if (!(e.k in last)) continue;
    if (e.t > now + MIN) continue; // an entry dated in the future is not "last"
    if (!last[e.k]) last[e.k] = e;
    if (now - e.t < DAY) day[e.k] += 1;
  }
  return { last, day };
}

// "just now", "12m", "1h 05m", "2d 3h"
export function ago(ms) {
  if (ms < MIN) return 'just now';
  const m = Math.floor(ms / MIN);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

const pad = (n) => String(n).padStart(2, '0');

// Local calendar day of a timestamp, "YYYY-MM-DD".
export function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function dayLabel(ts, now = Date.now()) {
  const key = dayKey(ts);
  if (key === dayKey(now)) return 'Today';
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (key === dayKey(y.getTime())) return 'Yesterday';
  return new Date(ts).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

export function clock(ts) {
  return new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

// Value for <input type="datetime-local">, in local time.
export function toLocalInput(ts) {
  const d = new Date(ts);
  return `${dayKey(ts)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(value) {
  const ts = new Date(value).getTime();
  return Number.isFinite(ts) ? ts : null;
}

// The small line under an entry: "Left · 15 min", "Bottle · 2.5 oz", or "".
export function detail(e) {
  const parts = [];
  if (e.k === 'feed' && e.side && SIDE_DETAIL[e.side]) parts.push(SIDE_DETAIL[e.side]);
  if (TIMED.includes(e.k)) {
    if (e.oz > 0) parts.push(`${e.oz} oz`);
    if (e.min > 0) parts.push(`${e.min} min`);
  }
  if (e.note) parts.push(e.note);
  return parts.join(' · ');
}

// Events grouped by local day, newest day first, newest entry first within a day.
export function groupByDay(events, now = Date.now()) {
  const groups = [];
  let cur = null;
  for (const e of live(events)) {
    const key = dayKey(e.t);
    if (!cur || cur.key !== key) {
      cur = { key, label: dayLabel(e.t, now), items: [], count: { feed: 0, pee: 0, poop: 0, pump: 0 } };
      groups.push(cur);
    }
    cur.items.push(e);
    if (e.k in cur.count) cur.count[e.k] += 1;
  }
  return groups;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export function tally(count) {
  return [
    plural(count.feed, 'feed', 'feeds'),
    plural(count.pee, 'pee', 'pees'),
    plural(count.poop, 'poop', 'poops'),
    ...(count.pump ? [plural(count.pump, 'pump', 'pumps')] : []),
  ].join(' · ');
}

function csvCell(v) {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(events) {
  const rows = [['date', 'time', 'type', 'side', 'minutes', 'ounces', 'note', 'logged by']];
  for (const e of live(events).reverse()) {
    rows.push([
      dayKey(e.t), toLocalInput(e.t).slice(11), e.k,
      e.k === 'feed' ? (SIDE_LABEL[e.side] || '') : '',
      TIMED.includes(e.k) ? (e.min || '') : '',
      TIMED.includes(e.k) ? (e.oz || '') : '',
      e.note || '', e.by || '',
    ]);
  }
  return rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}

// Text <-> base64 that survives names with accents (btoa alone is Latin-1 only).
export function b64encode(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function b64decode(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// The "set up the other phone" link carries the sync settings after the # so they are never
// sent to the web server. Returns null for anything that is not one of our links.
export function encodeSetup(obj) {
  return b64encode(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeSetup(str) {
  try {
    const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
    const obj = JSON.parse(b64decode(b64 + '='.repeat((4 - (b64.length % 4)) % 4)));
    if (!obj || typeof obj.t !== 'string' || typeof obj.r !== 'string') return null;
    if (!/^[\w.-]+\/[\w.-]+$/.test(obj.r)) return null;
    return { t: obj.t, r: obj.r, b: typeof obj.b === 'string' ? obj.b : '' };
  } catch {
    return null;
  }
}

// The "put this app on a Home Screen" steps, shown on the front page and copied as a text message.
// One list feeds both, so what is read and what is sent can never differ.
export function installSteps(url) {
  return [
    `Open this link in Safari: ${url}`,
    'Tap the Share button (the square with the arrow pointing up). If you don\'t see it, tap the three dots first.',
    'Scroll down, tap "Add to Home Screen", then tap "Add".',
    'Open "Jubilee" from your Home Screen, not from Safari. It walks you through the rest.',
  ];
}

export function installText(url) {
  const steps = installSteps(url).map((s, i) => `${i + 1}. ${s}`);
  return ['Jubilee: one tap to log a feed, pee or poop. To put it on your iPhone:', '', ...steps].join('\n');
}

// Keep only fields we know, with sane types, before an entry is saved or accepted from sync.
export function clean(e) {
  if (!e || typeof e.id !== 'string' || !/^\d{4}-\d{2}-\d{2}-[a-z0-9]+$/.test(e.id)) return null;
  if (!KINDS.includes(e.k) || !Number.isFinite(e.t)) return null;
  const out = { id: e.id, k: e.k, t: e.t, u: Number.isFinite(e.u) ? e.u : 0 };
  if (typeof e.by === 'string' && e.by) out.by = e.by.slice(0, 40);
  if (e.x) out.x = true;
  if (e.k === 'feed' && e.side in SIDE_LABEL) out.side = e.side;
  if (TIMED.includes(e.k)) {
    if (Number.isFinite(e.min) && e.min > 0) out.min = Math.min(Math.round(e.min), 600);
    if (Number.isFinite(e.oz) && e.oz > 0) out.oz = Math.min(Math.round(e.oz * 100) / 100, 99);
  }
  if (typeof e.note === 'string' && e.note.trim()) out.note = e.note.trim().slice(0, 280);
  return out;
}
