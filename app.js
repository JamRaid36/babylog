import * as C from './core.js';
import * as M from './meds.js';
import { GitHubStore, SyncError, syncOnce } from './sync.js';

const $ = (sel) => document.querySelector(sel);
const DEFAULT_REPO = 'JamRaid36/babylog-data';
const DEMO = new URLSearchParams(location.search).has('demo'); // sample data, nothing saved, no sync

// ── Saved state (this phone) ────────────────────────────────────────────────────────────────────
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  },
  set(key, value) {
    if (DEMO) return true;
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  },
};

// role: 'mom' | 'dad' | 'other' | '' (not asked yet).  feed: what a Feed tap means here, 'breast' | 'bottle'.
let cfg = { me: '', role: '', feed: '', unit: '', baby: '', token: '', repo: DEFAULT_REPO, ...store.get('bl.cfg', {}) };
const unitNow = () => (cfg.unit === 'ml' ? 'ml' : 'oz'); // this phone's unit for amounts; ounces until someone picks mL
const state = {
  events: store.get('bl.events', {}), // id -> event
  dirty: store.get('bl.dirty', {}),   // day -> stamp: days with changes not yet sent
  shas: store.get('bl.shas', {}),     // day -> version of the shared file last seen
};
// Mom's medicine: same shape, its own folder in the shared log (meds/), its own place on this phone.
const meds = {
  events: store.get('bl.meds', {}),
  dirty: store.get('bl.medsDirty', {}),
  shas: store.get('bl.medsShas', {}),
};
let syncInfo = { state: 'local', text: 'This phone only. Tap to connect' };

function persist() {
  const ok = store.set('bl.events', state.events) && store.set('bl.dirty', state.dirty) && store.set('bl.shas', state.shas)
    && store.set('bl.meds', meds.events) && store.set('bl.medsDirty', meds.dirty) && store.set('bl.medsShas', meds.shas);
  if (!ok) toast('This phone is out of storage space. The last entry may not be saved.');
}

if (DEMO) seedDemo();

function seedDemo() {
  const now = Date.now();
  const m = 60e3;
  const rows = [
    ['feed', 38, { side: 'L', min: 15 }, 'Dad'], ['pee', 52, {}, 'Dad'], ['poop', 140, { note: 'big one' }, 'Mom'],
    ['feed', 205, { side: 'R', min: 20 }, 'Mom'], ['pee', 215, {}, 'Mom'], ['feed', 390, { side: 'bottle', oz: 2 }, 'Dad'],
    ['pee', 400, {}, 'Dad'], ['poop', 610, {}, 'Mom'], ['feed', 640, { side: 'B', min: 25 }, 'Mom'],
    ['pee', 880, {}, 'Dad'], ['feed', 900, { side: 'L' }, 'Mom'], ['feed', 1500, { side: 'R', min: 10 }, 'Mom'], ['poop', 1560, {}, 'Dad'],
  ];
  cfg = { ...cfg, baby: 'Baby', me: 'Dad', role: 'other', feed: 'breast', token: '' };
  for (const [k, back, extra, by] of rows) {
    const t = now - back * m;
    const id = C.newId(t);
    state.events[id] = { id, k, t, u: t, by, ...extra };
  }
  const ibu = M.newMed({ name: 'Ibuprofen', dose: '600 mg', every: 6 }, 'Mom', now - 2000 * m);
  const ty = M.newMed({ name: 'Tylenol', dose: '1000 mg', every: 6 }, 'Mom', now - 1999 * m);
  const iron = M.newMed({ name: 'Iron', every: 24 }, 'Mom', now - 1998 * m);
  for (const med of [ibu, ty, iron]) meds.events[med.id] = med;
  for (const [med, back, by] of [[ibu, 100, 'Dad'], [ibu, 460, 'Mom'], [ty, 400, 'Mom'], [ty, 800, 'Dad']]) {
    const dose = M.newDose(med, now - back * m, by, now - back * m);
    meds.events[dose.id] = dose;
  }
}

// ── Changing entries ────────────────────────────────────────────────────────────────────────────
function put(e) {
  const saved = C.clean({ ...e, u: Date.now() });
  if (!saved) return null;
  state.events[saved.id] = saved;
  state.dirty[C.bucketOf(saved.id)] = saved.u;
  persist();
  render();
  queueSync(1500);
  return saved;
}

// The same for Mom's medicine.
function putMed(e) {
  const saved = M.cleanMed({ ...e, u: Date.now() });
  if (!saved) return null;
  meds.events[saved.id] = saved;
  meds.dirty[C.bucketOf(saved.id)] = saved.u;
  persist();
  renderMeds();
  queueSync(1500);
  return saved;
}

// ── Taps waiting for Save ───────────────────────────────────────────────────────────────────────
// A tap on Feed, Pee, Poop or Pump logs nothing by itself. It makes a draft: kept on this phone only,
// never counted, never shared. Save turns it into a real entry; Discard throws it away. A draft nobody
// answered is not lost: it waits at the top of the front page, across closing and reopening the app.
//   base: the moment of the tap ("15 min ago" counts back from it).  e: the entry it would become.
let drafts = DEMO ? [] : store.get('bl.drafts', [])
  .map((d) => ({ base: Number(d && d.base), e: C.clean(d && d.e) }))
  .filter((d) => d.e && !d.e.x && Number.isFinite(d.base) && !state.events[d.e.id]);
const draftOf = (id) => drafts.find((d) => d.e.id === id);
function keepDrafts() {
  if (!store.set('bl.drafts', drafts)) toast('This phone is out of storage space. Tap Save now so this one is not lost.');
}
function setDraft(e) {
  const d = draftOf(e.id);
  const c = C.clean({ ...e, u: Date.now() });
  if (!d || !c) return;
  d.e = c;
  keepDrafts();
}
function dropDraft(id) {
  const d = draftOf(id);
  drafts = drafts.filter((x) => x.e.id !== id);
  keepDrafts();
  if (trayId === id) closeTray(); else renderWaiting();
  return d;
}
// The only way a tap becomes an entry.
function saveDraft(id) {
  const d = dropDraft(id);
  if (!d) return null;
  store.set('bl.untimed', '');
  const saved = put(d.e);
  if (!saved) return null;
  flashButton(saved.k);
  toast(`${C.KIND_LABEL[saved.k]} saved · ${C.clock(saved.t)}`, 'Undo', () => { if (state.events[saved.id]) put({ ...state.events[saved.id], x: true }); });
  return saved;
}
function discardDraft(id) {
  const d = dropDraft(id);
  if (!d) return;
  toast(`${C.KIND_LABEL[d.e.k]} not saved.`, 'Bring it back', () => { drafts.push(d); keepDrafts(); renderWaiting(); });
}

function logNow(kind) {
  const now = Date.now();
  const e = C.clean({ id: C.newId(), k: kind, t: now, u: now, by: cfg.me, ...(kind === 'feed' ? C.feedDefaults(cfg) : {}) });
  if (!e) return;
  drafts.push({ base: now, e });
  keepDrafts();
  openTray(e.id);
}

// The drafts not open in the tray right now, each asking for its answer.
function renderWaiting() {
  const box = $('#waiting');
  box.replaceChildren();
  for (const d of drafts) {
    if (d.e.id === trayId) continue;
    const card = el('div', 'waiting');
    card.dataset.id = d.e.id;
    const text = el('p', 'waiting-text');
    const extra = C.detail(d.e);
    text.append(el('strong', '', `Save this ${C.KIND_LABEL[d.e.k].toLowerCase()} from ${C.clock(d.e.t)}?`),
      el('span', '', extra ? `${extra}. It is not in the log yet.` : 'It is not in the log yet.'));
    const save = el('button', 'btn btn-primary', 'Save');
    save.type = 'button';
    save.dataset.waiting = 'save';
    const no = el('button', 'btn', 'No, discard');
    no.type = 'button';
    no.dataset.waiting = 'discard';
    const more = el('button', 'link-btn', 'Add details first');
    more.type = 'button';
    more.dataset.waiting = 'open';
    const actions = el('div', 'waiting-actions');
    actions.append(save, no);
    card.append(text, actions, more);
    box.append(card);
  }
}
$('#waiting').addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-waiting]');
  const card = ev.target.closest('.waiting');
  if (!btn || !card) return;
  const id = card.dataset.id;
  if (btn.dataset.waiting === 'save') saveDraft(id);
  else if (btn.dataset.waiting === 'discard') discardDraft(id);
  else openTray(id);
});

