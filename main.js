// main.js — all data access goes through Supabase RPC functions (see code/migrations/).
// The browser never reads tables directly; the server decides what each caller may see.
// Every piece of user text goes through esc() before it reaches innerHTML.
// Pre-redesign version: archive/2026-11-02_pre_redesign/main.js
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const app = document.getElementById('app');

let slug = null;
let view = null; // result of get_event: { event, items, going, not_going_count, me, guests? }
// UI-only state that survives re-renders of the same event.
const ui = { filter: 'all', pending: null, declining: false, signin: false, editing: null, focusAdd: false, justCreated: false };
function resetUi() { Object.assign(ui, { filter: 'all', pending: null, declining: false, signin: false, editing: null }); }

// ----------------------
// Helpers
// ----------------------
function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function $(id) { return document.getElementById(id); }
function showErr(id, msg) { const el = $(id); if (!el) return; el.textContent = msg || ''; el.style.display = msg ? 'block' : 'none'; }
function errMsg(e) { return e?.message || String(e); }
const isMobile = () => window.matchMedia('(max-width: 959px)').matches;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

async function rpc(fn, args) {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  if (data && typeof data === 'object' && data.error) throw new Error(data.error);
  return data;
}

// Every visitor gets a private anonymous session; it is their identity in this browser.
async function ensureSession() {
  const { data: { session } } = await supabase.auth.getSession();
  if (session) return true;
  const { error } = await supabase.auth.signInAnonymously();
  if (error) {
    console.error('[auth] anonymous sign-in failed:', error);
    return false;
  }
  return true;
}

function eventUrl(s = slug) { return `${location.origin}/#/event/${s}`; }
function findItem(id) { return view.items.find((i) => i.id === id); }

// Feather-style line icons (MIT).
const ICONS = {
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  pin: '<path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
  external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6M10 14L21 3"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  share: '<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="M16 6l-4-4-4 4M12 2v13"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  mail: '<path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/><path d="M22 6l-10 7L2 6"/>'
};
function icon(name) { return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`; }

function toast(msg, kind = '') {
  let t = $('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    t.setAttribute('role', 'status');
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.className = `toast show ${kind}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.className = `toast ${kind}`; }, kind === 'error' ? 6000 : 3500);
}

function openDialog(html) {
  const d = document.createElement('dialog');
  d.className = 'modal';
  d.innerHTML = `<div class="modal-body">${html}</div>`;
  document.body.appendChild(d);
  d.addEventListener('close', () => d.remove());
  d.addEventListener('click', (e) => { if (e.target === d) d.close(); }); // backdrop
  d.showModal();
  return d;
}

// Promise-based confirm in the site's style.
function ask({ title, body = '', ok = 'OK', tone = 'primary' }) {
  return new Promise((resolve) => {
    const d = openDialog(`
      <h3 class="card-title">${esc(title)}</h3>
      ${body ? `<p>${esc(body)}</p>` : ''}
      <div class="btn-row end">
        <button type="button" class="btn btn-ghost" id="askCancel">Cancel</button>
        <button type="button" class="btn btn-${tone}" id="askOk">${esc(ok)}</button>
      </div>`);
    let answer = false;
    d.querySelector('#askOk').onclick = () => { answer = true; d.close(); };
    d.querySelector('#askCancel').onclick = () => d.close();
    d.addEventListener('close', () => resolve(answer));
    d.querySelector('#askOk').focus();
  });
}

async function copyText(text, msg) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(msg);
}

function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// -----------------------------------------------------------------------------
// OpenStreetMap / Nominatim helpers (no API key needed)
// -----------------------------------------------------------------------------
async function osmSearch(query) {
  if (!query || query.length < 3) return [];
  const params = new URLSearchParams({ q: query, format: 'json', addressdetails: 1, limit: 5 });
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, { headers: { 'Accept-Language': 'en' } });
  if (!res.ok) return [];
  return await res.json();
}

function attachOSMAutocomplete(inputEl, onSelect) {
  if (!inputEl) return;
  const wrapper = document.createElement('div');
  wrapper.className = 'osm-wrap';
  inputEl.parentNode.insertBefore(wrapper, inputEl);
  wrapper.appendChild(inputEl);
  const list = document.createElement('div');
  list.className = 'osm-dropdown';
  list.hidden = true;
  wrapper.appendChild(list);

  let timer;
  inputEl.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = inputEl.value.trim();
      const results = q.length < 3 ? [] : await osmSearch(q).catch(() => []);
      list.replaceChildren(...results.map((r) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'osm-option';
        b.textContent = r.display_name;
        b.addEventListener('click', () => {
          inputEl.value = r.display_name;
          list.hidden = true;
          onSelect && onSelect(r);
        });
        return b;
      }));
      list.hidden = !results.length;
    }, 350);
  });
  document.addEventListener('click', (e) => { if (!wrapper.contains(e.target)) list.hidden = true; });
}

