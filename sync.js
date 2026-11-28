// Shared storage: a private GitHub repo, one small JSON file per day (days/YYYY-MM-DD.json; Mom's
// medicine in meds/YYYY-MM-DD.json, which older copies of the app never read or write).
// Each phone reads a day's file, merges it with its own copy, and writes the result back.
// GitHub refuses a write made against an out-of-date file, so two phones can never silently
// overwrite each other: the loser re-reads, merges and tries again.

import { b64decode, b64encode, bucketOf, clean, mergeEvents, sameEvents } from './core.js';

const API = 'https://api.github.com';

const CANNOT_SEE = 'The sync key cannot see the private log. On GitHub, check the key was given access to the log\'s repository, with Contents set to Read and write.';

export class SyncError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind; // 'auth' | 'missing' | 'conflict' | 'offline' | 'other'
  }
}

export class GitHubStore {
  // dir: the folder of day files ('days' for the baby, 'meds' for Mom's medicine). keep: the cleaner
  // every entry read from that folder goes through, so each folder only ever holds its own kind.
  constructor(token, repo, fetchImpl = (...a) => fetch(...a), { dir = 'days', keep = clean } = {}) {
    this.token = token;
    this.repo = repo;
    this.fetch = fetchImpl;
    this.dir = dir;
    this.keep = keep;
  }

  async call(method, path, body) {
    let res;
    try {
      res = await this.fetch(`${API}/repos/${this.repo}${path ? `/${path}` : ''}`, {
        method,
        cache: 'no-store', // GitHub marks reads cacheable for 60s; a stale read would break the next write
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new SyncError('offline', 'No connection. Entries are saved on this phone and will sync later.');
    }
    if (res.status === 401 || res.status === 403) {
      throw new SyncError('auth', 'GitHub refused the sync key. Check it in Settings.');
    }
    if (res.status === 409 || res.status === 422) throw new SyncError('conflict', 'File changed during save.');
    return res;
  }

  // { "2026-11-24": "<file sha>", ... } for every day file in the repo.
  async list() {
    const res = await this.call('GET', `contents/${this.dir}`);
    if (res.status === 404) {
      // No log folder yet is normal on day one. A key that cannot see the repo at all also answers 404,
      // so ask for the repo itself before calling this "shared".
      if ((await this.call('GET', '')).status === 404) throw new SyncError('missing', CANNOT_SEE);
      return {};
    }
    if (!res.ok) throw new SyncError('other', `GitHub answered ${res.status} listing the log.`);
    const out = {};
    for (const f of await res.json()) {
      const m = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(f.name || '');
      if (m) out[m[1]] = f.sha;
    }
    return out;
  }

  async get(day) {
    const res = await this.call('GET', `contents/${this.dir}/${day}.json`);
    if (res.status === 404) return { sha: null, events: [] };
    if (!res.ok) throw new SyncError('other', `GitHub answered ${res.status} reading ${day}.`);
    const file = await res.json();
    let events = [];
    try {
      events = JSON.parse(b64decode(file.content || '')).map(this.keep).filter(Boolean);
    } catch {
      events = []; // an unreadable file is treated as empty and rewritten from the phones' copies
    }
    return { sha: file.sha, events };
  }

  async put(day, events, sha) {
    const res = await this.call('PUT', `contents/${this.dir}/${day}.json`, {
      message: `${this.dir === 'days' ? 'log' : this.dir} ${day}`,
      content: b64encode(JSON.stringify(events)),
      ...(sha ? { sha } : {}),
    });
    if (res.status === 404) throw new SyncError('missing', CANNOT_SEE);
    if (!res.ok) throw new SyncError('other', `GitHub answered ${res.status} saving ${day}.`);
    return (await res.json()).content.sha;
  }
}

// One full sync pass. `state` is { events: {id: event}, dirty: {day: stamp}, shas: {day: sha} } and is
// changed in place. Returns true when anything on this phone changed (so the screen should redraw).
export async function syncOnce(store, state) {
  let changed = false;

  const absorb = (list) => {
    for (const e of list) {
      const mine = state.events[e.id];
      const [winner] = mergeEvents(mine ? [mine] : [], [e]);
      if (winner !== mine) { state.events[e.id] = winner; changed = true; }
    }
  };
  const localDay = (day) => Object.values(state.events).filter((e) => bucketOf(e.id) === day);

  // 1. Send the days this phone has changed.
  for (const day of Object.keys(state.dirty)) {
    const stamp = state.dirty[day];
    let done = false;
    for (let attempt = 0; attempt < 4 && !done; attempt += 1) {
      const remote = await store.get(day);
      absorb(remote.events);
      const merged = mergeEvents(remote.events, localDay(day));
      try {
        state.shas[day] = sameEvents(merged, remote.events) && remote.sha
          ? remote.sha
          : await store.put(day, merged, remote.sha);
        done = true;
      } catch (err) {
        if (!(err instanceof SyncError) || err.kind !== 'conflict') throw err;
        // the other phone saved in between: go round again with its copy
      }
    }
    if (!done) throw new SyncError('other', 'Could not save after several tries. Will retry.');
    if (state.dirty[day] === stamp) delete state.dirty[day]; // unless it was edited again meanwhile
  }

  // 2. Fetch the days that changed on GitHub since this phone last looked.
  const remoteShas = await store.list();
  for (const [day, sha] of Object.entries(remoteShas)) {
    if (state.shas[day] === sha) continue;
    const remote = await store.get(day);
    absorb(remote.events);
    state.shas[day] = remote.sha;
  }
  return changed;
}