// ── Screen ──────────────────────────────────────────────────────────────────────────────────────
const SINCE = { feed: ['#sinceFeed', '#sinceFeedSub'], pee: ['#sincePee', '#sincePeeSub'], poop: ['#sincePoop', '#sincePoopSub'], pump: ['#sincePump', '#sincePumpSub'] };

function renderSince() {
  const now = Date.now();
  const s = C.summarize(Object.values(state.events), now);
  for (const kind of C.KINDS) {
    const [valueSel, subSel] = SINCE[kind];
    const e = s.last[kind];
    $(valueSel).textContent = e ? C.ago(Math.max(0, now - e.t)) : '–';
    let extra = '';
    if (e && kind === 'feed' && e.side) extra = ` · ${C.SIDE_LABEL[e.side]}`;
    if (e && kind === 'pump' && C.amountText(e)) extra = ` · ${C.amountText(e)}`;
    $(subSel).textContent = e ? `${C.clock(e.t)}${extra}` : 'None yet';
  }
  $('#tally').textContent = C.tally(s.day);
  const drank = C.intakeText(s.drank, unitNow());
  $('#intakeLine').hidden = !drank;
  $('#intake').textContent = drank;
  renderRunning(now);
  const side = C.nextSide(Object.values(state.events), now);
  const line = $('#nextSide');
  line.hidden = !side;
  if (side) {
    line.replaceChildren(
      art('flower'),
      el('span', '', `Last feed started on the ${C.SIDE_LABEL[side.last].toLowerCase()}. `),
      el('strong', '', `Next: start on the ${C.SIDE_LABEL[side.next].toLowerCase()}.`),
    );
  }
}

// The feed or pump still going, with its one Done button. "Don't time it" is remembered per entry.
const RUNNING_WORD = { feed: 'Feeding', pump: 'Pumping' };
function runningNow(now = Date.now()) {
  const e = C.running(Object.values(state.events), now);
  return e && store.get('bl.untimed', '') !== e.id ? e : null;
}
function renderRunning(now = Date.now()) {
  const e = runningNow(now);
  $('#running').hidden = !e;
  if (!e) return;
  $('#runningArt').setAttribute('href', `#i-${e.k}`);
  $('#runningWhat').textContent = RUNNING_WORD[e.k];
  $('#runningDone').textContent = `Done ${RUNNING_WORD[e.k].toLowerCase()}`;
  $('#runningTime').textContent = `${C.minutesSince(e.t, now)} min so far · started ${C.clock(e.t)}`;
}
$('#runningDone').addEventListener('click', () => {
  const e = runningNow();
  if (!e) return;
  const min = C.minutesSince(e.t);
  put({ ...e, min });
  toast(`${C.KIND_LABEL[e.k]} saved as ${min} min.`, 'Undo', () => put({ ...state.events[e.id], min: undefined }));
});
$('#runningStop').addEventListener('click', () => {
  const e = runningNow();
  if (e) store.set('bl.untimed', e.id);
  renderRunning();
});

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

// One of the drawings defined at the top of index.html, by name: feed, pee, poop, flower, baby.
const SVG = 'http://www.w3.org/2000/svg';
function art(name) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'art');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

// History: today in full; each earlier day folds into one line that opens it in a sheet. The page stays
// the same length however old she gets: today's rows plus at most 14 one-liners, older days one tap away.
const FOLD_DAYS = 14;
let showOlder = false;
let dayOpen = null; // the day key open in the day sheet

function rowsFor(items) {
  const list = el('ul', 'rows');
  for (const e of items) {
    const li = el('li');
    const row = el('button', 'row');
    row.type = 'button';
    row.dataset.id = e.id;
    const what = el('span', 'row-what');
    what.append(el('span', 'row-kind', C.KIND_LABEL[e.k]));
    const d = C.detail(e);
    if (d) what.append(el('span', 'row-detail', d));
    const ico = el('span', 'row-ico');
    ico.dataset.kind = e.k;
    ico.append(art(e.k));
    const meta = el('span', 'row-meta');
    meta.append(el('span', 'row-time', C.clock(e.t)), el('span', 'row-by', e.by || ''));
    row.append(ico, what, meta);
    row.setAttribute('aria-label', `${C.KIND_LABEL[e.k]} at ${C.clock(e.t)}${d ? `, ${d}` : ''}. Edit`);
    li.append(row);
    list.append(li);
  }
  return list;
}

function renderLog() {
  const box = $('#log');
  box.replaceChildren();
  const now = Date.now();
  const groups = C.groupByDay(Object.values(state.events), now);
  if (!groups.length) {
    const empty = el('div', 'empty');
    empty.append(art('baby'), el('p', 'empty-title', 'Nothing logged yet'),
      el('p', 'empty-text', 'Tap Feed, Pee or Poop below the moment it happens, then tap Save. It keeps the time of your first tap.'));
    box.append(empty);
    renderDaySheet();
    return;
  }
  const todayKey = C.dayKey(now);
  const today = groups[0].key === todayKey ? groups[0] : null;
  const day = el('section', 'day');
  const head = el('div', 'day-head');
  head.append(el('h3', 'day-name', 'Today'), el('p', 'day-count', today ? C.tally(today.count) : ''));
  day.append(head);
  if (today) {
    const drank = C.intakeText(C.intake(today.items), unitNow());
    if (drank) day.append(el('p', 'day-drank', drank));
    day.append(rowsFor(today.items));
  } else {
    day.append(el('p', 'day-none', 'Nothing yet today. Earlier days are below.'));
  }
  box.append(day);

  const past = groups.filter((g) => g.key !== todayKey);
  if (past.length) {
    const cutoff = C.dayKey(now - FOLD_DAYS * 864e5);
    const shown = showOlder ? past : past.filter((g) => g.key > cutoff);
    const older = past.length - shown.length;
    const sec = el('section', 'days');
    sec.append(el('h3', 'day-name days-title', 'Earlier days'));
    const list = el('ul', 'folds');
    for (const g of shown) {
      const li = el('li');
      const b = el('button', 'fold');
      b.type = 'button';
      b.dataset.day = g.key;
      const words = el('span', 'fold-words');
      const drank = C.intakeText(C.intake(g.items), unitNow());
      words.append(el('span', 'fold-name', g.label), el('span', 'fold-count', C.tally(g.count)));
      if (drank) words.append(el('span', 'fold-drank', drank));
      const go = document.createElementNS(SVG, 'svg');
      go.setAttribute('class', 'line');
      go.setAttribute('viewBox', '0 0 24 24');
      go.setAttribute('aria-hidden', 'true');
      go.innerHTML = '<path d="M9 6l6 6-6 6"/>'; // a fixed arrow, never anything typed or synced
      b.append(words, go);
      b.setAttribute('aria-label', `${g.label}: ${C.tally(g.count)}${drank ? `, ${drank}` : ''}. Open this day`);
      li.append(b);
      list.append(li);
    }
    sec.append(list);
    if (older > 0 || showOlder) {
      const more = el('button', 'btn', showOlder ? 'Show only the last two weeks' : `Show older days (${older})`);
      more.type = 'button';
      more.id = 'foldMore';
      sec.append(more);
    }
    box.append(sec);
  }
  renderDaySheet();
}

// One past day, opened from its folded line. Rows open the same edit sheet as today's.
const daySheet = $('#daySheet');
function openDay(key) {
  dayOpen = key;
  renderDaySheet();
  if (!daySheet.open) daySheet.showModal();
  daySheet.scrollTop = 0;
}
function renderDaySheet() {
  if (!dayOpen || !daySheet) return;
  const g = C.groupByDay(Object.values(state.events)).find((x) => x.key === dayOpen);
  if (!g) { $('#dayRows').replaceChildren(el('p', 'day-none', 'Nothing left on this day.')); $('#dayCount').textContent = ''; $('#dayDrank').hidden = true; return; }
  $('#dayTitle').textContent = g.label;
  $('#dayCount').textContent = C.tally(g.count);
  const drank = C.intakeText(C.intake(g.items), unitNow());
  $('#dayDrank').hidden = !drank;
  $('#dayDrank').textContent = drank;
  $('#dayRows').replaceChildren(rowsFor(g.items));
}
$('#log').addEventListener('click', (ev) => {
  const fold = ev.target.closest('.fold');
  if (fold) { openDay(fold.dataset.day); return; }
  if (ev.target.closest('#foldMore')) { showOlder = !showOlder; renderLog(); }
});
$('#dayRows').addEventListener('click', (ev) => {
  const row = ev.target.closest('.row');
  if (row) openEdit(row.dataset.id);
});
$('#dayClose').addEventListener('click', () => daySheet.close());
daySheet.addEventListener('close', () => { dayOpen = null; $('#dayRows').replaceChildren(); });
daySheet.addEventListener('click', (ev) => { if (ev.target === daySheet) daySheet.close(); });