function buildGoogleMapsUrl(evt) {
  if (evt.lat != null && evt.lng != null) return `https://www.google.com/maps/search/?api=1&query=${Number(evt.lat)},${Number(evt.lng)}`;
  if (evt.location) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(evt.location)}`;
  return null;
}

// Dates are stored as plain YYYY-MM-DD; build them in local time so they don't shift a day.
function localDate(d, t) {
  const [y, m, day] = d.split('-').map(Number);
  const [h, mi] = (t || '0:0').split(':').map(Number);
  return new Date(y, m - 1, day, h, mi);
}
function formatDate(d) {
  return localDate(d).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}
function formatEventTime(t) {
  if (!t) return '';
  return localDate('2000-01-01', t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function safeInviteUrl(u) { return /^https:\/\//i.test(u || '') ? u : null; }
function linkHost(u) { try { return new URL(u).hostname; } catch { return ''; } }
function inviteLabel(u) { return /(^|\.)partiful\.com$/i.test(linkHost(u)) ? 'Partiful invite' : 'Event invite'; }
function scheduleLabel(u) {
  const h = linkHost(u);
  if (/(^|\.)when2meet\.com$/i.test(h)) return 'Vote on a time (when2meet)';
  if (/(^|\.)doodle\.com$/i.test(h)) return 'Vote on a time (Doodle)';
  return 'Vote on a time';
}

const ext = (href, label) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
// The two optional link fields, shared by the create form and the edit dialog.
function linkFieldsHTML(inviteId, scheduleId, ev = {}) {
  return `
    <div class="field">
      <label for="${inviteId}">Invite link <em>optional · ${ext('https://partiful.com/', 'Partiful')}, ${ext('https://www.evite.com/', 'Evite')}, etc.</em></label>
      <input type="url" id="${inviteId}" maxlength="500" placeholder="https://partiful.com/e/…" value="${esc(ev.invite_url || '')}">
    </div>
    <div class="field">
      <label for="${scheduleId}">Find-a-time link <em>optional · ${ext('https://www.when2meet.com/', 'when2meet')}, ${ext('https://doodle.com/', 'Doodle')}, etc.</em></label>
      <input type="url" id="${scheduleId}" maxlength="500" placeholder="https://www.when2meet.com/?…" value="${esc(ev.schedule_url || '')}">
    </div>`;
}

const PASSWORD_HINT = 'Optional. Skip it and you may not be able to change your response later.';

// ----------------------
// 1. Event creation
// ----------------------
function renderCreateEventForm(notice = '') {
  slug = null; view = null;
  document.body.classList.remove('is-event', 'sheet-open');
  app.innerHTML = `
    <form id="eventForm" class="card stack">
      <h2 class="card-title">Start an event</h2>
      <div id="eventFormError" class="err" role="alert"></div>
      <label class="field"><span>Event name</span>
        <input type="text" id="eventName" maxlength="120" required placeholder="e.g. Friendsgiving 2026">
      </label>
      <div class="row-2">
        <label class="field"><span>Date <em>optional</em></span><input type="date" id="eventDate"></label>
        <label class="field"><span>Time <em>optional</em></span><input type="time" id="eventTime"></label>
      </div>
      <div class="row-2">
        <label class="field"><span>Your name</span>
          <input type="text" id="username" maxlength="40" required autocomplete="name" placeholder="e.g. Jane D.">
        </label>
        <label class="field"><span>Password <em>optional</em></span>
          <input type="password" id="password" maxlength="72" autocomplete="new-password">
        </label>
      </div>
      <p class="hint">${icon('lock')}<span>Skip the password and you may not be able to edit this event later.</span></p>
      <details class="more">
        <summary>More options <small>location, description, invite &amp; scheduling links, reminders</small></summary>
        <div class="stack">
          <div class="field">
            <label for="eventLocation">Location</label>
            <input type="text" id="eventLocation" maxlength="300" placeholder="Start typing an address…" autocomplete="off">
          </div>
          <input type="hidden" id="eventLocationPlaceId">
          <input type="hidden" id="eventLocationLat">
          <input type="hidden" id="eventLocationLng">
          <label class="field"><span>Description</span>
            <textarea id="eventDescription" maxlength="2000" rows="2" placeholder="Parking info, dietary notes, theme…"></textarea>
          </label>
          ${linkFieldsHTML('inviteUrl', 'scheduleUrl')}
          <label class="check">
            <input type="checkbox" id="collectEmails">
            <span>Ask guests for an email so I can send reminders. Only I will see them.</span>
          </label>
        </div>
      </details>
      <button id="createEventBtn" type="submit" class="btn btn-primary btn-block">Create event</button>
    </form>`;
  if (notice) showErr('eventFormError', notice);
  attachOSMAutocomplete($('eventLocation'), (place) => {
    $('eventLocationPlaceId').value = place.osm_id ? `osm:${place.osm_type}:${place.osm_id}` : '';
    $('eventLocationLat').value = place.lat || '';
    $('eventLocationLng').value = place.lon || '';
  });
}

async function createEvent(form) {
  showErr('eventFormError', '');
  const btn = $('createEventBtn');
  btn.disabled = true;
  try {
    if (!(await ensureSession())) throw new Error('Could not start a browser session. Please refresh and try again.');
    const res = await rpc('create_event', {
      p: {
        name: $('eventName').value,
        description: $('eventDescription').value,
        date: $('eventDate').value,
        time: $('eventTime').value,
        location: $('eventLocation').value,
        place_id: $('eventLocationPlaceId').value,
        lat: $('eventLocationLat').value,
        lng: $('eventLocationLng').value,
        invite_url: $('inviteUrl').value.trim(),
        schedule_url: $('scheduleUrl').value.trim(),
        collect_emails: $('collectEmails').checked,
        host_name: $('username').value,
        password: $('password').value
      }
    });
    ui.focusAdd = true;
    ui.justCreated = true;
    window.location.hash = `#/event/${res.slug}`;
  } catch (err) {
    showErr('eventFormError', errMsg(err));
    if (!form.querySelector('details.more').open && /link|https/i.test(errMsg(err))) form.querySelector('details.more').open = true;
  } finally {
    btn.disabled = false;
  }
}

// ----------------------
// 2. Loading an event
// ----------------------
async function loadEvent(s) {
  if (s !== slug) { resetUi(); view = null; }
  slug = s;
  document.body.classList.add('is-event');
  if (!view) app.innerHTML = '<p class="loading">Loading event…</p>';
  await ensureSession();
  try {
    view = await rpc('get_event', { p_slug: s });
  } catch (err) {
    console.error('Event not found:', err);
    renderCreateEventForm('That event link was not found. You can start a new event here.');
    return;
  }
  render();
  if (ui.justCreated) {
    ui.justCreated = false;
    toast('Event created! Add what you need, then share the link.');
  }
}

// Apply a server result (fresh get_event payload) and redraw.
function apply(result) { view = result; render(); }

function render() {
  const ev = view.event;
  const isHost = !!view.me?.is_host;
  document.body.classList.add('is-event');
  app.innerHTML = `
    <div class="event">
      ${ev.deleting ? `<p class="banner">This event is scheduled for deletion.
        ${isHost ? 'You can undo this for 7 days.' : 'It no longer accepts changes.'}</p>` : ''}
      ${headerHTML(isHost)}
      <div class="event-grid">
        <section class="card items-card" aria-labelledby="itemsTitle">${itemsCardHTML(isHost)}</section>
        <aside class="side">
          ${youCardHTML()}
          ${isHost ? guestsCardHTML() : ''}
        </aside>
      </div>
      ${mineBarHTML()}
      <div class="sheet-backdrop" data-act="close-sheet"></div>
    </div>`;
  if (ui.focusAdd) { ui.focusAdd = false; $('newItemName')?.focus({ preventScroll: true }); }
}

// Redraw just the "you" panel (keeps the rest of the page, e.g. typed text, intact).
function refreshYou() {
  const card = $('youCard');
  if (card) card.outerHTML = youCardHTML();
  const bar = $('mineBar');
  if (bar) bar.outerHTML = mineBarHTML();
}

