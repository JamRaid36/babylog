// Mom's meds: the logic, and that her entries sync in their own folder where an older app never looks.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../core.js';
import * as M from '../meds.js';
import { GitHubStore, syncOnce } from '../sync.js';

const H = 3600e3;
const NOW = Date.UTC(2026, 10, 28, 18, 0);
const ibu = M.newMed({ name: ' Ibuprofen ', dose: '600 mg', every: 6 }, 'Mom', NOW - 10 * H);

test('meds: a medicine keeps only what we know, trimmed', () => {
  assert.equal(ibu.name, 'Ibuprofen');
  assert.equal(ibu.k, 'med');
  assert.equal(ibu.every, 6);
  assert.equal(M.cleanMed({ ...ibu, name: '   ' }), null, 'no name, no medicine');
  assert.equal(M.cleanMed({ ...ibu, every: 5 }).every, 0, 'an odd schedule falls back to as needed');
  assert.equal(M.cleanMed({ ...ibu, k: 'feed' }), null, 'a baby entry is never a medicine');
  assert.equal(M.cleanMed({ ...ibu, k: 'dose' }), null, 'a dose must say which medicine');
});

test('meds: a dose copies the medicine as it was, so an edit later does not rewrite history', () => {
  const d = M.newDose(ibu, NOW - H, 'Dad', NOW);
  assert.deepEqual([d.k, d.med, d.name, d.dose, d.every, d.by, d.t], ['dose', ibu.id, 'Ibuprofen', '600 mg', 6, 'Dad', NOW - H]);
});

test('meds: never taken, then waiting, then OK again', () => {
  let s = M.medStatus([ibu], NOW)[0];
  assert.equal(s.last, null);
  assert.equal(M.statusText(s, NOW).head, 'Not taken yet');
  assert.equal(M.statusText(s, NOW).sub, 'Every 6 hours');

  const d = M.newDose(ibu, NOW - 2 * H, 'Dad', NOW - 2 * H);
  s = M.medStatus([ibu, d], NOW)[0];
  assert.equal(s.nextAt, NOW + 4 * H);
  assert.equal(s.ok, false);
  const words = M.statusText(s, NOW);
  assert.match(words.head, /^OK again at /);
  assert.match(words.sub, /by Dad · in 4h 00m$/);

  s = M.medStatus([ibu, d], NOW + 4 * H)[0];
  assert.equal(s.ok, true);
  assert.equal(M.statusText(s, NOW + 4 * H).head, 'OK to take now');
});

test('meds: the newest dose counts, deleted ones and other medicines do not', () => {
  const ty = M.newMed({ name: 'Tylenol', every: 6 }, 'Mom', NOW - 9 * H);
  const old = M.newDose(ibu, NOW - 5 * H, '', NOW - 5 * H);
  const late = { ...M.newDose(ibu, NOW - H, '', NOW - H), x: true };
  const other = M.newDose(ty, NOW - 0.5 * H, '', NOW);
  const [si, st] = M.medStatus([ibu, ty, old, late, other], NOW);
  assert.equal(si.last.id, old.id);
  assert.equal(si.nextAt, NOW + H);
  assert.equal(st.last.id, other.id);
  assert.equal(si.today, 1);
});

test('meds: as needed shows how long ago, never a next time', () => {
  const prn = M.newMed({ name: 'Stool softener', every: 0 }, '', NOW - 9 * H);
  const d = M.newDose(prn, NOW - 3 * H, '', NOW);
  const s = M.medStatus([prn, d], NOW)[0];
  assert.equal(s.nextAt, null);
  assert.equal(s.ok, true);
  assert.equal(M.statusText(s, NOW).head, 'Last 3h 00m ago');
  assert.equal(M.earlyWarning(s, NOW), '');
});