function renderHeader() {
  const name = cfg.baby.trim();
  $('#babyName').textContent = name || 'Jubilee';
  document.title = name ? `${name} · log` : 'Jubilee';
  const btn = $('#syncBtn');
  btn.dataset.state = syncInfo.state;
  $('#syncText').textContent = syncInfo.text;
  btn.setAttribute('aria-label', cfg.token ? `${syncInfo.text}. Sync now` : syncInfo.text);

  const notice = $('#notice');
  if (syncInfo.state === 'error' && syncInfo.detail) {
    notice.textContent = syncInfo.detail;
    notice.hidden = false;
  } else if (!cfg.token && !DEMO && Object.keys(state.events).length >= 3 && !store.get('bl.hideLocalNote', false)) {
    notice.replaceChildren('Entries are saved on this phone only. ');
    const open = el('button', 'link-btn', 'Share with another phone');
    open.type = 'button';
    open.addEventListener('click', () => showGuide('connect'));
    notice.append(open);
    notice.hidden = false;
  } else {
    notice.hidden = true;
  }
}

// "Share with the other phone": there on a connected phone until someone else has logged something.
function renderInvite() {
  const show = FORCE === 'invite'
    || (!!cfg.token && !DEMO && !store.get('bl.hideInvite', false) && !C.othersHaveLogged(Object.values(state.events), cfg.me));
  $('#invite').hidden = !show;
  const other = C.ROLES[cfg.role]?.other;
  $('#inviteTitle').textContent = `Share Jubilee with ${other || 'the other phone'}`;
}

function render() {
  renderHeader();
  renderInvite();
  renderSince();
  renderMeds();
  renderLog();
  renderWaiting();
}

function flashButton(kind) {
  const btn = document.querySelector(`.act[data-log="${kind}"]`);
  const label = btn.querySelector('.act-label');
  btn.classList.add('is-logged');
  label.textContent = 'Saved';
  setTimeout(() => { btn.classList.remove('is-logged'); label.textContent = C.KIND_LABEL[kind] || 'Meds'; }, 1100);
}

// ── Toast ───────────────────────────────────────────────────────────────────────────────────────
let toastTimer = null;
function toast(text, actionLabel, action) {
  clearTimeout(toastTimer);
  $('#toastText').textContent = text;
  const btn = $('#toastAction');
  btn.hidden = !actionLabel;
  btn.textContent = actionLabel || '';
  btn.onclick = action ? () => { hideToast(); action(); } : null;
  $('#toast').hidden = false;
  toastTimer = setTimeout(hideToast, actionLabel ? 6000 : 4000);
}
function hideToast() { clearTimeout(toastTimer); $('#toast').hidden = true; }

// ── Tray: what a tap opens. Save or Discard; the extras in between are optional ────────────────
let trayId = null;
let trayBase = 0; // the moment of the tap; "15 min ago" counts back from here

// The tray never closes by itself: an unanswered tap would otherwise vanish without a word.
function openTray(id) {
  const d = draftOf(id);
  if (!d) return;
  hideToast();
  trayId = id;
  trayBase = d.base;
  paintTray();
  $('#tray').hidden = false;
  renderWaiting();
}
function closeTray() { trayId = null; $('#tray').hidden = true; renderWaiting(); }

function paintTray() {
  const e = draftOf(trayId)?.e;
  if (!e) return closeTray();
  $('#trayTitle').textContent = `${C.KIND_LABEL[e.k]} · ${C.clock(e.t)}`;
  $('#trayWhat').textContent = C.detail(e);
  $('#traySave').textContent = `Save ${C.KIND_LABEL[e.k].toLowerCase()}`;
  const back = Math.round((trayBase - e.t) / 60e3);
  for (const chip of document.querySelectorAll('#trayWhen .chip')) chip.setAttribute('aria-pressed', String(Number(chip.dataset.back) === back));
  $('#traySide').hidden = e.k !== 'feed';
  for (const chip of document.querySelectorAll('#traySide .chip')) chip.setAttribute('aria-pressed', String(chip.dataset.side === e.side));
  // "How much" only where it means something: a pump, or a bottle feed
  $('#trayAmount').hidden = !C.hasAmount(e);
  $('#trayAmountLabel').textContent = e.k === 'pump' ? 'How much did you get' : 'How much did she drink';
  const unit = unitNow();
  const entered = C.amountUnit(e);
  $('#trayMilk').hidden = e.k !== 'feed';
  $('#trayDonor').setAttribute('aria-pressed', String(!!e.donor));
  for (const chip of document.querySelectorAll('#trayAmount .chip[data-unit]')) chip.setAttribute('aria-pressed', String(chip.dataset.unit === unit));
  for (const box of document.querySelectorAll('#trayAmount [data-for-unit]')) box.hidden = box.dataset.forUnit !== unit;
  for (const chip of document.querySelectorAll('#trayAmount .chip[data-oz]')) chip.setAttribute('aria-pressed', String(entered === 'oz' && Number(chip.dataset.oz) === e.oz));
  for (const chip of document.querySelectorAll('#trayAmount .chip[data-ml]')) chip.setAttribute('aria-pressed', String(entered === 'ml' && Number(chip.dataset.ml) === e.ml));
  for (const out of document.querySelectorAll('#trayAmount .stepper-value')) out.textContent = C.amountText(e) || 'Not set';
  return undefined;
}

$('#tray').addEventListener('click', (ev) => {
  const chip = ev.target.closest('.chip');
  const e = draftOf(trayId)?.e;
  if (!chip || !e) return;
  const put = setDraft; // in here every change goes to the draft, never to the log
  if (chip.dataset.back !== undefined) put({ ...e, t: trayBase - Number(chip.dataset.back) * 60e3 });
  else if (chip.dataset.side) {
    const side = e.side === chip.dataset.side ? undefined : chip.dataset.side;
    put(side === 'bottle' ? { ...e, side } : C.withAmount({ ...e, side }, '', 0)); // an amount belongs to a bottle
  } else if (chip.id === 'trayDonor') put({ ...e, donor: !e.donor });
  else if (chip.dataset.unit) { // oz or mL: this phone remembers it; the amount already saved is left as it was entered
    cfg = { ...cfg, unit: chip.dataset.unit };
    store.set('bl.cfg', cfg);
    render(); // the totals follow the unit
  } else if (chip.dataset.oz) {
    const n = Number(chip.dataset.oz);
    put(C.withAmount(e, 'oz', C.amountUnit(e) === 'oz' && e.oz === n ? 0 : n)); // the same amount again clears it
  } else if (chip.dataset.ml) {
    const n = Number(chip.dataset.ml);
    put(C.withAmount(e, 'ml', C.amountUnit(e) === 'ml' && e.ml === n ? 0 : n));
  } else if (chip.dataset.step) put(C.withAmount(e, 'oz', C.stepOz(C.amountIn(e, 'oz'), Number(chip.dataset.step))));
  else if (chip.dataset.stepMl) put(C.withAmount(e, 'ml', C.stepMl(C.amountIn(e, 'ml'), Number(chip.dataset.stepMl))));
  paintTray();
});
$('#traySave').addEventListener('click', () => saveDraft(trayId));
$('#trayDiscard').addEventListener('click', () => discardDraft(trayId));
// a note or an exact time is typed on the edit sheet, which works on real entries: so save it first
$('#trayMore').addEventListener('click', () => { const saved = saveDraft(trayId); if (saved) { hideToast(); openEdit(saved.id); } });
$('#trayDone').addEventListener('click', closeTray); // "Not now": it waits on the front page

// ── Edit sheet ──────────────────────────────────────────────────────────────────────────────────
let editId = null;
let deleteArmed = null;
const editSheet = $('#editSheet');

function setSideBoxes(side) {
  for (const box of document.querySelectorAll('#editForm input[name="side"]')) box.checked = box.value === side;
}
function showFeedFields() {
  const kind = $('#editForm').elements.kind.value;
  $('#feedFields').hidden = kind !== 'feed' && kind !== 'pump';
  $('#editSide').hidden = kind !== 'feed';
  const bottle = document.querySelector('#editForm input[name="side"][value="bottle"]').checked;
  $('#editMilk').hidden = kind !== 'feed' || !bottle; // donor milk only comes in a bottle
}