// ---------- Header: details, share, host tools ----------
function headerHTML(isHost) {
  const ev = view.event;
  const maps = buildGoogleMapsUrl(ev);
  const invite = safeInviteUrl(ev.invite_url);
  const schedule = safeInviteUrl(ev.schedule_url);
  const notGoing = Number(view.not_going_count) || 0;
  return `
    <header class="card event-head">
      <p class="eyebrow">Hosted by ${esc(ev.host)} · ${view.going.length} going${notGoing ? ` · ${notGoing} can't` : ''}</p>
      <h2 class="event-title">${esc(ev.name)}</h2>
      ${ev.date || ev.time || ev.location ? `
        <ul class="meta">
          ${ev.date ? `<li>${icon('calendar')}<span>${esc(formatDate(ev.date))}</span></li>` : ''}
          ${ev.time ? `<li>${icon('clock')}<span>${esc(formatEventTime(ev.time))}</span></li>` : ''}
          ${ev.location ? `<li>${icon('pin')}${maps
            ? `<a href="${esc(maps)}" target="_blank" rel="noopener noreferrer">${esc(ev.location)}</a>`
            : `<span>${esc(ev.location)}</span>`}</li>` : ''}
        </ul>` : ''}
      ${ev.description ? `<p class="event-description">${esc(ev.description)}</p>` : ''}
      <div class="head-links">${schedule ? `<a id="scheduleLink" class="btn ${ev.date ? 'btn-ghost' : 'btn-sage'} btn-sm" href="${esc(schedule)}" target="_blank" rel="noopener noreferrer">${icon('calendar')} ${ev.date ? scheduleLabel(schedule) : `Date TBD: ${scheduleLabel(schedule).replace(/^Vote/, 'vote')}`}</a>` : ''}${invite ? `<a id="inviteLink" class="btn btn-ghost btn-sm" href="${esc(invite)}" target="_blank" rel="noopener noreferrer">${icon('external')} ${inviteLabel(invite)}</a>` : ''}${ev.date ? calendarMenuHTML() : ''}</div>
      <div id="shareUrlContainer" class="sharebar">
        <input type="text" id="shareUrl" value="${esc(eventUrl())}" readonly aria-label="Event link">
        <button id="copyShareUrl" type="button" class="btn btn-sage" data-act="copy-link">${icon('copy')} Copy link</button>
        ${navigator.share ? `<button type="button" class="btn btn-ghost" data-act="share">${icon('share')} Share</button>` : ''}
        ${isHost ? `<button id="copyBlurb" type="button" class="btn btn-ghost" data-act="copy-blurb" title="A ready-made blurb for your Partiful description or group text">Copy for Partiful</button>` : ''}
      </div>
      ${isHost ? hostToolsHTML() : ''}
    </header>`;
}

function hostToolsHTML() {
  const ev = view.event;
  return `
    <div class="host-tools" aria-label="Host tools">
      <span class="host-tools-label">Host</span>
      <button id="editEventBtn" type="button" class="btn btn-ghost btn-sm" data-act="edit-event">${icon('edit')} Edit details</button>
      ${ev.collect_emails ? `<button id="sendRemindersBtn" type="button" class="btn btn-ghost btn-sm" data-act="reminders">${icon('mail')} Email reminders</button>` : ''}
      <button id="exportCSV" type="button" class="btn btn-ghost btn-sm" data-act="export-csv" title="Download your items as a CSV. Edit it in a spreadsheet, then use Import CSV.">Export CSV/Template</button>
      <button id="importCSV" type="button" class="btn btn-ghost btn-sm" data-act="import-csv">Import CSV</button>
      <input id="importCSVInput" type="file" accept=".csv,text/csv" hidden>
      ${ev.deleting
        ? `<button id="undeleteEventBtn" type="button" class="btn btn-sage btn-sm push" data-act="undelete">Undo delete</button>`
        : `<button id="deleteEventBtn" type="button" class="btn btn-danger btn-sm push" data-act="delete-event">Delete event</button>`}
    </div>`;
}

// ---------- Calendar ----------
function calendarInfo() {
  const ev = view.event;
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (dt) => `${dt.getFullYear()}${pad(dt.getMonth() + 1)}${pad(dt.getDate())}`;
  const stamp = (dt) => `${ymd(dt)}T${pad(dt.getHours())}${pad(dt.getMinutes())}00`;
  const start = localDate(ev.date, ev.time);
  const allDay = !ev.time;
  const end = allDay ? new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1) : new Date(start.getTime() + 3 * 3600e3);
  return {
    allDay,
    start: allDay ? ymd(start) : stamp(start),
    end: allDay ? ymd(end) : stamp(end),
    details: `Who's bringing what: ${eventUrl()}`
  };
}
function calendarMenuHTML() {
  const ev = view.event;
  const c = calendarInfo();
  const google = `https://calendar.google.com/calendar/render?${new URLSearchParams({
    action: 'TEMPLATE', text: ev.name, dates: `${c.start}/${c.end}`, details: c.details, location: ev.location || ''
  })}`;
  return `
    <details class="menu">
      <summary class="btn btn-ghost btn-sm">${icon('calendar')} Add to calendar</summary>
      <div class="menu-pop">
        <a href="${esc(google)}" target="_blank" rel="noopener noreferrer">Google Calendar</a>
        <button type="button" data-act="ics">Apple / Outlook (.ics file)</button>
      </div>
    </details>`;
}
function downloadICS() {
  const ev = view.event;
  const c = calendarInfo();
  const txt = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  const when = (k, v) => (c.allDay ? `${k};VALUE=DATE:${v}` : `${k}:${v}`);
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Potluxy//EN', 'BEGIN:VEVENT',
    `UID:${slug}@potluxy.com`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '')}`,
    when('DTSTART', c.start), when('DTEND', c.end),
    `SUMMARY:${txt(ev.name)}`,
    ev.location ? `LOCATION:${txt(ev.location)}` : '',
    `DESCRIPTION:${txt(c.details)}`,
    `URL:${eventUrl()}`,
    'END:VEVENT', 'END:VCALENDAR'
  ].filter(Boolean).join('\r\n');
  download(`${slug}.ics`, ics, 'text/calendar;charset=utf-8');
}

// Ready-to-paste text for a Partiful description, text blast, or group chat.
function partifulBlurb() {
  const ev = view.event;
  const open = view.items.filter((i) => i.committed < i.needed);
  const names = open.slice(0, 6).map((i) => i.name).join(', ');
  return [
    `🍽️ Potluck sign-up for ${ev.name}!`,
    open.length
      ? `Still needed: ${names}${open.length > 6 ? ', and more' : ''}.`
      : 'Claim what you\'re bringing so we don\'t end up with five bags of chips.',
    `Pick yours here, no account needed: ${eventUrl()}`,
    !ev.date && safeInviteUrl(ev.schedule_url) ? `Help pick a date: ${ev.schedule_url}` : ''
  ].filter(Boolean).join('\n');
}

// ---------- Items ----------
function itemsCardHTML(isHost) {
  const items = view.items;
  const covered = items.filter((i) => i.committed >= i.needed).length;
  const mineCount = items.filter((i) => i.mine > 0).length;
  const showFilters = items.length > 5;
  const f = showFilters ? ui.filter : 'all';
  const list = items.filter((i) => f === 'all' || (f === 'needed' ? i.committed < i.needed : i.mine > 0));
  const chip = (key, label, n) =>
    `<button type="button" class="chip${f === key ? ' on' : ''}" aria-pressed="${f === key}" data-act="filter" data-filter="${key}">${label} <span>${n}</span></button>`;

  let empty = '';
  if (!items.length) {
    empty = isHost
      ? 'Nothing on the list yet. Add the first item below, or paste a whole list.'
      : 'The host hasn\'t added items yet. Check back soon.';
  } else if (!list.length) {
    empty = f === 'needed' ? 'Everything is covered. 🎉' : 'You haven\'t picked anything yet.';
  }

  return `
    <div class="card-head">
      <h3 id="itemsTitle">Items needed</h3>
      ${items.length ? `<span class="count">${covered} of ${items.length} covered</span>` : ''}
    </div>
    ${showFilters ? `
      <div class="filters" role="group" aria-label="Filter items">
        ${chip('all', 'All', items.length)}
        ${chip('needed', 'Still needed', items.length - covered)}
        ${view.me ? chip('mine', 'Mine', mineCount) : ''}
      </div>` : ''}
    <ul id="itemList" class="item-list">
      ${list.map(itemHTML).join('') || `<li class="empty">${empty}</li>`}
    </ul>
    ${isHost && !view.event.deleting ? addItemHTML() : ''}`;
}

function itemHTML(item) {
  if (ui.editing === item.id) return itemEditHTML(item);
  const me = view.me;
  const id = esc(item.id);
  const left = Math.max(0, item.needed - item.committed);
  const state = item.committed >= item.needed ? 'is-full' : item.committed > 0 ? 'is-partial' : 'is-open';
  const pct = Math.min(100, Math.round((item.committed / Math.max(1, item.needed)) * 100));
  const who = item.who.map((w) =>
    `<span class="pill${me && w.name === me.name ? ' pill-me' : ''}">${esc(w.name)} × ${Number(w.qty)}</span>`).join('');

  let action = '';
  if (view.event.deleting) action = '';
  else if (item.mine > 0) {
    action = `
      <div class="stepper" role="group" aria-label="How many ${esc(item.name)} you're bringing">
        <button type="button" data-act="dec" data-id="${id}" aria-label="One fewer">${icon('minus')}</button>
        <input class="qty" type="number" inputmode="numeric" min="0" max="999" value="${Number(item.mine)}" data-id="${id}" aria-label="Quantity">
        <button type="button" data-act="inc" data-id="${id}" aria-label="One more" ${left <= 0 ? 'disabled' : ''}>${icon('plus')}</button>
      </div>`;
  } else if (left > 0) {
    action = `<button type="button" class="btn btn-primary btn-sm" data-act="bring" data-id="${id}">I'll bring</button>`;
  } else {
    action = `<span class="covered">${icon('check')} Covered</span>`;
  }

  // Wide: name | progress | action on one line, notes + who underneath. Narrow: see .item in style.css.
  return `
    <li class="item ${state}${item.mine > 0 ? ' is-mine' : ''}${ui.pending === item.id ? ' is-picked' : ''}" data-item="${id}">
      <span class="item-name">${esc(item.name)}</span>
      <span class="item-progress" title="${Number(item.committed)} of ${Number(item.needed)} covered">
        <span class="bar"><span style="width:${pct}%"></span></span>
        <span class="item-count"><strong>${Number(item.committed)}</strong>/${Number(item.needed)}</span>
      </span>
      <div class="item-action">
        ${me?.is_host && !view.event.deleting ? `<button type="button" class="icon-btn" data-act="edit-item" data-id="${id}" aria-label="Edit ${esc(item.name)}">${icon('edit')}</button>` : ''}
        ${action}
      </div>
      ${item.description || who ? `
        <div class="item-info">
          ${item.description ? `<p class="item-desc">${esc(item.description)}</p>` : ''}
          ${who ? `<div class="item-who">${who}</div>` : ''}
        </div>` : ''}
      <p class="item-err" role="alert"></p>
    </li>`;
}