test('meds: a removed medicine leaves the front page, its doses stay in the log', () => {
  const d = M.newDose(ibu, NOW - H, '', NOW);
  assert.equal(M.medStatus([{ ...ibu, x: true }, d], NOW).length, 0);
  assert.equal(M.dosesOf([{ ...ibu, x: true }, d], ibu.id).length, 1);
});

test('meds: early is called out, on time is not', () => {
  const d = M.newDose(ibu, NOW - 2 * H, 'Dad', NOW);
  const s = M.medStatus([ibu, d], NOW)[0];
  assert.match(M.earlyWarning(s, NOW), /logged by Dad\. Her schedule says the next one is at /);
  assert.equal(M.earlyWarning(s, NOW + 4 * H), '');
  assert.equal(M.earlyWarning(M.medStatus([ibu], NOW)[0], NOW), '', 'nothing to compare with yet');
});

test('meds: presets are names only, never an amount', () => {
  for (const p of M.PRESETS) assert.doesNotMatch(p, /\d/);
});

// A fake GitHub that keeps files by full path, so the two folders can be told apart.
function fakeGitHub() {
  const files = {};
  let n = 0;
  const res = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
  const fetchImpl = async (url, opts) => {
    const path = url.split('/contents/')[1];
    if (path === undefined) return res(200, {});
    if (opts.method === 'GET' && !path.endsWith('.json')) {
      const names = Object.keys(files).filter((p) => p.startsWith(`${path}/`));
      return names.length ? res(200, names.map((p) => ({ name: p.slice(path.length + 1), sha: files[p].sha }))) : res(404, {});
    }
    if (opts.method === 'GET') return files[path] ? res(200, files[path]) : res(404, {});
    const body = JSON.parse(opts.body);
    const cur = files[path];
    if ((cur && cur.sha !== body.sha) || (!cur && body.sha)) return res(409, {});
    files[path] = { sha: `sha${n += 1}`, content: body.content };
    return res(200, { content: { sha: files[path].sha } });
  };
  return { fetchImpl, files };
}
const phone = () => ({ events: {}, dirty: {}, shas: {} });
const log = (st, e) => { st.events[e.id] = e; st.dirty[C.bucketOf(e.id)] = e.u; };
const medStore = (gh) => new GitHubStore('good', 'o/r', gh.fetchImpl, { dir: 'meds', keep: M.cleanMed });

test('meds sync: both phones see her doses, and they live in meds/, not days/', async () => {
  const gh = fakeGitHub();
  const mom = phone();
  const dad = phone();
  const d = M.newDose(ibu, NOW - H, 'Mom', NOW);
  log(mom, ibu);
  log(mom, d);
  await syncOnce(medStore(gh), mom);
  await syncOnce(medStore(gh), dad);
  assert.deepEqual(Object.keys(dad.events).sort(), [ibu.id, d.id].sort());
  assert.ok(Object.keys(gh.files).every((p) => p.startsWith('meds/')), Object.keys(gh.files).join(','));
});

test('meds sync: an older app rewriting days/ cannot drop a dose', async () => {
  const gh = fakeGitHub();
  const mom = phone();
  log(mom, ibu);
  await syncOnce(medStore(gh), mom);
  const baby = phone(); // an older copy of the app only ever syncs days/ with the baby cleaner
  const pee = C.clean({ id: C.newId(NOW), k: 'pee', t: NOW, u: NOW });
  log(baby, pee);
  await syncOnce(new GitHubStore('good', 'o/r', gh.fetchImpl), baby);
  const dad = phone();
  await syncOnce(medStore(gh), dad);
  assert.ok(dad.events[ibu.id], 'her medicine is still there');
  assert.equal(Object.keys(baby.events).length, 1, 'and the baby log never saw it');
});

test('meds sync: a baby entry slipped into meds/ is refused by the meds cleaner, and the other way round', () => {
  const pee = C.clean({ id: C.newId(NOW), k: 'pee', t: NOW, u: NOW });
  assert.equal(M.cleanMed(pee), null);
  assert.equal(C.clean(ibu), null);
});