function openEdit(id) {
  const e = state.events[id];
  if (!e || e.x) return;
  closeTray();
  editId = id;
  $('#editForm').elements.kind.value = e.k;
  $('#editWhen').value = C.toLocalInput(e.t);
  $('#editWhenError').hidden = true;
  setSideBoxes(e.side);
  $('#editForm').elements.donor.checked = !!e.donor;
  $('#editMin').value = e.min || '';
  const editUnit = C.amountUnit(e) || unitNow(); // an amount opens in the unit it was entered in
  $('#editForm').elements.unit.value = editUnit;
  $('#editAmount').value = C.amountIn(e, editUnit) || '';
  paintEditUnit();
  $('#editNote').value = e.note || '';
  disarmDelete();
  showFeedFields();
  editSheet.showModal();
}

// The amount box takes whole mL, or ounces down to a quarter.
function paintEditUnit() {
  const ml = $('#editForm').elements.unit.value === 'ml';
  const box = $('#editAmount');
  box.step = ml ? '1' : '0.25';
  box.max = ml ? String(C.ML_MAX) : '99';
  box.inputMode = ml ? 'numeric' : 'decimal';
}

$('#editForm').addEventListener('change', (ev) => {
  if (ev.target.name === 'kind') showFeedFields();
  if (ev.target.name === 'unit') paintEditUnit(); // the number typed stays; only what it is measured in changes
  if (ev.target.name === 'side' && ev.target.checked) setSideBoxes(ev.target.value); // one side at most
  if (ev.target.name === 'side') showFeedFields();
});

$('#editForm').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const e = state.events[editId];
  if (!e) return editSheet.close();
  const when = C.fromLocalInput($('#editWhen').value);
  if (when === null) {
    $('#editWhenError').hidden = false;
    $('#editWhen').focus();
    return undefined;
  }
  const kind = $('#editForm').elements.kind.value;
  const side = document.querySelector('#editForm input[name="side"]:checked');
  // keep the tapped second unless the minute was actually changed
  const t = C.toLocalInput(e.t) === $('#editWhen').value ? e.t : when;
  const timed = kind === 'feed' || kind === 'pump';
  put(C.withAmount({
    id: e.id, by: e.by, k: kind, t,
    side: kind === 'feed' && side ? side.value : undefined,
    donor: $('#editForm').elements.donor.checked, // kept only on a bottle feed
    min: timed ? Number($('#editMin').value) : undefined,
    note: $('#editNote').value,
  }, $('#editForm').elements.unit.value, timed ? $('#editAmount').value : 0));
  editSheet.close();
  toast('Entry saved.');
  return undefined;
});

$('#editCancel').addEventListener('click', () => editSheet.close());

function disarmDelete() {
  clearTimeout(deleteArmed);
  deleteArmed = null;
  const btn = $('#editDelete');
  btn.classList.remove('is-armed');
  btn.textContent = 'Delete this entry';
}
$('#editDelete').addEventListener('click', () => {
  const btn = $('#editDelete');
  if (!deleteArmed) {
    btn.classList.add('is-armed');
    btn.textContent = 'Tap again to delete it';
    deleteArmed = setTimeout(disarmDelete, 4000);
    return;
  }
  const e = state.events[editId];
  disarmDelete();
  editSheet.close();
  if (!e) return;
  put({ ...e, x: true });
  toast(`${C.KIND_LABEL[e.k]} at ${C.clock(e.t)} deleted.`, 'Undo', () => put({ ...e, x: false }));
});

$('#log').addEventListener('click', (ev) => {
  const row = ev.target.closest('.row');
  if (row) openEdit(row.dataset.id);
});

// ── Mom's meds ──────────────────────────────────────────────────────────────────────────────────
const doseSheet = $('#doseSheet');
const medSheet = $('#medSheet');
const MARK = {
  ok: '<svg class="line" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.500l4.500 4.500L19 7.500"/></svg>',
  wait: '<svg class="line" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.500"/><path d="M12 7.500V12l3 2"/></svg>',
};
const medStatusOf = (id, now = Date.now()) => M.medStatus(Object.values(meds.events), now).find((x) => x.med.id === id);

// The list lives in the Meds sheet. Ready now (never taken, as needed, or its time has come) sits open at the
// top; what is still inside its interval folds into one line. The Meds button wears a small dot while any is ready.
const medsSheet = $('#medsSheet');
const manageSheet = $('#medManageSheet');
const medsBtn = $('#medsBtn');
let fromMeds = false;     // true while she is inside the Meds flow; closing a sub-sheet then lands back on the list
let notYetOpen = false;   // the fold stays as she left it while the list redraws
let pendingNote = null;   // a line for the top of the list after returning from add / change / remove

const readyWords = (n) => (n === 1 ? 'one' : String(n));

function medCard(s, now) {
  const words = M.statusText(s, now);
  const li = el('li', 'med');
  li.dataset.id = s.med.id;
  li.dataset.ok = String(!!s.last && s.ok);
  const body = el('div', 'med-open');
  const name = el('span', 'med-name', s.med.name);
  if (s.med.dose) name.append(' ', el('small', '', s.med.dose));
  const head = el('span', 'med-head');
  if (s.last) head.innerHTML = s.ok ? MARK.ok : MARK.wait; // fixed drawings only, never anything typed or synced
  head.append(words.head);
  body.append(name, head, el('span', 'med-sub', words.sub));
  const took = el('button', 'btn btn-primary med-took', 'Took it');
  took.type = 'button';
  took.dataset.med = 'took';
  took.setAttribute('aria-label', `Mom took ${s.med.name}`);
  li.append(body, took);
  return li;
}
const medUl = (items, now) => {
  const ul = el('ul', 'med-list');
  ul.append(...items.map((s) => medCard(s, now)));
  return ul;
};

function paintMedList(list, now) {
  const box = $('#medList');
  const next = document.createElement('div');
  if (!list.length) {
    const empty = el('div', 'meds-empty');
    empty.append(el('strong', '', 'Keep track of Mom\'s medicine here'),
      'Add each one once. Then tap Took it whenever she takes one, and both phones show when it is OK again.');
    const add = el('button', 'btn btn-primary', 'Add her first medicine');
    add.type = 'button';
    add.id = 'medFirst';
    empty.append(add);
    next.append(empty);
  } else {
    const ready = list.filter((s) => s.ok);
    const wait = list.filter((s) => !s.ok);
    if (ready.length && wait.length) next.append(el('h3', 'eyebrow', 'Ready now'));
    if (ready.length) next.append(medUl(ready, now));
    else next.append(el('p', 'field-help', 'Nothing is ready right now.'));
    if (wait.length) {
      const soonest = Math.min(...wait.map((s) => s.nextAt));
      const fold = el('details', 'med-fold');
      fold.id = 'medFold';
      fold.open = notYetOpen;
      const sum = el('summary');
      sum.append(el('span', '', `${wait.length} not yet · next at ${C.clock(soonest)}`));
      const chev = document.createElementNS(SVG, 'svg');
      chev.setAttribute('class', 'line');
      chev.setAttribute('viewBox', '0 0 24 24');
      chev.setAttribute('aria-hidden', 'true');
      chev.innerHTML = '<path d="M6 9l6 6 6-6"/>'; // a fixed arrow, never anything typed or synced
      sum.append(chev);
      fold.append(sum, medUl(wait, now));
      fold.addEventListener('toggle', () => { notYetOpen = fold.open; });
      next.append(fold);
    }
  }
  $('#medsEdit').hidden = !list.length;
  if (next.innerHTML === box.dataset.sig && box.firstChild) return; // nothing changed: leave focus and the fold alone
  const a = document.activeElement;
  const was = a && box.contains(a) ? (a.closest('summary') ? 'summary' : a.id || `${a.closest('.med')?.dataset.id}`) : null;
  box.dataset.sig = next.innerHTML;
  box.replaceChildren(...next.childNodes);
  if (was) {
    const back = was === 'summary' ? box.querySelector('summary') : (document.getElementById(was) || box.querySelector(`.med[data-id="${was}"] [data-med="took"]`));
    if (back) back.focus({ preventScroll: true });
  }
}

