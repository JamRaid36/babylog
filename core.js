// Pure logic for the baby log. No DOM, no network: runs in the browser and under `node --test`.
//
// Event shape (short keys keep the synced files small):
//   id   "YYYY-MM-DD-<base36>"  the date part is the UTC day it was CREATED and never changes;
//                               it names the file ("bucket") the event is stored in
//   k    "feed" | "pee" | "poop"
//   t    when it happened (ms since epoch)
//   u    when it was last changed (ms); the newer copy wins a merge
//   by   who logged it (free text, may be "")
//   x    true when deleted (kept as a tombstone so a delete reaches the other phone)
//   feed only: side "L" | "R" | "B" | "bottle", min (minutes), oz (ounces); all optional
//   note free text, optional

export const KINDS = ['feed', 'pee', 'poop'];
export const KIND_LABEL = { feed: 'Feed', pee: 'Pee', poop: 'Poop' };
export const SIDE_LABEL = { L: 'Left', R: 'Right', B: 'Both sides', bottle: 'Bottle' };

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
  const last = { feed: null, pee: null, poop: null };
  const day = { feed: 0, pee: 0, poop: 0 };
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
  if (e.k === 'feed') {
    if (e.side && SIDE_LABEL[e.side]) parts.push(SIDE_LABEL[e.side]);
    if (e.min > 0) parts.push(`${e.min} min`);
    if (e.oz > 0) parts.push(`${e.oz} oz`);
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
      cur = { key, label: dayLabel(e.t, now), items: [], count: { feed: 0, pee: 0, poop: 0 } };
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
      e.k === 'feed' ? (e.min || '') : '',
      e.k === 'feed' ? (e.oz || '') : '',
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

// Keep only fields we know, with sane types, before an entry is saved or accepted from sync.
export function clean(e) {
  if (!e || typeof e.id !== 'string' || !/^\d{4}-\d{2}-\d{2}-[a-z0-9]+$/.test(e.id)) return null;
  if (!KINDS.includes(e.k) || !Number.isFinite(e.t)) return null;
  const out = { id: e.id, k: e.k, t: e.t, u: Number.isFinite(e.u) ? e.u : 0 };
  if (typeof e.by === 'string' && e.by) out.by = e.by.slice(0, 40);
  if (e.x) out.x = true;
  if (e.k === 'feed') {
    if (e.side in SIDE_LABEL) out.side = e.side;
    if (Number.isFinite(e.min) && e.min > 0) out.min = Math.min(Math.round(e.min), 600);
    if (Number.isFinite(e.oz) && e.oz > 0) out.oz = Math.min(Math.round(e.oz * 100) / 100, 99);
  }
  if (typeof e.note === 'string' && e.note.trim()) out.note = e.note.trim().slice(0, 280);
  return out;
}