function itemEditHTML(item) {
  const id = esc(item.id);
  return `
    <li class="item editing" data-item="${id}">
      <form class="item-edit" data-id="${id}">
        <input type="text" id="edit-item-${id}" value="${esc(item.name)}" maxlength="120" required aria-label="Item name">
        <input type="number" id="edit-qty-${id}" value="${Number(item.needed)}" min="1" max="999" required aria-label="How many needed">
        <input type="text" class="full" id="edit-desc-${id}" value="${esc(item.description || '')}" maxlength="300" placeholder="Note for guests (optional)" aria-label="Item note">
        <div id="edit-err-${id}" class="err full" role="alert"></div>
        <div class="btn-row">
          <button type="button" class="btn btn-danger btn-sm" data-act="delete-item" data-id="${id}">Delete</button>
          <span class="spacer"></span>
          <button type="button" class="btn btn-ghost btn-sm" data-act="cancel-edit">Cancel</button>
          <button type="submit" class="btn btn-primary btn-sm">Save</button>
        </div>
      </form>
    </li>`;
}

function addItemHTML() {
  return `
    <form id="addItemForm" class="add-item">
      <input type="text" id="newItemName" maxlength="120" required placeholder="Add an item, e.g. Pumpkin pie" aria-label="Item name">
      <input type="number" id="newItemQuantity" min="1" max="999" value="1" required aria-label="How many needed">
      <button type="submit" class="btn btn-primary">${icon('plus')} Add</button>
      <input type="text" class="full" id="newItemDescription" maxlength="300" placeholder="Note for guests (optional), e.g. gluten-free" aria-label="Item note">
      <div id="addItemErr" class="err full" role="alert"></div>
    </form>
    <p class="add-more"><button type="button" class="linkish" data-act="paste-list">Paste a whole list</button> instead</p>`;
}

// ---------- "You" panel ----------
function pendingNoteHTML() {
  const p = ui.pending && findItem(ui.pending);
  return `<p class="pending" id="pendingNote" ${p ? '' : 'hidden'}>${icon('check')}
    <span>You picked <strong id="pendingName">${p ? esc(p.name) : ''}</strong>. Add your name to save it.</span></p>`;
}