// As-needed medicines (every 0) sit under Ready now but never light the dot: they are always ready, so a dot
// for them would never go away and would stop meaning anything (Jason, Olórin chat Tg 29581).
function paintMedDot(list) {
  const ready = list.filter((s) => s.ok && s.med.every > 0).length;
  $('#medsDot').hidden = !ready;
  medsBtn.setAttribute('aria-label', ready ? `Meds, ${readyWords(ready)} ready` : 'Meds');
}

function renderMeds() {
  const now = Date.now();
  const list = M.medStatus(Object.values(meds.events), now);
  paintMedDot(list);
  if (medsSheet.open) paintMedList(list, now);
}

let shownNote = null;
function showMedsNote() {
  const note = $('#medsNote');
  shownNote = pendingNote;
  note.hidden = !pendingNote;
  if (!pendingNote) return;
  $('#medsNoteText').textContent = pendingNote.text;
  $('#medsNoteUndo').hidden = !pendingNote.undo;
}
$('#medsNoteUndo').addEventListener('click', () => {
  const n = shownNote;
  pendingNote = null;
  showMedsNote();
  if (n && n.undo) n.undo();
});
// A line about what just changed. Inside the Meds flow it sits at the top of the list (a toast would hide behind the sheet).
function medSay(text, undo) {
  if (fromMeds) pendingNote = { text, undo };
  else toast(text, undo ? 'Undo' : undefined, undo);
}

function openMeds(keep = false) {
  for (const sheet of document.querySelectorAll('dialog[open]')) sheet.close();
  hideToast();
  fromMeds = true;
  if (!keep) { notYetOpen = false; pendingNote = null; }
  $('#medList').dataset.sig = '';
  medsSheet.showModal();
  renderMeds();
  showMedsNote();
  pendingNote = null;
  medsSheet.scrollTop = 0;
}
// A sheet in the Meds flow closed. Nothing else open: back to the list, or, from the list itself, back to the Meds button.
function afterMedsClose(sheet) {
  if (document.querySelector('dialog[open]')) return;
  if (fromMeds && sheet !== medsSheet) { openMeds(true); return; }
  fromMeds = false;
  medsBtn.focus({ preventScroll: true });
}
// Closing from a button moves on at once; the browser's own close event (Esc, a tap outside) does the same, and is a no-op when already done.
function closeSheet(sheet) { sheet.close(); afterMedsClose(sheet); }
for (const sheet of [medsSheet, manageSheet, doseSheet, medSheet]) sheet.addEventListener('close', () => afterMedsClose(sheet));
for (const sheet of [medsSheet, manageSheet]) sheet.addEventListener('click', (ev) => { if (ev.target === sheet) closeSheet(sheet); });
$('#medsDone').addEventListener('click', () => closeSheet(medsSheet));
$('#medList').addEventListener('click', (ev) => {
  if (ev.target.closest('#medFirst')) { openMed(null); return; }
  const btn = ev.target.closest('[data-med="took"]');
  const card = ev.target.closest('.med');
  if (btn && card) openDose(card.dataset.id);
});

// Edit my medicines: one row each, and the way to add one.
function openManage() {
  const list = M.medStatus(Object.values(meds.events));
  $('#medManageList').replaceChildren(...list.map((s) => {
    const li = el('li');
    const b = el('button', 'pick');
    b.type = 'button';
    b.dataset.edit = s.med.id;
    const name = el('span', 'pick-name', s.med.name);
    if (s.med.dose) name.append(' ', el('small', '', s.med.dose));
    const text = el('span');
    text.append(name, el('span', 'pick-status', M.everyText(s.med.every)));
    const go = document.createElementNS(SVG, 'svg');
    go.setAttribute('class', 'line');
    go.setAttribute('viewBox', '0 0 24 24');
    go.setAttribute('aria-hidden', 'true');
    go.innerHTML = '<path d="M9 6l6 6-6 6"/>'; // a fixed arrow, never anything typed or synced
    b.append(text, go);
    b.setAttribute('aria-label', `${M.medLabel(s.med)}. ${M.everyText(s.med.every)}. Change it or remove it`);
    li.append(b);
    return li;
  }));
  for (const sheet of document.querySelectorAll('dialog[open]')) sheet.close();
  hideToast();
  manageSheet.showModal();
  manageSheet.scrollTop = 0;
}
$('#medsEdit').addEventListener('click', openManage);
$('#medManageList').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-edit]');
  if (b) openMed(b.dataset.edit);
});
$('#medManageAdd').addEventListener('click', () => openMed(null));
$('#medManageDone').addEventListener('click', () => closeSheet(manageSheet));

// "Took it": pick when, then Save. Nothing is logged before Save.
let doseMed = null;
let doseBase = 0; // the moment the sheet opened; "15 min ago" counts back from it
function openDose(id) {
  const med = meds.events[id];
  if (!med || med.x) return;
  for (const sheet of document.querySelectorAll('dialog[open]')) sheet.close();
  hideToast();
  doseMed = id;
  doseBase = Date.now();
  $('#doseTitle').textContent = med.name;
  $('#doseSub').textContent = [med.dose, M.everyText(med.every)].filter(Boolean).join(' · ');
  $('#doseForm').elements.back.value = '0';
  $('#doseWhen').value = C.toLocalInput(doseBase);
  $('#doseWhen').max = C.toLocalInput(doseBase + 60e3);
  $('#doseWhenError').hidden = true;
  paintDose();
  doseSheet.showModal();
}
function doseTime() {
  const typed = C.fromLocalInput($('#doseWhen').value);
  if (typed === null) return null;
  // the exact minute typed, or the moment the sheet opened when nobody changed it
  return C.toLocalInput(typed) === C.toLocalInput(doseBase) ? doseBase : typed;
}
function paintDose() {
  const t = doseTime();
  const warn = t === null ? '' : M.earlyWarning(medStatusOf(doseMed), t);
  const box = $('#doseWarn');
  box.hidden = !warn;
  if (warn) box.replaceChildren(el('strong', '', 'Earlier than her schedule'), warn);
  $('#doseSave').textContent = warn ? 'Save anyway' : 'Save';
}
$('#doseForm').addEventListener('change', (ev) => {
  if (ev.target.name === 'back') $('#doseWhen').value = C.toLocalInput(doseBase - Number(ev.target.value) * 60e3);
  if (ev.target.name === 'when') for (const r of $('#doseForm').elements.back) r.checked = false;
  $('#doseWhenError').hidden = true;
  paintDose();
});
$('#doseWhen').addEventListener('input', paintDose);
$('#doseForm').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const med = meds.events[doseMed];
  if (!med || med.x) return doseSheet.close();
  const t = doseTime();
  if (t === null || t > Date.now() + 60e3) {
    $('#doseWhenError').hidden = false;
    $('#doseWhen').focus();
    return undefined;
  }
  const saved = putMed(M.newDose(med, t, cfg.me));
  fromMeds = false; // saved: the whole Meds flow is done, back on the front screen with the button's flash and Undo
  closeSheet(doseSheet);
  if (!saved) return undefined;
  flashButton('meds');
  const s = medStatusOf(med.id);
  const next = s && s.nextAt && s.last && s.last.id === saved.id ? `. OK again ${C.clock(s.nextAt)}` : '';
  toast(`${med.name} saved · ${C.clock(saved.t)}${next}`, 'Undo', () => { if (meds.events[saved.id]) putMed({ ...meds.events[saved.id], x: true }); });
  return undefined;
});
$('#doseCancel').addEventListener('click', () => closeSheet(doseSheet));

// The big Meds button opens her list.
function medsButton() { openMeds(false); }

// Add a medicine, or change one and see her doses of it.
let medId = null;
let medPreset = '';
let removeArmed = null;
let doseArmed = null;
function openMed(id) {
  const med = id ? meds.events[id] : null;
  if (id && (!med || med.x)) return;
  for (const sheet of document.querySelectorAll('dialog[open]')) sheet.close();
  medId = id;
  medPreset = '';
  const form = $('#medForm');
  $('#medTitle').textContent = med ? med.name : 'Add a medicine';
  $('#medSave').textContent = med ? 'Save changes' : 'Add it';
  $('#medPresets').hidden = !!med;
  $('#medName').value = med ? med.name : '';
  $('#medDose').value = med && med.dose ? med.dose : '';
  for (const r of form.elements.every) r.checked = !!med && Number(r.value) === med.every;
  $('#medNameError').hidden = true;
  $('#medEveryError').hidden = true;
  paintPresets();
  $('#medHistory').hidden = !med;
  disarmRemove();
  if (med) paintDoses();
  medSheet.showModal();
  medSheet.scrollTop = 0;
}
function paintPresets() {
  $('#medPresetRow').replaceChildren(...M.PRESETS.map((name) => {
    const b = el('button', 'btn', name);
    b.type = 'button';
    b.dataset.preset = name;
    b.setAttribute('aria-pressed', String(medPreset === name));
    return b;
  }));
}
$('#medPresetRow').addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-preset]');
  if (!b) return;
  medPreset = b.dataset.preset;
  $('#medName').value = medPreset;
  $('#medNameError').hidden = true;
  paintPresets();
  $('#medDose').focus();
});
$('#medName').addEventListener('input', () => { if (medPreset && $('#medName').value !== medPreset) { medPreset = ''; paintPresets(); } });

