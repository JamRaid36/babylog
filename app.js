import * as C from './core.js';
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
let cfg = { me: '', role: '', feed: '', baby: '', token: '', repo: DEFAULT_REPO, ...store.get('bl.cfg', {}) };
const state = {
  events: store.get('bl.events', {}), // id -> event
  dirty: store.get('bl.dirty', {}),   // day -> stamp: days with changes not yet sent
  shas: store.get('bl.shas', {}),     // day -> version of the shared file last seen
};
let syncInfo = { state: 'local', text: 'This phone only' };

function persist() {
  const ok = store.set('bl.events', state.events) && store.set('bl.dirty', state.dirty) && store.set('bl.shas', state.shas);
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

function logNow(kind) {
  const e = put({ id: C.newId(), k: kind, t: Date.now(), by: cfg.me, ...(kind === 'feed' ? C.feedDefaults(cfg) : {}) });
  if (!e) return;
  store.set('bl.untimed', '');
  flashButton(kind);
  openTray(e.id);
}

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
    if (e && kind === 'pump' && e.oz > 0) extra = ` · ${e.oz} oz`;
    $(subSel).textContent = e ? `${C.clock(e.t)}${extra}` : 'None yet';
  }
  $('#tally').textContent = C.tally(s.day);
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

function renderLog() {
  const box = $('#log');
  box.replaceChildren();
  const groups = C.groupByDay(Object.values(state.events));
  if (!groups.length) {
    const empty = el('div', 'empty');
    empty.append(art('baby'), el('p', 'empty-title', 'Nothing logged yet'),
      el('p', 'empty-text', 'Tap Feed, Pee or Poop below the moment it happens. One tap saves it with the time.'));
    box.append(empty);
    return;
  }
  for (const g of groups) {
    const day = el('section', 'day');
    const head = el('div', 'day-head');
    head.append(el('h3', 'day-name', g.label), el('p', 'day-count', C.tally(g.count)));
    const list = el('ul', 'rows');
    for (const e of g.items) {
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
    day.append(head, list);
    box.append(day);
  }
}

function renderHeader() {
  const name = cfg.baby.trim();
  $('#babyName').textContent = name || 'Jubilee';
  document.title = name ? `${name} · log` : 'Jubilee';
  const btn = $('#syncBtn');
  btn.dataset.state = syncInfo.state;
  $('#syncText').textContent = syncInfo.text;
  btn.setAttribute('aria-label', `${syncInfo.text}. ${cfg.token ? 'Sync now' : 'Open sharing settings'}`);

  const notice = $('#notice');
  if (syncInfo.state === 'error' && syncInfo.detail) {
    notice.textContent = syncInfo.detail;
    notice.hidden = false;
  } else if (!cfg.token && !DEMO && Object.keys(state.events).length >= 3 && !store.get('bl.hideLocalNote', false)) {
    notice.replaceChildren('Entries are saved on this phone only. ');
    const open = el('button', 'link-btn', 'Share with another phone');
    open.type = 'button';
    open.addEventListener('click', openSettings);
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
  renderLog();
}

function flashButton(kind) {
  const btn = document.querySelector(`.act[data-log="${kind}"]`);
  const label = btn.querySelector('.act-label');
  btn.classList.add('is-logged');
  label.textContent = 'Logged';
  setTimeout(() => { btn.classList.remove('is-logged'); label.textContent = C.KIND_LABEL[kind]; }, 1100);
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

// ── Tray: optional extras right after a tap ─────────────────────────────────────────────────────
let trayId = null;
let trayBase = 0; // the moment of the tap; "15 min ago" counts back from here
let trayTimer = null;

function openTray(id) {
  const e = state.events[id];
  if (!e) return;
  hideToast();
  trayId = id;
  trayBase = e.t;
  paintTray();
  $('#tray').hidden = false;
  // a question worth its one tap (which side, how much) keeps the tray up longer
  armTray((e.k === 'feed' && !e.side) || C.hasAmount(e) ? 30000 : 9000);
}
function armTray(ms) { clearTimeout(trayTimer); trayTimer = setTimeout(closeTray, ms); }
function closeTray() { clearTimeout(trayTimer); trayId = null; $('#tray').hidden = true; }

function paintTray() {
  const e = state.events[trayId];
  if (!e) return closeTray();
  $('#trayTitle').textContent = `${C.KIND_LABEL[e.k]} saved · ${C.clock(e.t)}`;
  const back = Math.round((trayBase - e.t) / 60e3);
  for (const chip of document.querySelectorAll('#trayWhen .chip')) chip.setAttribute('aria-pressed', String(Number(chip.dataset.back) === back));
  $('#traySide').hidden = e.k !== 'feed';
  for (const chip of document.querySelectorAll('#traySide .chip')) chip.setAttribute('aria-pressed', String(chip.dataset.side === e.side));
  // "How much" only where it means something: a pump, or a bottle feed
  $('#trayAmount').hidden = !C.hasAmount(e);
  $('#trayAmountLabel').textContent = e.k === 'pump' ? 'How much did you get' : 'How much did she drink';
  for (const chip of document.querySelectorAll('#trayAmount .chip[data-oz]')) chip.setAttribute('aria-pressed', String(Number(chip.dataset.oz) === e.oz));
  $('#trayOz').textContent = e.oz > 0 ? `${e.oz} oz` : 'Not set';
  return undefined;
}

$('#tray').addEventListener('click', (ev) => {
  const chip = ev.target.closest('.chip');
  const e = state.events[trayId];
  if (!chip || !e) return;
  if (chip.dataset.back !== undefined) put({ ...e, t: trayBase - Number(chip.dataset.back) * 60e3 });
  else if (chip.dataset.side) {
    const side = e.side === chip.dataset.side ? undefined : chip.dataset.side;
    put({ ...e, side, oz: side === 'bottle' ? e.oz : undefined }); // ounces belong to a bottle
  } else if (chip.dataset.oz) put({ ...e, oz: e.oz === Number(chip.dataset.oz) ? undefined : Number(chip.dataset.oz) });
  else if (chip.dataset.step) put({ ...e, oz: C.stepOz(e.oz, Number(chip.dataset.step)) || undefined });
  paintTray();
  armTray(12000);
});
$('#trayUndo').addEventListener('click', () => {
  const e = state.events[trayId];
  closeTray();
  if (e) { put({ ...e, x: true }); toast(`${C.KIND_LABEL[e.k]} removed.`); }
});
$('#trayMore').addEventListener('click', () => { const id = trayId; closeTray(); openEdit(id); });
$('#trayDone').addEventListener('click', closeTray);
// someone moving through the tray by keyboard or switch control is not timed out of it
$('#tray').addEventListener('focusin', () => clearTimeout(trayTimer));
$('#tray').addEventListener('focusout', () => armTray(9000));

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
  $('#editMin').value = e.min || '';
  $('#editOz').value = e.oz || '';
  $('#editNote').value = e.note || '';
  disarmDelete();
  showFeedFields();
  editSheet.showModal();
}

$('#editForm').addEventListener('change', (ev) => {
  if (ev.target.name === 'kind') showFeedFields();
  if (ev.target.name === 'side' && ev.target.checked) setSideBoxes(ev.target.value); // one side at most
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
  put({
    id: e.id, by: e.by, k: kind, t,
    side: kind === 'feed' && side ? side.value : undefined,
    min: kind === 'feed' || kind === 'pump' ? Number($('#editMin').value) : undefined,
    oz: kind === 'feed' || kind === 'pump' ? Number($('#editOz').value) : undefined,
    note: $('#editNote').value,
  });
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
$('#syncBtn').addEventListener('click', () => (cfg.token ? queueSync(0, true) : openSettings()));

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
$('#helpBtn').addEventListener('click', openHelp);
$('#setHelp').addEventListener('click', openHelp);
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

function showGuide(step) {
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
  const setup = C.findSetup(text);
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
  if (!connectWith(text)) $('#guideConnectHelp').hidden = false;
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
for (const sheet of [editSheet, settingsSheet, helpSheet, welcomeSheet]) {
  sheet.addEventListener('click', (ev) => {
    if (ev.target !== sheet) return;
    if (sheet === helpSheet || sheet === welcomeSheet) sheet.close();
    else if (sheet === settingsSheet && !$('#setToken').value && !$('#setMe').value) sheet.close();
  });
}

// ── Sync ────────────────────────────────────────────────────────────────────────────────────────
let syncTimer = null;
let syncing = false;
let syncAgain = false;

function setSync(kind, detail) {
  const text = { local: 'This phone only', syncing: 'Syncing', synced: 'Shared', error: 'Not synced' }[kind];
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
    persist();
    setSync('synced');
    if (changed) render();
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
for (const btn of document.querySelectorAll('.act')) btn.addEventListener('click', () => logNow(btn.dataset.log));

acceptSetupLink();
keepSetupInAddress();
setSync(cfg.token && !DEMO ? 'syncing' : 'local');
render();
renderNudge();
queueSync(0);

// First open on this phone: the guide shows whichever screen it still needs, then the tips, once.
if (FORCE && FORCE.startsWith('guide-')) showGuide(FORCE.slice(6));
else if (!DEMO) nextGuide();

setInterval(renderSince, 20e3);
setInterval(() => { if (document.visibilityState === 'visible') queueSync(0); }, 60e3);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { render(); queueSync(0); }
});
window.addEventListener('online', () => queueSync(0));

if (DEMO) { // ?demo=tray | edit | settings opens that state, for screenshots and checks
  const show = new URLSearchParams(location.search).get('demo');
  if (show === 'tray') logNow('feed');
  if (show === 'pump') logNow('pump');
  if (show === 'edit') openEdit(C.live(Object.values(state.events))[0].id);
  if (show === 'settings') openSettings();
  if (show === 'help') openHelp();
  if (show === 'welcome') welcomeSheet.showModal();
}

if ('serviceWorker' in navigator && !DEMO && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