function youCardHTML() {
  const me = view.me;
  const ev = view.event;
  const close = `<button type="button" class="icon-btn sheet-close" data-act="close-sheet" aria-label="Close">${icon('x')}</button>`;

  if (!me && ev.deleting) {
    return `<section class="card you-card" id="youCard">${close}
      <h3 class="card-title">Responses closed</h3>
      <p class="muted">This event is scheduled for deletion.</p></section>`;
  }

  if (!me && ui.signin) {
    return `
      <section class="card you-card" id="youCard" aria-labelledby="youTitle">${close}
        <h3 class="card-title" id="youTitle">Welcome back</h3>
        ${pendingNoteHTML()}
        <form id="loginForm" class="stack">
          <div id="loginError" class="err" role="alert"></div>
          <label class="field"><span>Name or email</span>
            <input type="text" id="loginIdent" required autocomplete="username">
          </label>
          <label class="field"><span>Password</span>
            <input type="password" id="loginPwd" required autocomplete="current-password">
          </label>
          <p class="hint">Responded without a password? Open this link in the browser you used then.</p>
          <div class="btn-row">
            <button type="submit" class="btn btn-primary">Sign in</button>
            <button type="button" class="btn btn-ghost" data-act="join-mode">Back</button>
          </div>
        </form>
      </section>`;
  }

  if (!me) {
    return `
      <section class="card you-card" id="youCard" aria-labelledby="youTitle">${close}
        <h3 class="card-title" id="youTitle">Are you coming?</h3>
        ${pendingNoteHTML()}
        <form id="joinForm" class="stack">
          <div id="joinErr" class="err" role="alert"></div>
          <label class="field"><span>Your name</span>
            <input type="text" id="yesName" maxlength="40" required autocomplete="name" placeholder="e.g. Jane D.">
          </label>
          ${ev.collect_emails ? `
            <label class="field"><span>Email <em>for reminders · only the host sees it</em></span>
              <input type="email" id="yesEmail" maxlength="254" autocomplete="email" placeholder="you@example.com">
            </label>` : ''}
          <label class="field"><span>Password <em>optional</em></span>
            <input type="password" id="yesPwd" maxlength="72" autocomplete="new-password">
          </label>
          <p class="hint">${icon('lock')}<span>${PASSWORD_HINT}</span></p>
          <div id="declineExtra" ${ui.declining ? '' : 'hidden'}>
            <label class="field"><span>Note to the host <em>optional · only they see it</em></span>
              <textarea id="noMsg" maxlength="280" rows="2" placeholder="So sorry, out of town!"></textarea>
            </label>
          </div>
          <div class="btn-row">
            <button type="submit" id="joinYes" value="yes" class="btn btn-primary">I'm going</button>
            <button type="submit" id="joinNo" value="no" class="btn btn-ghost" formnovalidate>${ui.declining ? 'Send: can\'t make it' : 'Can\'t make it'}</button>
          </div>
        </form>
        <p class="small muted" style="margin-top:12px">Already responded? <button type="button" class="linkish" id="chooseAlready" data-act="signin">Sign in</button></p>
      </section>`;
  }

  const mine = view.items.filter((i) => i.mine > 0);
  return `
    <section class="card you-card" id="youCard" aria-label="Your response">${close}
      <div class="you-head">
        <span class="avatar" aria-hidden="true">${esc(me.name.trim().charAt(0).toUpperCase())}</span>
        <p class="you-line">Responding as <strong>${esc(me.name)}</strong>${me.is_host ? ' <span class="tag">Host</span>' : ''}</p>
        <button type="button" class="linkish small" id="signOutBtn" data-act="sign-out">Not you?</button>
      </div>
      ${!me.is_host && !ev.deleting ? `
        <div class="seg" role="group" aria-label="Your RSVP">
          <button type="button" id="rsvpYesBtn" aria-pressed="${me.rsvp === 'yes'}" data-act="rsvp-yes">Going</button>
          <button type="button" id="rsvpNoBtn" aria-pressed="${me.rsvp === 'no'}" data-act="rsvp-no">Can't make it</button>
        </div>
        ${ui.declining && me.rsvp === 'yes' ? `
          <form id="declineForm" class="stack decline">
            <label class="field"><span>Note to the host <em>optional · only they see it</em></span>
              <textarea id="declineMsg" maxlength="280" rows="2" placeholder="So sorry, out of town!"></textarea>
            </label>
            ${mine.length ? `<p class="hint">This frees up your ${plural(mine.length, 'pick')} for others.</p>` : ''}
            <div id="declineErr" class="err" role="alert"></div>
            <div class="btn-row">
              <button type="submit" class="btn btn-danger">Confirm: can't make it</button>
              <button type="button" class="btn btn-ghost" data-act="cancel-decline">Never mind</button>
            </div>
          </form>` : ''}` : ''}
      <h4 class="sub">Your picks</h4>
      ${mine.length
        ? `<ul class="picks">${mine.map((i) => `
            <li><span>${esc(i.name)}</span><span class="muted">× ${Number(i.mine)}</span>
              <button type="button" class="icon-btn" data-act="remove-pick" data-id="${esc(i.id)}" aria-label="Stop bringing ${esc(i.name)}">${icon('x')}</button></li>`).join('')}</ul>`
        : `<p class="muted small">${me.rsvp === 'no' ? 'You said you can\'t make it.' : 'Nothing yet. Tap <strong>I\'ll bring</strong> next to an item.'}</p>`}
      ${emailNudgeHTML()}
      ${pwdNudgeHTML()}
    </section>`;
}

// Host turned on emails after this guest joined.
function emailNudgeHTML() {
  const me = view.me;
  if (!view.event.collect_emails || me.rsvp !== 'yes' || me.email || me.is_host) return '';
  return `
    <form id="emailForm" class="nudge-box">
      <span>The host asked for an email to send reminders. Only they can see it.</span>
      <div class="inline-form">
        <input type="email" id="forceEmail" maxlength="254" required autocomplete="email" placeholder="you@example.com" aria-label="Email">
        <button type="submit" class="btn btn-primary btn-sm">Save</button>
      </div>
      <div id="forceEmailErr" class="err" role="alert"></div>
    </form>`;
}

// when2meet-style: quiet, one line, easy to act on.
function pwdNudgeHTML() {
  const me = view.me;
  if (me.has_password) return '';
  return `
    <div class="nudge" id="pwdNudge">${icon('lock')}
      <div>
        <span>No password yet, so you may lose the ability to ${me.is_host ? 'manage this event' : 'edit your response'} (new device, cleared cookies).
          <button type="button" class="linkish" id="showPwdForm" data-act="show-pwd">Add a password</button></span>
        <form id="pwdForm" class="inline-form" hidden>
          <input type="password" id="newPwd" maxlength="72" autocomplete="new-password" placeholder="4+ characters" aria-label="New password">
          <button type="submit" class="btn btn-primary btn-sm">Save</button>
        </form>
        <div id="pwdErr" class="err" role="alert"></div>
      </div>
    </div>`;
}

// Mobile: a bar pinned to the bottom that summarizes your picks and opens the "you" sheet.
function mineBarHTML() {
  const me = view.me;
  if (!me && view.event.deleting) return '';
  let text;
  let btn;
  if (!me) {
    const p = ui.pending && findItem(ui.pending);
    text = p ? `Picked <strong>${esc(p.name)}</strong>. Add your name.` : 'Coming? Add your name.';
    btn = 'RSVP';
  } else {
    const mine = view.items.filter((i) => i.mine > 0);
    text = mine.length
      ? `Bringing <strong>${mine.map((i) => `${esc(i.name)} ×${Number(i.mine)}`).join(', ')}</strong>`
      : me.rsvp === 'no' ? 'You can\'t make it' : 'Nothing picked yet';
    btn = me.is_host ? 'You' : me.rsvp === 'no' ? 'Change' : 'You';
  }
  return `
    <div class="mine-bar" id="mineBar">
      <span class="mine-text">${text}</span>
      <button type="button" class="btn btn-primary btn-sm" data-act="open-sheet">${btn}</button>
    </div>`;
}

function openSheet() {
  if (!isMobile()) { $('youCard')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); return; }
  document.body.classList.add('sheet-open');
}
function closeSheet() { document.body.classList.remove('sheet-open'); }