function paintDoses() {
  const list = $('#medDoses');
  const doses = M.dosesOf(Object.values(meds.events), medId).slice(0, 30);
  list.replaceChildren();
  if (!doses.length) { list.append(el('li', 'dose-none', 'None yet. Tap Took it on the front page when she takes one.')); return; }
  for (const d of doses) {
    const li = el('li', 'dose-row');
    const words = el('span');
    words.append(`${C.dayLabel(d.t)}, ${C.clock(d.t)}`, el('small', '', [d.dose, d.by ? `logged by ${d.by}` : ''].filter(Boolean).join(' · ')));
    const del = el('button', 'btn', 'Delete');
    del.type = 'button';
    del.dataset.dose = d.id;
    del.setAttribute('aria-label', `Delete the dose at ${C.clock(d.t)}`);
    li.append(words, del);
    list.append(li);
  }
}
$('#medDoses').addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-dose]');
  if (!btn) return;
  const d = meds.events[btn.dataset.dose];
  if (!d) return;
  if (doseArmed !== d.id) { // first tap arms it; a second tap within 4 seconds deletes
    paintDoses();
    const again = document.querySelector(`#medDoses [data-dose="${d.id}"]`);
    again.classList.add('is-armed');
    again.textContent = 'Tap again';
    doseArmed = d.id;
    setTimeout(() => { if (doseArmed === d.id) { doseArmed = null; if (medSheet.open) paintDoses(); } }, 4000);
    return;
  }
  doseArmed = null;
  putMed({ ...d, x: true });
  paintDoses();
  toast(`${d.name} at ${C.clock(d.t)} deleted.`, 'Undo', () => { putMed({ ...d, x: false }); if (medSheet.open) paintDoses(); });
});

$('#medForm').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const form = $('#medForm');
  const name = $('#medName').value.trim();
  const picked = form.elements.every.value;
  $('#medNameError').hidden = !!name;
  $('#medEveryError').hidden = picked !== '';
  if (!name) { $('#medName').focus(); return; }
  if (picked === '') { form.elements.every[0].focus(); return; }
  const fields = { name, dose: $('#medDose').value, every: Number(picked) };
  const cur = medId ? meds.events[medId] : null;
  const saved = cur ? putMed({ ...cur, ...fields }) : putMed(M.newMed(fields, cfg.me));
  if (saved) medSay(cur ? `${saved.name} saved.` : `${saved.name} added. Tap Took it when she takes one.`);
  closeSheet(medSheet);
});
$('#medCancel').addEventListener('click', () => closeSheet(medSheet));

function disarmRemove() {
  clearTimeout(removeArmed);
  removeArmed = null;
  const btn = $('#medRemove');
  btn.classList.remove('is-armed');
  btn.textContent = 'Remove this medicine';
}
$('#medRemove').addEventListener('click', () => {
  const btn = $('#medRemove');
  if (!removeArmed) {
    btn.classList.add('is-armed');
    btn.textContent = 'Tap again to remove it';
    removeArmed = setTimeout(disarmRemove, 4000);
    return;
  }
  const med = meds.events[medId];
  disarmRemove();
  if (med) {
    putMed({ ...med, x: true });
    medSay(`${med.name} removed.`, () => putMed({ ...med, x: false }));
  }
  closeSheet(medSheet);
});

// ── Settings sheet ──────────────────────────────────────────────────────────────────────────────
const settingsSheet = $('#settingsSheet');

function openSettings() {
  const form = $('#settingsForm');
  $('#setBaby').value = cfg.baby;
  $('#setMe').value = cfg.role === 'other' || !cfg.role ? cfg.me : '';
  for (const r of form.elements.who) r.checked = r.value === cfg.role;
  for (const r of form.elements.feedkind) r.checked = r.value === (cfg.feed || 'breast');
  $('#setMeField').hidden = cfg.role !== 'other';
  $('#setToken').value = cfg.token;
  $('#setRepo').value = cfg.repo;
  $('#setTokenError').hidden = true;
  $('#setAdv').open = false;
  $('#setShare').hidden = !cfg.token;
  $('#setStatus').textContent = cfg.token
    ? `Sharing is on. ${syncInfo.state === 'error' ? syncInfo.detail || syncInfo.text : 'Both phones see the same log.'}`
    : 'Sharing is off. Entries stay on this phone. To join a shared log, tap the invite link you were texted.';
  settingsSheet.showModal();
}

// Picking Mom or Dad sets the usual kind of feed with it; either can still be changed below.
$('#settingsForm').addEventListener('change', (ev) => {
  if (ev.target.name !== 'who') return;
  const form = $('#settingsForm');
  $('#setMeField').hidden = ev.target.value !== 'other';
  const usual = C.ROLES[ev.target.value]?.feed;
  if (usual) for (const r of form.elements.feedkind) r.checked = r.value === usual;
});

$('#settingsForm').addEventListener('submit', (ev) => {
  ev.preventDefault();
  let repo = $('#setRepo').value.trim() || DEFAULT_REPO;
  const err = $('#setTokenError');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    err.textContent = 'The log location should look like owner/name, for example JamRaid36/babylog-data.';
    err.hidden = false;
    $('#setAdv').open = true;
    $('#setRepo').focus();
    return;
  }
  let token = $('#setToken').value.trim();
  let linkBaby = '';
  let linkRepo = '';
  if (token.includes('#s=') || /^https?:/i.test(token)) { // a setup link pasted where the key goes
    const setup = C.decodeSetup((token.split('#s=')[1] || '').trim());
    if (!setup) {
      err.textContent = 'That setup link is not readable. Ask the other phone to send a fresh one.';
      err.hidden = false;
      $('#setAdv').open = true;
      $('#setToken').focus();
      return;
    }
    token = setup.t; linkRepo = setup.r; linkBaby = setup.b;
  }
  if (linkRepo) repo = linkRepo;
  const sharingChanged = token !== cfg.token || repo !== cfg.repo;
  const form = $('#settingsForm');
  const role = form.elements.who.value || cfg.role;
  const me = C.ROLES[role] ? C.ROLES[role].me : $('#setMe').value.trim();
  cfg = { ...cfg, baby: $('#setBaby').value.trim() || linkBaby, role, me, feed: form.elements.feedkind.value || cfg.feed, token, repo };
  store.set('bl.cfg', cfg);
  keepSetupInAddress();
  if (sharingChanged) {
    // a different log: forget the file versions and offer everything on this phone to it
    state.shas = {};
    for (const e of Object.values(state.events)) state.dirty[C.bucketOf(e.id)] = Date.now();
    meds.shas = {};
    for (const e of Object.values(meds.events)) meds.dirty[C.bucketOf(e.id)] = Date.now();
    persist();
  }
  settingsSheet.close();
  setSync(token ? 'syncing' : 'local');
  render();
  toast('Settings saved.');
  if (token) queueSync(0);
});
$('#setCancel').addEventListener('click', () => settingsSheet.close());

// The invite: one link that carries the shared log's settings after the #, so the other phone sets itself up.
function inviteLink() {
  return `${APP_URL}#s=${C.encodeSetup({ t: cfg.token, r: cfg.repo, b: cfg.baby })}`;
}
async function sendInvite() {
  const link = inviteLink();
  try {
    if (navigator.share) {
      await navigator.share({ title: 'Jubilee', text: 'Tap this to set up Jubilee, our baby log. It walks you through it.', url: link });
    } else {
      const ok = await copyText(link);
      toast(ok ? 'Invite link copied. Text it to the other phone.' : 'Could not copy the link from this browser.');
    }
  } catch (err) {
    if (err && err.name !== 'AbortError') toast('Could not share the link from this browser.');
  }
}
$('#setShare').addEventListener('click', sendInvite);
$('#inviteSend').addEventListener('click', sendInvite);
$('#inviteHide').addEventListener('click', () => { store.set('bl.hideInvite', true); $('#invite').hidden = true; });

