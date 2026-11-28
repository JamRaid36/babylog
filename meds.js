// Mom's medicine: pure logic, no DOM, no network. Runs in the browser and under `node --test`.
//
// Kept apart from the baby's entries on purpose: these live in their own folder of the private repo
// (meds/YYYY-MM-DD.json), so a phone still running an older copy of the app, which reads and rewrites
// days/ only, can never drop them.
//
// Two kinds of entry, same id scheme and merge rules as the baby's (see core.js):
//   k "med"   a medicine she takes:  name, dose (free text, optional), every (hours between doses; 0 = as needed)
//   k "dose"  she took one:          med (the medicine's id), t (when), and a copy of name, dose and every
//                                     as they were then, so history still reads right after an edit
// Both carry id, t, u, by, and x when deleted, exactly like the baby's entries.

import { newId, live, clock, ago } from './core.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// Hours between doses she can pick from. 0 means "as needed": no next time is worked out.
export const EVERY = [4, 6, 8, 12, 24, 0];
export const everyText = (h) => (h > 0 ? `Every ${h} hours` : 'As needed');
// Names offered when adding one, so the usual two are a tap away. Name only: the dose and timing are
// hers to fill in from the label or her prescription; the app never suggests an amount.
export const PRESETS = ['Ibuprofen (Advil, Motrin)', 'Acetaminophen (Tylenol)'];

export function newMed({ name, dose, every }, by = '', now = Date.now()) {
  return cleanMed({ id: newId(now), k: 'med', t: now, u: now, by, name, dose, every });
}
export function newDose(med, t, by = '', now = Date.now()) {
  return cleanMed({ id: newId(now), k: 'dose', t, u: now, by, med: med.id, name: med.name, dose: med.dose, every: med.every });
}

// Keep only fields we know, with sane types, before an entry is saved or accepted from sync.
export function cleanMed(e) {
  if (!e || typeof e.id !== 'string' || !/^\d{4}-\d{2}-\d{2}-[a-z0-9]+$/.test(e.id)) return null;
  if ((e.k !== 'med' && e.k !== 'dose') || !Number.isFinite(e.t)) return null;
  const name = typeof e.name === 'string' ? e.name.trim().slice(0, 60) : '';
  if (!name) return null;
  const out = { id: e.id, k: e.k, t: e.t, u: Number.isFinite(e.u) ? e.u : 0, name };
  if (typeof e.by === 'string' && e.by) out.by = e.by.slice(0, 40);
  if (e.x) out.x = true;
  if (typeof e.dose === 'string' && e.dose.trim()) out.dose = e.dose.trim().slice(0, 60);
  out.every = EVERY.includes(Number(e.every)) ? Number(e.every) : 0;
  if (e.k === 'dose') {
    if (typeof e.med !== 'string' || !e.med) return null;
    out.med = e.med;
  }
  return out;
}

export const medLabel = (m) => (m.dose ? `${m.name} · ${m.dose}` : m.name);

// One line per medicine she has, in the order they were added:
//   med      the medicine
//   last     her latest dose of it, or null
//   nextAt   when the next one is due by its schedule, or null (as needed, or never taken)
//   ok       true when that time has come, or there is no schedule to wait for
//   today    how many doses in the last 24 hours
export function medStatus(events, now = Date.now()) {
  const all = live(events);
  const meds = all.filter((e) => e.k === 'med').sort((a, b) => a.t - b.t);
  return meds.map((med) => {
    const doses = all.filter((e) => e.k === 'dose' && e.med === med.id && e.t <= now + MIN);
    const last = doses[0] || null;
    const nextAt = last && med.every > 0 ? last.t + med.every * HOUR : null;
    return {
      med, last, nextAt,
      ok: nextAt === null || now >= nextAt,
      today: doses.filter((d) => now - d.t < DAY).length,
    };
  });
}

// The words on a medicine's card. Never says "take it": only what the log shows and what her schedule says.
//   head  the big line: "OK again at 2:10 PM", "OK to take now", "Not taken yet", "Last 3h 05m ago"
//   sub   the small line: "Last 8:10 AM · in 3h 20m", "Last 8:10 AM by Dad · 2 in 24 hours"
export function statusText(s, now = Date.now()) {
  if (!s.last) return { head: 'Not taken yet', sub: everyText(s.med.every) };
  const by = s.last.by ? ` by ${s.last.by}` : '';
  const count = s.today > 1 ? ` · ${s.today} in 24 hours` : '';
  const lastLine = `Last ${clock(s.last.t)}${by}`;
  if (s.nextAt === null) return { head: `Last ${ago(Math.max(0, now - s.last.t))} ago`, sub: `${lastLine}${count}` };
  if (s.ok) return { head: 'OK to take now', sub: `${lastLine}${count}` };
  return { head: `OK again at ${clock(s.nextAt)}`, sub: `${lastLine} · in ${ago(s.nextAt - now)}${count}` };
}

// Said in the "Took it" sheet when the schedule says it is early, so nobody doubles up by accident at 3 AM.
export function earlyWarning(s, t) {
  if (!s || !s.last || s.nextAt === null || t >= s.nextAt) return '';
  return `The last one was at ${clock(s.last.t)}${s.last.by ? `, logged by ${s.last.by}` : ''}. Her schedule says the next one is at ${clock(s.nextAt)}.`;
}

// Her doses of one medicine, newest first, for the medicine's sheet.
export function dosesOf(events, medId) {
  return live(events).filter((e) => e.k === 'dose' && e.med === medId);
}