// ---------- Host: guests ----------
function guestsCardHTML() {
  const guests = view.guests || [];
  const yes = guests.filter((g) => g.rsvp === 'yes');
  const no = guests.filter((g) => g.rsvp === 'no');
  const emails = yes.map((g) => g.email).filter(Boolean);
  const brings = (name) => view.items
    .flatMap((i) => i.who.filter((w) => w.name === name).map((w) => `${i.name} ×${w.qty}`));

  const row = (g, declined) => {
    const b = declined ? [] : brings(g.name);
    return `
      <li>
        <div class="guest-main">
          <span><strong>${esc(g.name)}</strong>${g.name === view.event.host ? ' <span class="tag">Host</span>' : ''}</span>
          ${!declined ? `<span class="guest-brings">${b.length ? esc(b.join(', ')) : '<span class="muted">Nothing picked yet</span>'}</span>` : ''}
          ${g.email ? `<span class="muted small">${esc(g.email)}</span>` : ''}
          ${declined && g.message ? `<span class="quote">“${esc(g.message)}”</span>` : ''}
          ${declined && g.responded_at ? `<span class="muted small">${esc(new Date(g.responded_at).toLocaleDateString([], { month: 'short', day: 'numeric' }))}</span>` : ''}
        </div>
        ${g.name === view.event.host ? '' : `<button type="button" class="icon-btn" data-act="remove-guest" data-remove-guest="${esc(g.name)}" aria-label="Remove ${esc(g.name)}">${icon('x')}</button>`}
      </li>`;
  };

  return `
    <section class="card guests-card creator-summary" aria-labelledby="guestsTitle">
      <div class="card-head">
        <h3 id="guestsTitle">Guests</h3>
        <span class="count">${yes.length} going${no.length ? ` · ${no.length} can't` : ''}</span>
      </div>
      <ul class="guest-list">${yes.map((g) => row(g, false)).join('')}</ul>
      ${no.length ? `<h4 class="sub">Can't make it</h4><ul class="guest-list">${no.map((g) => row(g, true)).join('')}</ul>` : ''}
      ${emails.length ? `<p class="small" style="margin-top:10px"><button type="button" class="linkish" data-act="copy-emails">Copy ${plural(emails.length, 'email')}</button></p>` : ''}
    </section>`;
}

// ----------------------
// 3. Actions
// ----------------------
// Run a mutation that returns a fresh view; report errors as a toast.
async function mutate(fn) {
  try { apply(await fn()); }
  catch (err) { toast(errMsg(err), 'error'); }
}

async function submitWith(form, errId, fn) {
  const btns = form.querySelectorAll('button');
  showErr(errId, '');
  btns.forEach((b) => { b.disabled = true; });
  try { apply(await fn()); }
  catch (err) { showErr(errId, errMsg(err)); }
  finally { btns.forEach((b) => { b.disabled = false; }); }
}

// After joining or signing in, save the item a visitor tapped before giving their name.
async function afterIdentified(res, claimPending) {
  const pick = claimPending && ui.pending && res.items.find((i) => i.id === ui.pending && i.mine === 0);
  Object.assign(ui, { pending: null, declining: false, signin: false });
  closeSheet();
  if (pick) {
    try { return await rpc('set_commitment', { p_item_id: pick.id, p_qty: 1 }); }
    catch (err) { toast(errMsg(err), 'error'); }
  }
  return res;
}

function handleJoin(form, submitter) {
  const rsvp = submitter?.value === 'no' ? 'no' : 'yes';
  if (rsvp === 'no' && !ui.declining) {
    // First tap on "Can't make it" reveals the optional note.
    ui.declining = true;
    $('declineExtra').hidden = false;
    submitter.textContent = 'Send: can\'t make it';
    $('noMsg').focus();
    return;
  }
  submitWith(form, 'joinErr', async () => {
    const res = await rpc('join_event', {
      p_slug: slug,
      p: {
        name: $('yesName').value,
        email: $('yesEmail')?.value || '',
        password: $('yesPwd').value,
        rsvp,
        message: rsvp === 'no' ? $('noMsg').value : ''
      }
    });
    return afterIdentified(res, rsvp === 'yes');
  });
}

function handleSignIn(form) {
  submitWith(form, 'loginError', async () => {
    const res = await rpc('sign_in', { p_slug: slug, p_ident: $('loginIdent').value, p_password: $('loginPwd').value });
    return afterIdentified(res, true);
  });
}

function bring(id) {
  if (view.me) return setQty(id, 1);
  const item = findItem(id);
  ui.pending = id;
  app.querySelectorAll('.item.is-picked').forEach((li) => li.classList.remove('is-picked'));
  app.querySelector(`.item[data-item="${CSS.escape(id)}"]`)?.classList.add('is-picked');
  if ($('pendingNote')) { $('pendingNote').hidden = false; $('pendingName').textContent = item.name; }
  const bar = $('mineBar');
  if (bar) bar.outerHTML = mineBarHTML();
  openSheet();
  ($('yesName') || $('loginIdent'))?.focus({ preventScroll: true });
}

async function setQty(id, qty) {
  const row = app.querySelector(`.item[data-item="${CSS.escape(id)}"]`);
  row?.classList.add('busy');
  try {
    apply(await rpc('set_commitment', { p_item_id: id, p_qty: qty }));
  } catch (err) {
    row?.classList.remove('busy');
    const box = row?.querySelector('.item-err');
    if (box) box.textContent = errMsg(err);
    else toast(errMsg(err), 'error');
    const input = row?.querySelector('.qty');
    const it = findItem(id);
    if (input && it) input.value = it.mine;
  }
}

function handleAddItem(form) {
  submitWith(form, 'addItemErr', async () => {
    const res = await rpc('host_save_item', {
      p_slug: slug, p_item_id: null,
      p_name: $('newItemName').value,
      p_needed: parseInt($('newItemQuantity').value, 10) || 1,
      p_description: $('newItemDescription').value
    });
    ui.focusAdd = true;
    return res;
  });
}

function saveItemEdit(form) {
  const id = form.dataset.id;
  submitWith(form, `edit-err-${id}`, async () => {
    const res = await rpc('host_save_item', {
      p_slug: slug, p_item_id: id,
      p_name: $(`edit-item-${id}`).value,
      p_needed: parseInt($(`edit-qty-${id}`).value, 10),
      p_description: $(`edit-desc-${id}`).value
    });
    ui.editing = null;
    return res;
  });
}

async function deleteItem(id) {
  const item = findItem(id);
  const who = item?.who.length ? ` ${plural(item.who.length, 'person')} signed up for it will be taken off.` : '';
  if (!(await ask({ title: `Delete "${item?.name}"?`, body: `This can't be undone.${who}`, ok: 'Delete', tone: 'danger' }))) return;
  ui.editing = null;
  mutate(() => rpc('host_delete_item', { p_slug: slug, p_item_id: id }));
}

async function removeGuest(name) {
  if (!(await ask({ title: `Remove ${name}?`, body: 'Anything they signed up to bring will be freed up.', ok: 'Remove', tone: 'danger' }))) return;
  mutate(() => rpc('host_remove_guest', { p_slug: slug, p_name: name }));
}

async function signOut() {
  const hasPwd = view.me.has_password;
  const ok = await ask({
    title: 'Sign out on this browser?',
    body: hasPwd
      ? 'You can sign back in with your name and password.'
      : 'You don\'t have a password, so you won\'t be able to change your response after signing out.',
    ok: 'Sign out',
    tone: hasPwd ? 'primary' : 'danger'
  });
  if (ok) mutate(() => rpc('sign_out', { p_slug: slug }));
}