$('#setExport').addEventListener('click', () => {
  const blob = new Blob([C.toCsv(Object.values(state.events))], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `baby-log-${C.dayKey(Date.now())}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});

$('#gearBtn').addEventListener('click', openSettings);
// Not connected yet: the words under the name are the way back to the Connect screen, however it was left.
$('#syncBtn').addEventListener('click', () => (cfg.token ? queueSync(0, true) : showGuide('connect')));

// ── Home Screen steps: read them here, or copy them into a text ────────────────────────────────
const APP_URL = `${location.origin}${location.pathname.replace(/index\.html$/, '')}`;
$('#installSteps').replaceChildren(...C.installSteps(APP_URL).map((s) => el('li', '', s)));

async function copyText(text) {
  // First the old way, through a throwaway text box: it answers at once, inside the tap, on every phone.
  const box = document.createElement('textarea');
  box.value = text;
  box.setAttribute('readonly', '');
  box.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px';
  document.body.append(box);
  box.select();
  box.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  box.remove();
  if (ok) return true;
  // Then the newer way, but never wait on it forever: a browser can leave the request hanging.
  if (!navigator.clipboard) return false;
  const gaveUp = new Promise((resolve) => { setTimeout(() => resolve(false), 1500); });
  return Promise.race([navigator.clipboard.writeText(text).then(() => true, () => false), gaveUp]);
}

$('#installCopy').addEventListener('click', async () => {
  const ok = await copyText(C.installText(APP_URL));
  toast(ok ? 'Steps copied. Paste them into a text.' : 'Could not copy. Press and hold the steps to copy them.');
  $('#installCopy').focus();
});

function showInstallSteps() {
  for (const sheet of document.querySelectorAll('dialog[open]')) sheet.close();
  const box = $('#install');
  box.open = true;
  box.scrollIntoView({ block: 'start', behavior: 'smooth' });
  box.querySelector('summary').focus({ preventScroll: true });
}

// ── Welcome, help, and the Home Screen nudge ───────────────────────────────────────────────────
const helpSheet = $('#helpSheet');
const welcomeSheet = $('#welcomeSheet');
const FORCE = new URLSearchParams(location.search).get('show'); // ?show=nudge | invite | guide-<step>, for checks and screenshots
const AS = new URLSearchParams(location.search).get('as');      // ?as=safari | home: behave like an iPhone in Safari / on the Home Screen, for checks
const IS_IPHONE = AS ? true : /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const ON_HOME_SCREEN = AS ? AS === 'home' : navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

function openHelp() {
  for (const sheet of document.querySelectorAll('dialog[open]')) sheet.close();
  helpSheet.showModal();
  helpSheet.scrollTop = 0;
}
// The ? button and "How this works" open the four short tips; the whole manual is one tap further ("Show me more").
function openTips() {
  for (const sheet of document.querySelectorAll('dialog[open]')) sheet.close();
  welcomeSheet.showModal();
  welcomeSheet.scrollTop = 0;
}
$('#helpBtn').addEventListener('click', openTips);
$('#setHelp').addEventListener('click', openTips);
$('#helpBasics').addEventListener('click', openTips);
$('#helpClose').addEventListener('click', () => helpSheet.close());
$('#helpInstall').addEventListener('click', showInstallSteps);

function closeWelcome() { store.set('bl.seenWelcome', true); welcomeSheet.close(); }
$('#welcomeOk').addEventListener('click', closeWelcome);
$('#welcomeMore').addEventListener('click', () => { closeWelcome(); openHelp(); });
welcomeSheet.addEventListener('close', () => store.set('bl.seenWelcome', true));

// The small reminder left behind when someone said "not now" to putting it on the Home Screen.
function renderNudge() {
  const show = FORCE === 'nudge' || (IS_IPHONE && !ON_HOME_SCREEN && !DEMO && !store.get('bl.hideNudge', false) && !guide.open);
  $('#nudge').hidden = !show;
}
$('#nudgeShow').addEventListener('click', () => (IS_IPHONE ? showGuide('install') : showInstallSteps()));

// ── The first-run guide: one screen at a time, nothing to read up on beforehand ───────────────
const guide = $('#guide');

// The little pictures beside each Home Screen step.
const LINE = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
const PICS = {
  menu: `<svg ${LINE}><path d="M5 7.500h14M5 12h14M5 16.500h8.500"/></svg>`,
  share: `<svg ${LINE}><path d="M12 15V3.500M8 7l4-4 4 4M7.500 10.500H6a1.500 1.500 0 0 0-1.500 1.500v7.500A1.500 1.500 0 0 0 6 21h12a1.500 1.500 0 0 0 1.500-1.500V12a1.500 1.500 0 0 0-1.500-1.500h-1.500"/></svg>`,
  plus: `<svg ${LINE}><rect x="3.500" y="3.500" width="17" height="17" rx="4"/><path d="M12 8v8M8 12h8"/></svg>`,
  toggle: `<svg ${LINE}><rect x="2.500" y="7" width="19" height="10" rx="5"/><circle cx="16.500" cy="12" r="2.500" fill="currentColor"/></svg>`,
  add: '<span>Add</span>',
  app: '<img src="bloom-180.png" alt="" width="56" height="56">',
};
let guideBrowser = C.browserOf(navigator.userAgent);
function renderGuideSteps() {
  for (const b of guide.querySelectorAll('[data-browser]')) b.setAttribute('aria-pressed', String(b.dataset.browser === guideBrowser));
  $('#guideList').replaceChildren(...C.homeScreenSteps(guideBrowser).map((s) => {
    const li = el('li');
    const pic = el('span', `guide-pic${s.pic === 'add' ? ' guide-pic-word' : ''}${s.pic === 'app' ? ' guide-pic-icon' : ''}`);
    pic.setAttribute('aria-hidden', 'true');
    pic.innerHTML = PICS[s.pic]; // fixed drawings from the table above, never anything typed or synced
    const words = el('span');
    words.append(el('strong', '', s.title), ` ${s.text}`);
    li.append(pic, words);
    return li;
  }));
}

function showGuide(step) {
  renderGuideSteps();
  for (const s of guide.querySelectorAll('.guide-step')) s.hidden = s.dataset.step !== step;
  $('#guideCarry').textContent = cfg.token ? 'Your shared log comes along with it.' : 'It walks you through the rest.';
  if (!guide.open) {
    for (const sheet of document.querySelectorAll('dialog[open]')) sheet.close();
    guide.showModal();
  }
  guide.scrollTop = 0;
  guide.querySelector(`.guide-step[data-step="${step}"] .sheet-title`).focus();
  $('#nudge').hidden = true;
}

// Show whichever screen this phone still needs; when it needs none, the three tips, once.
function nextGuide() {
  const step = C.firstScreen({
    iphone: IS_IPHONE, standalone: ON_HOME_SCREEN, hasToken: !!cfg.token, hasRole: !!cfg.role,
    later: store.get('bl.later', false), skippedConnect: store.get('bl.skipConnect', false),
  });
  if (step) { showGuide(step === 'install' ? 'hello' : step); return; }
  if (guide.open) guide.close();
  renderNudge();
  if (!store.get('bl.seenWelcome', false)) welcomeSheet.showModal();
}

// Safari on an iPhone: "Add to Home Screen" saves the address as it is right now. Keeping the shared
// log's settings after the # means the Home Screen app opens already connected, with nothing to paste.
function keepSetupInAddress() {
  if (!IS_IPHONE || ON_HOME_SCREEN || DEMO || !cfg.token) return;
  history.replaceState(null, '', `${location.pathname}${location.search}#s=${C.encodeSetup({ t: cfg.token, r: cfg.repo, b: cfg.baby })}`);
}

// Connect this phone to a shared log.
function applySetup(setup) {
  cfg = { ...cfg, token: setup.t, repo: setup.r, baby: cfg.baby || setup.b };
  store.set('bl.cfg', cfg);
  state.shas = {};
  for (const e of Object.values(state.events)) state.dirty[C.bucketOf(e.id)] = Date.now();
  meds.shas = {};
  for (const e of Object.values(meds.events)) meds.dirty[C.bucketOf(e.id)] = Date.now();
  persist();
  keepSetupInAddress();
  setSync('syncing');
  render();
  queueSync(0);
}

$('#guideGo').addEventListener('click', () => {
  // A spare way across, in case the address does not carry the settings: the invite waits on the clipboard.
  if (cfg.token) copyText(inviteLink());
  showGuide('install');
});

guide.addEventListener('click', (ev) => {
  const browser = ev.target.closest('[data-browser]');
  if (browser) { guideBrowser = browser.dataset.browser; renderGuideSteps(); return; }
  const skip = ev.target.closest('[data-guide]');
  if (skip) {
    store.set(skip.dataset.guide === 'later' ? 'bl.later' : 'bl.skipConnect', true);
    nextGuide();
    return;
  }
  const who = ev.target.closest('[data-who]');
  if (who) {
    const role = C.ROLES[who.dataset.who];
    cfg = { ...cfg, role: who.dataset.who, me: role.me, feed: role.feed };
    store.set('bl.cfg', cfg);
    render();
    nextGuide();
  }
});

function connectWith(text) {
  const setup = C.findSetup(text, DEFAULT_REPO);
  if (!setup) return false;
  applySetup(setup);
  toast('Connected. You both see the same log now.');
  nextGuide();
  return true;
}
$('#guideConnect').addEventListener('click', async () => {
  let text = '';
  try {
    if (navigator.clipboard && navigator.clipboard.readText) text = await navigator.clipboard.readText();
  } catch { text = ''; }
  if (text) $('#guidePaste').value = text;
  const ok = connectWith(text);
  $('#guideConnectHelp').hidden = ok || !!text;
  $('#guidePasteError').hidden = ok || !text;
});
$('#guidePasteGo').addEventListener('click', () => {
  const ok = connectWith($('#guidePaste').value);
  $('#guidePasteError').hidden = ok;
  if (!ok) $('#guidePaste').focus();
});
$('#guideWhoOther').addEventListener('click', () => { $('#guideOther').hidden = false; $('#guideName').focus(); });
$('#guideNameGo').addEventListener('click', () => {
  const name = $('#guideName').value.trim();
  if (!name) { $('#guideName').focus(); return; }
  cfg = { ...cfg, role: 'other', me: name, feed: cfg.feed || 'breast' };
  store.set('bl.cfg', cfg);
  render();
  nextGuide();
});
// The guide cannot be dismissed by accident; every screen has its own way on.
guide.addEventListener('cancel', (ev) => ev.preventDefault());
$('#nudgeHide').addEventListener('click', () => { store.set('bl.hideNudge', true); $('#nudge').hidden = true; });

// A sheet closes on a tap outside it only when nothing typed would be lost; Esc and Cancel always work.
for (const sheet of [editSheet, settingsSheet, helpSheet, welcomeSheet, doseSheet, medSheet]) {
  sheet.addEventListener('click', (ev) => {
    if (ev.target !== sheet) return;
    if (sheet === helpSheet || sheet === welcomeSheet || sheet === doseSheet) sheet.close();
    else if (sheet === medSheet && !$('#medName').value && !$('#medDose').value) sheet.close();
    else if (sheet === settingsSheet && !$('#setToken').value && !$('#setMe').value) sheet.close();
  });
}

// ── Sync ────────────────────────────────────────────────────────────────────────────────────────
let syncTimer = null;
let syncing = false;
let syncAgain = false;

function setSync(kind, detail) {
  const text = { local: 'This phone only. Tap to connect', syncing: 'Syncing', synced: 'Shared', error: 'Not synced' }[kind];
  syncInfo = { state: kind, text, detail };
  renderHeader();
}

function queueSync(delay, announce) {
  if (!cfg.token || DEMO) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => runSync(announce), delay);
}

async function runSync(announce) {
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  setSync('syncing');
  try {
    const changed = await syncOnce(new GitHubStore(cfg.token, cfg.repo), state);
    const medsChanged = await syncOnce(new GitHubStore(cfg.token, cfg.repo, undefined, { dir: 'meds', keep: M.cleanMed }), meds);
    persist();
    setSync('synced');
    if (changed || medsChanged) render();
    if (announce) toast('Up to date.');
  } catch (err) {
    persist();
    const known = err instanceof SyncError;
    setSync('error', known ? err.message : 'Sync hit a problem. Entries are safe on this phone and it will try again.');
    if (!known) console.error(err);
  } finally {
    syncing = false;
    if (syncAgain) { syncAgain = false; queueSync(500); }
  }
}

// Opening a setup link from the other phone turns sharing on without typing anything.
// This also runs every time the Home Screen app opens, because its saved address carries the settings.
function acceptSetupLink() {
  const m = /^#s=([\w-]+)$/.exec(location.hash);
  if (!m) return;
  history.replaceState(null, '', location.pathname + location.search); // drop the key from the address bar
  const setup = C.decodeSetup(m[1]);
  if (!setup) { toast('That invite link is not readable. Ask for a fresh one.'); return; }
  if (C.sameSetup(cfg, setup)) return; // already connected to this log: nothing to do, nothing to say
  applySetup(setup);
  toast('Connected. You both see the same log now.');
}

// ── Start ───────────────────────────────────────────────────────────────────────────────────────
for (const btn of document.querySelectorAll('.act')) btn.addEventListener('click', () => (btn.dataset.log === 'meds' ? medsButton() : logNow(btn.dataset.log)));

acceptSetupLink();
keepSetupInAddress();
setSync(cfg.token && !DEMO ? 'syncing' : 'local');
render();
renderNudge();
queueSync(0);

// First open on this phone: the guide shows whichever screen it still needs, then the tips, once.
if (FORCE && FORCE.startsWith('guide-')) showGuide(FORCE.slice(6));
else if (!DEMO) nextGuide();

setInterval(() => { renderSince(); renderMeds(); }, 20e3);
setInterval(() => { if (document.visibilityState === 'visible') queueSync(0); }, 60e3);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { render(); queueSync(0); }
});
window.addEventListener('online', () => queueSync(0));

if (DEMO) { // ?demo=tray | edit | settings opens that state, for screenshots and checks
  const show = new URLSearchParams(location.search).get('demo');
  if (show === 'tray') logNow('feed');
  if (show === 'pump') logNow('pump');
  if (show === 'pump-ml') { cfg = { ...cfg, unit: 'ml' }; logNow('pump'); }
  if (show === 'bottle-ml') { cfg = { ...cfg, unit: 'ml', feed: 'bottle' }; logNow('feed'); setDraft({ ...draftOf(trayId).e, ml: 37, donor: true }); paintTray(); }
  if (show === 'edit') openEdit(C.live(Object.values(state.events))[0].id);
  if (show === 'settings') openSettings();
  if (show === 'help') openHelp();
  if (show === 'welcome') welcomeSheet.showModal();
  const medIds = M.medStatus(Object.values(meds.events)).map((x) => x.med.id);
  if (show === 'med-add') openMed(null);
  if (show === 'med') openMed(medIds[0]);
  if (show === 'dose') openDose(medIds[1]);
  if (show === 'dose-early') openDose(medIds[0]);
  if (show === 'meds' || show === 'meds-pick') medsButton();
  if (show === 'meds-fold') { medsButton(); $('#medFold').open = true; }
  if (show === 'meds-ready' || show === 'meds-none-ready' || show === 'dot-off') { // every medicine ready (an old dose, or none), or every one just taken
    for (const e of Object.values(meds.events)) if (e.k === 'dose') delete meds.events[e.id];
    const all = M.medStatus(Object.values(meds.events)).map((x) => x.med);
    for (const med of show === 'meds-ready' ? all.slice(0, 2) : all) {
      const d = M.newDose(med, Date.now() - (show === 'meds-ready' ? 420 : 20) * 60e3, 'Mom');
      meds.events[d.id] = d;
    }
    renderMeds();
    if (show !== 'dot-off') medsButton();
  }
  if (show === 'meds-manage') { medsButton(); openManage(); }
  if (show === 'day') openDay(C.groupByDay(Object.values(state.events)).find((g) => g.key !== C.dayKey(Date.now())).key);
  if (show === 'meds-empty') { for (const k of Object.keys(meds.events)) delete meds.events[k]; renderMeds(); medsButton(); }
}

if ('serviceWorker' in navigator && !DEMO && location.protocol === 'https:') {
  // A phone that only brings the app back from the background never reloads it, so: look for a new
  // version each time the app comes to the front, and when one takes over, reload once. Unsaved taps are
  // kept on the phone and come back; an open sheet (typing in progress) is never interrupted.
  const hadWorker = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
  }).catch(() => {});
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadWorker || reloaded || document.querySelector('dialog[open]')) return;
    reloaded = true;
    location.reload();
  });
}