// Parses lines like "Pie x2", "Rolls, 3", "Napkins (50)" or just "Salad".
function parseItemList(text) {
  return text.split(/\r?\n/).map((line) => {
    const clean = line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim();
    const m = clean.match(/^(.*?)\s*(?:[x×*]\s*(\d{1,3})|,\s*(\d{1,3})|\((\d{1,3})\))\s*$/i);
    const name = (m ? m[1] : clean).trim();
    const needed = m ? parseInt(m[2] || m[3] || m[4], 10) : 1;
    return { name, needed: Math.min(999, Math.max(1, needed || 1)), description: '' };
  }).filter((r) => r.name);
}

function showPasteList() {
  const d = openDialog(`
    <h3 class="card-title">Paste a list</h3>
    <p class="small muted">One item per line. Add a quantity with "x2", ", 2" or "(2)". Items that already exist get their quantity updated.</p>
    <textarea id="pasteList" rows="8" placeholder="Pumpkin pie x2&#10;Dinner rolls, 24&#10;Cranberry sauce&#10;Napkins (50)"></textarea>
    <div id="pasteErr" class="err" role="alert"></div>
    <div class="btn-row end">
      <button type="button" class="btn btn-ghost" id="pasteCancel">Cancel</button>
      <button type="button" class="btn btn-primary" id="pasteSave">Add items</button>
    </div>`);
  d.querySelector('#pasteCancel').onclick = () => d.close();
  d.querySelector('#pasteSave').onclick = async () => {
    const items = parseItemList($('pasteList').value);
    if (!items.length) { showErr('pasteErr', 'Type at least one item.'); return; }
    try {
      const res = await rpc('host_import_items', { p_slug: slug, p_items: items });
      d.close();
      apply(res);
      toast(`Added ${plural(items.length, 'item')}.`);
    } catch (err) { showErr('pasteErr', errMsg(err)); }
  };
  $('pasteList').focus();
}

function showEditEventForm(focusId) {
  const ev = view.event;
  const d = openDialog(`
    <form id="editEventForm" class="stack">
      <h3 class="card-title">Edit event</h3>
      <div id="editErr" class="err" role="alert"></div>
      <label class="field"><span>Event name</span>
        <input type="text" id="editEventName" maxlength="120" required value="${esc(ev.name)}">
      </label>
      <div class="row-2">
        <label class="field"><span>Date</span><input type="date" id="editEventDate" value="${esc(ev.date || '')}"></label>
        <label class="field"><span>Time</span><input type="time" id="editEventTime" value="${esc(ev.time || '')}"></label>
      </div>
      <div class="field">
        <label for="editEventLocation">Location</label>
        <input type="text" id="editEventLocation" maxlength="300" autocomplete="off" value="${esc(ev.location || '')}">
      </div>
      <label class="field"><span>Description</span>
        <textarea id="editEventDescription" maxlength="2000" rows="3">${esc(ev.description || '')}</textarea>
      </label>
      ${linkFieldsHTML('editInviteUrl', 'editScheduleUrl', ev)}
      <label class="check">
        <input type="checkbox" id="editCollectEmails" ${ev.collect_emails ? 'checked' : ''}>
        <span>Ask guests for an email so I can send reminders</span>
      </label>
      <div class="btn-row end">
        <button type="button" class="btn btn-ghost" id="cancelEventEdit">Cancel</button>
        <button type="submit" class="btn btn-primary" id="saveEventChanges">Save</button>
      </div>
    </form>`);

  const loc = { lat: ev.lat ?? '', lng: ev.lng ?? '', place_id: '' };
  attachOSMAutocomplete($('editEventLocation'), (place) => {
    loc.place_id = place.osm_id ? `osm:${place.osm_type}:${place.osm_id}` : '';
    loc.lat = place.lat || ''; loc.lng = place.lon || '';
  });
  $('editEventLocation').addEventListener('input', () => { loc.lat = ''; loc.lng = ''; loc.place_id = ''; });
  $('cancelEventEdit').onclick = () => d.close();
  $('editEventForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const result = await rpc('host_update_event', {
        p_slug: slug,
        p: {
          name: $('editEventName').value,
          description: $('editEventDescription').value,
          date: $('editEventDate').value,
          time: $('editEventTime').value,
          location: $('editEventLocation').value,
          place_id: loc.place_id, lat: String(loc.lat), lng: String(loc.lng),
          collect_emails: $('editCollectEmails').checked,
          invite_url: $('editInviteUrl').value.trim(),
          schedule_url: $('editScheduleUrl').value.trim()
        }
      });
      d.close();
      apply(result);
    } catch (err) {
      showErr('editErr', errMsg(err));
    }
  });
  ($(focusId) || $('editEventName')).focus();
}

async function confirmDeletion(deleting) {
  const ok = await ask(deleting
    ? { title: 'Delete this event?', body: 'It will be permanently removed after 7 days. You can undo until then.', ok: 'Delete', tone: 'danger' }
    : { title: 'Undo deletion?', body: 'This cancels the scheduled deletion and re-opens RSVPs.', ok: 'Undo delete', tone: 'sage' });
  if (ok) mutate(() => rpc('host_set_deleted', { p_slug: slug, p_deleted: deleting }));
}

function sendReminderEmails() {
  const d = openDialog(`
    <h3 class="card-title">Send reminder emails</h3>
    <p class="small muted">Everyone who's going and left an email gets the event details and what they're bringing.</p>
    <label class="field"><span>Note at the top <em>optional</em></span>
      <textarea id="hostMsg" rows="4" maxlength="1000" placeholder="Doors open at 4! Street parking only."></textarea>
    </label>
    <div class="btn-row end">
      <button type="button" class="btn btn-ghost" id="cancelSend">Cancel</button>
      <button type="button" class="btn btn-primary" id="confirmSend">Send</button>
    </div>`);
  d.querySelector('#cancelSend').onclick = () => d.close();
  d.querySelector('#confirmSend').onclick = async () => {
    const hostMsg = $('hostMsg').value.trim().slice(0, 1000);
    d.close();
    const btn = $('sendRemindersBtn');
    if (btn) btn.disabled = true;
    try {
      const { data, error } = await supabase.functions.invoke('send-reminders', { body: { slug, host_message: hostMsg } });
      if (error) {
        let detail = '';
        try { detail = (await error.context?.json())?.error || ''; } catch { /* non-JSON body */ }
        toast(`Couldn't send reminders: ${detail || error.message}`, 'error');
        return;
      }
      if (data?.cooldown_remaining_seconds) {
        const s = data.cooldown_remaining_seconds;
        toast(`Too soon. Try again in ${Math.floor(s / 60)}m ${s % 60}s.`, 'error');
        return;
      }
      toast(`Reminder emails sent: ${data?.sent ?? 0}`);
    } catch (e) {
      console.error('[send-reminders]', e);
      toast('Couldn\'t send reminders. Please try again.', 'error');
    } finally {
      if ($('sendRemindersBtn')) $('sendRemindersBtn').disabled = false;
    }
  };
}

// ----------------------
// CSV export & import
// ----------------------
function csvEscape(v) {
  if (v == null) return '';
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // stop spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function parseCSV(text) {
  const rows = [];
  let i = 0, cur = '', inQ = false, row = [];
  while (i < text.length) {
    const ch = text[i++];
    if (inQ) {
      if (ch === '"') { if (text[i] === '"') { cur += '"'; i++; } else { inQ = false; } }
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i] === '\n') i++;
      row.push(cur); rows.push(row); row = []; cur = '';
    } else cur += ch;
  }
  row.push(cur); rows.push(row);
  const cleaned = rows.filter((r) => r.some((c) => c.trim() !== ''));
  const header = (cleaned.shift() || []).map((h) => h.trim().toLowerCase());
  return { header, rows: cleaned };
}
function exportCSV() {
  const lines = [['item_name', 'quantity_required', 'item_description'].join(',')].concat(
    [...view.items].sort((a, b) => a.name.localeCompare(b.name))
      .map((i) => [csvEscape(i.name), csvEscape(i.needed), csvEscape(i.description ?? '')].join(','))
  );
  download(`${slug || 'event'}-items.csv`, lines.join('\n'), 'text/csv;charset=utf-8;');
}
async function importCSVFile(input) {
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  const { header, rows } = parseCSV(await file.text());
  const col = (...names) => header.findIndex((h) => names.includes(h));
  const idxName = col('item_name', 'name', 'item');
  const idxQty = col('quantity_required', 'quantity', 'qty', 'count');
  const idxDesc = col('item_description', 'description', 'desc');
  if (idxName === -1 || idxQty === -1) { toast('CSV must include headers: item_name and quantity_required.', 'error'); return; }
  const items = rows
    .map((r) => ({
      name: (r[idxName] || '').trim(),
      needed: parseInt(r[idxQty], 10) || 1,
      description: idxDesc !== -1 ? (r[idxDesc] || '').trim() : ''
    }))
    .filter((r) => r.name);
  await mutate(() => rpc('host_import_items', { p_slug: slug, p_items: items }));
}

// ----------------------
// 4. Event wiring (delegated, so re-renders need no re-binding)
// ----------------------
const actions = {
  'copy-link': () => copyText(eventUrl(), 'Link copied. Send it to your guests!'),
  'share': () => navigator.share({ title: view.event.name, text: `What are you bringing to ${view.event.name}?`, url: eventUrl() }).catch(() => {}),
  'copy-blurb': () => copyText(partifulBlurb(), 'Copied! Paste it into your Partiful description or a text blast.'),
  'ics': downloadICS,
  'filter': (el) => { ui.filter = el.dataset.filter; render(); },
  'bring': (el) => bring(el.dataset.id),
  'inc': (el) => setQty(el.dataset.id, findItem(el.dataset.id).mine + 1),
  'dec': (el) => setQty(el.dataset.id, Math.max(0, findItem(el.dataset.id).mine - 1)),
  'remove-pick': (el) => setQty(el.dataset.id, 0),
  'edit-item': (el) => { ui.editing = el.dataset.id; render(); $(`edit-item-${el.dataset.id}`)?.focus(); },
  'cancel-edit': () => { ui.editing = null; render(); },
  'delete-item': (el) => deleteItem(el.dataset.id),
  'paste-list': showPasteList,
  'signin': () => { ui.signin = true; refreshYou(); $('loginIdent')?.focus(); },
  'join-mode': () => { ui.signin = false; refreshYou(); $('yesName')?.focus(); },
  'sign-out': signOut,
  'rsvp-yes': () => { ui.declining = false; if (view.me.rsvp === 'no') mutate(() => rpc('update_me', { p_slug: slug, p: { rsvp: 'yes' } })); else refreshYou(); },
  'rsvp-no': () => { if (view.me.rsvp === 'no') return; ui.declining = true; refreshYou(); $('declineMsg')?.focus(); },
  'cancel-decline': () => { ui.declining = false; refreshYou(); },
  'show-pwd': () => { $('pwdForm').hidden = false; $('newPwd').focus(); },
  'open-sheet': openSheet,
  'close-sheet': closeSheet,
  'edit-event': (el) => showEditEventForm(el.dataset.focus),
  'reminders': sendReminderEmails,
  'export-csv': exportCSV,
  'import-csv': () => $('importCSVInput').click(),
  'delete-event': () => confirmDeletion(true),
  'undelete': () => confirmDeletion(false),
  'remove-guest': (el) => removeGuest(el.dataset.removeGuest),
  'copy-emails': () => copyText((view.guests || []).filter((g) => g.rsvp === 'yes' && g.email).map((g) => g.email).join(', '), 'Emails copied.')
};

const forms = {
  eventForm: createEvent,
  joinForm: handleJoin,
  loginForm: handleSignIn,
  addItemForm: handleAddItem,
  pwdForm: (f) => submitWith(f, 'pwdErr', () => rpc('update_me', { p_slug: slug, p: { password: $('newPwd').value } })),
  emailForm: (f) => submitWith(f, 'forceEmailErr', () => rpc('update_me', { p_slug: slug, p: { email: $('forceEmail').value } })),
  declineForm: (f) => submitWith(f, 'declineErr', async () => {
    const res = await rpc('update_me', { p_slug: slug, p: { rsvp: 'no', message: $('declineMsg').value } });
    ui.declining = false;
    return res;
  })
};

app.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || !app.contains(el) || el.disabled) return;
  const fn = actions[el.dataset.act];
  if (fn) { e.preventDefault(); fn(el); }
});
app.addEventListener('submit', (e) => {
  const fn = forms[e.target.id] || (e.target.matches('.item-edit') ? saveItemEdit : null);
  if (!fn) return;
  e.preventDefault();
  fn(e.target, e.submitter);
});
app.addEventListener('change', (e) => {
  if (e.target.matches('.qty')) {
    const n = Number(e.target.value);
    const it = findItem(e.target.dataset.id);
    if (!Number.isInteger(n) || n < 0 || n > 999) { e.target.value = it?.mine ?? 0; return; }
    if (it && n !== it.mine) setQty(it.id, n);
  } else if (e.target.id === 'importCSVInput') {
    importCSVFile(e.target);
  }
});
app.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('.qty')) { e.preventDefault(); e.target.blur(); }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });
// Close an open "Add to calendar" menu when clicking elsewhere.
document.addEventListener('click', (e) => {
  document.querySelectorAll('details.menu[open]').forEach((m) => { if (!m.contains(e.target)) m.open = false; });
});

// ----------------------
// 5. Routing
// ----------------------
async function route() {
  closeSheet();
  const m = window.location.hash.match(/^#\/event\/([^/?#]+)/);
  if (m) {
    const s = decodeURIComponent(m[1]);
    if (s !== slug) window.scrollTo(0, 0);
    await loadEvent(s);
  } else {
    renderCreateEventForm();
  }
}
window.addEventListener('hashchange', route);
if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', route);
else route();
