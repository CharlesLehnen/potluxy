// main.js — all data access goes through Supabase RPC functions (see code/migrations/).
// The browser never reads tables directly; the server decides what each caller may see.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let slug = null;
let view = null; // result of get_event: { event, items, going, not_going_count, me, guests? }

// --- tiny styles (spacing/dividers + colored table rows) ---
(() => {
  const s = document.createElement('style');
  s.textContent = `
    .commit-sec-title{margin:18px 0 12px;padding-left:10px;border-left:4px solid #0284c7}
    .commit-sec-title.open{border-color:#16a34a}
    .commit-sec-title.full{border-color:#334155}
    .sec-divider{height:1px;background:#e6e8eb;margin:22px 0}
    .pill{display:inline-block;padding:3px 10px;border-radius:999px;border:1px solid #e5e7eb}
    .cb-head{background:#f4f7fb}
    .cb-row-full{background:#eef7ee}
    .cb-row-partial{background:#fff8db}
    .cb-row-open{background:#fdecec}
    .hint{display:block;color:#666;font-size:.8rem;margin-top:.25rem}
    .err{display:none;color:#b00020;margin:.25rem 0}
    .linkish{background:none;border:none;color:#0369a1;text-decoration:underline;cursor:pointer;padding:0;font:inherit}
    .nudge{background:#fffbeb;border:1px solid #fcd34d;border-radius:8px;padding:8px 10px;font-size:.9rem;margin:10px 0}
  `;
  document.head.appendChild(s);
})();

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
  const dropdown = document.createElement('div');
  Object.assign(dropdown.style, {
    position: 'absolute', background: '#fff', border: '1px solid #ccc', zIndex: 1500,
    width: inputEl.offsetWidth + 'px', maxHeight: '180px', overflowY: 'auto', display: 'none'
  });
  const wrapper = document.createElement('div');
  wrapper.style.position = 'relative';
  inputEl.parentNode.insertBefore(wrapper, inputEl);
  wrapper.appendChild(inputEl);
  wrapper.appendChild(dropdown);

  let timer;
  inputEl.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = inputEl.value.trim();
      if (q.length < 3) { dropdown.style.display = 'none'; return; }
      const results = await osmSearch(q);
      dropdown.innerHTML = '';
      if (!results.length) { dropdown.style.display = 'none'; return; }
      results.forEach((r) => {
        const item = document.createElement('div');
        item.textContent = r.display_name;
        Object.assign(item.style, { padding: '6px 8px', cursor: 'pointer' });
        item.addEventListener('click', () => {
          inputEl.value = r.display_name;
          dropdown.style.display = 'none';
          onSelect && onSelect(r);
        });
        item.addEventListener('mouseenter', () => { item.style.background = '#eee'; });
        item.addEventListener('mouseleave', () => { item.style.background = '#fff'; });
        dropdown.appendChild(item);
      });
      dropdown.style.display = 'block';
    }, 350);
  });
  document.addEventListener('click', (e) => { if (!wrapper.contains(e.target)) dropdown.style.display = 'none'; });
}

function buildGoogleMapsUrl(evt) {
  if (evt.lat != null && evt.lng != null) return `https://www.google.com/maps/search/?api=1&query=${Number(evt.lat)},${Number(evt.lng)}`;
  if (evt.location) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(evt.location)}`;
  return null;
}

function formatEventTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

const PASSWORD_HINT = 'Optional. Without a password you can only make changes from this browser.';

// ----------------------
// 1. Event creation
// ----------------------
function renderCreateEventForm() {
  slug = null; view = null;
  $('app').innerHTML = `
    <form id="eventForm" class="form">
      <h2>Create New Event</h2>
      <div id="eventFormError" class="err"></div>
      <br>
      <label for="eventName">Event Name:</label>
      <input type="text" id="eventName" maxlength="120" required>
      <br><br>
      <label for="eventDescription">Event Description (optional):</label>
      <textarea id="eventDescription" maxlength="2000" placeholder="Enter a description..."></textarea>
      <br><br>
      <label for="eventDate">Event Date (optional):</label>
      <input type="date" id="eventDate">
      <br><br>
      <label for="eventTime">Event Time (optional):</label>
      <input type="time" id="eventTime">
      <br><br>
      <label for="eventLocation">Event Location (optional):</label>
      <input type="text" id="eventLocation" maxlength="300" placeholder="Search by typing an address...">
      <input type="hidden" id="eventLocationPlaceId">
      <input type="hidden" id="eventLocationLat">
      <input type="hidden" id="eventLocationLng">
      <br><br>
      <label style="display:flex;gap:.5rem;align-items:center;">
        <input type="checkbox" id="collectEmails">
        Collect attendee emails for reminders (optional)
      </label>
      <p style="font-size:.8rem;color:#666;margin-top:.3rem;">If checked, guests who RSVP yes must enter an email. Only you can see it.</p>
      <br>
      <label for="username">Your Name:</label>
      <input type="text" id="username" maxlength="40" required placeholder="e.g., Jane Doe">
      <br><br>
      <label for="password">Password:</label>
      <input type="password" id="password" maxlength="72" autocomplete="new-password">
      <small class="hint">${PASSWORD_HINT}</small>
      <br>
      <button id="createEventBtn" type="submit">Create Event</button>
    </form>
  `;
  $('eventForm').addEventListener('submit', createEvent);
  attachOSMAutocomplete($('eventLocation'), (place) => {
    $('eventLocationPlaceId').value = place.osm_id ? `osm:${place.osm_type}:${place.osm_id}` : '';
    $('eventLocationLat').value = place.lat || '';
    $('eventLocationLng').value = place.lon || '';
  });
}

async function createEvent(e) {
  e.preventDefault();
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
        collect_emails: $('collectEmails').checked,
        host_name: $('username').value,
        password: $('password').value
      }
    });
    window.location.hash = `#/event/${res.slug}`;
  } catch (err) {
    showErr('eventFormError', errMsg(err));
  } finally {
    btn.disabled = false;
  }
}

// ----------------------
// 2. Loading an event
// ----------------------
async function loadEvent(s) {
  slug = s;
  await ensureSession();
  try {
    view = await rpc('get_event', { p_slug: s });
  } catch (err) {
    console.error('Event not found:', err);
    renderCreateEventForm();
    showErr('eventFormError', 'That event link was not found. You can create a new event below.');
    return;
  }
  render();
}

function render() {
  if (view.me) renderEventDashboard();
  else renderRespondPanel();
}

// Apply a server result (fresh get_event payload) and redraw.
function apply(result) { view = result; render(); }

function eventInfoHTML() {
  const ev = view.event;
  const mapsUrl = buildGoogleMapsUrl(ev);
  return `
    ${ev.description ? `<p class="event-description">${esc(ev.description)}</p>` : ''}
    ${ev.date ? `<p class="event-date">Date: ${esc(ev.date)}</p>` : ''}
    ${ev.time ? `<p class="event-time">Time: ${esc(formatEventTime(ev.time))}</p>` : ''}
    ${ev.location ? `<p class="event-location">Location: ${esc(ev.location)}
        ${mapsUrl ? `(<a href="${esc(mapsUrl)}" target="_blank" rel="noopener noreferrer">open in Google Maps</a>)` : ''}</p>` : ''}
    <p class="event-host">Hosted by ${esc(view.event.host)} · ${view.going.length} going</p>
  `;
}

// ----------------------
// 2a) Not yet responded
// ----------------------
function renderRespondPanel() {
  const ev = view.event;
  const requiresEmail = !!ev.collect_emails;
  const closed = ev.deleting;

  $('app').innerHTML = `
    <h2 class="event-title">${esc(ev.name)}</h2>
    <div class="event-info">${eventInfoHTML()}</div>

    ${closed ? `<p class="nudge">This event is scheduled for deletion and no longer accepts responses.</p>` : `
    <div class="form">
      <h3 style="text-align:center">How would you like to respond?</h3>
      <div style="display:flex;gap:8px;justify-content:center;margin-top:10px;flex-wrap:wrap;">
        <button id="chooseYes" type="button">RSVP Yes</button>
        <button id="chooseNo" type="button">RSVP No</button>
        <button id="chooseAlready" type="button">I already responded</button>
      </div>
    </div>

    <form id="rsvpYesForm" class="form" style="display:none;">
      <div id="yesErr" class="err"></div>
      <label for="yesName">Name</label>
      <input type="text" id="yesName" maxlength="40" placeholder="e.g., Jane Doe" required>
      ${requiresEmail ? `
        <label for="yesEmail">Email (required)</label>
        <input type="email" id="yesEmail" maxlength="254" placeholder="you@example.com" required>
        <small class="hint">The host asked for emails to send reminders. Only the host can see it.</small>` : ''}
      <label for="yesPwd">Password</label>
      <input type="password" id="yesPwd" maxlength="72" autocomplete="new-password">
      <small class="hint">${PASSWORD_HINT}</small>
      <button type="submit">Join Event</button>
    </form>

    <form id="rsvpNoForm" class="form" style="display:none;">
      <div id="noErr" class="err"></div>
      <label for="noName">Name</label>
      <input type="text" id="noName" maxlength="40" placeholder="e.g., Sam" required>
      <label for="noMsg">Message to host (optional, only the host sees it)</label>
      <textarea id="noMsg" maxlength="280" placeholder="So sorry, out of town."></textarea>
      <button type="submit" class="login">Send</button>
    </form>

    <form id="loginForm" class="form" style="display:none;">
      <div id="loginError" class="err"></div>
      <label for="loginIdent">Name or Email</label>
      <input type="text" id="loginIdent" placeholder="Name or Email" required>
      <label for="loginPwd">Password</label>
      <input type="password" id="loginPwd" autocomplete="current-password" required>
      <small class="hint">Responded without a password? Open this link in the browser you used then.</small>
      <button type="submit" class="login">Sign In</button>
    </form>`}

    <div class="items" style="margin-top:16px;">
      <h3>Items Needed</h3>
      ${renderViewItems()}
    </div>
  `;
  if (closed) return;

  const forms = { chooseYes: 'rsvpYesForm', chooseNo: 'rsvpNoForm', chooseAlready: 'loginForm' };
  Object.entries(forms).forEach(([btnId, formId]) => {
    $(btnId).onclick = () => {
      Object.values(forms).forEach((f) => { $(f).style.display = f === formId ? 'block' : 'none'; });
      $(formId).querySelector('input')?.focus();
    };
  });
  $('rsvpYesForm').addEventListener('submit', handleRsvpYes);
  $('rsvpNoForm').addEventListener('submit', handleRsvpNo);
  $('loginForm').addEventListener('submit', handleSignIn);
}

async function submitWith(form, errId, fn) {
  const btn = form.querySelector('button[type="submit"]');
  showErr(errId, '');
  btn.disabled = true;
  try { apply(await fn()); }
  catch (err) { showErr(errId, errMsg(err)); }
  finally { btn.disabled = false; }
}

function handleRsvpYes(e) {
  e.preventDefault();
  submitWith(e.target, 'yesErr', () => rpc('join_event', {
    p_slug: slug,
    p: { name: $('yesName').value, email: $('yesEmail')?.value || '', password: $('yesPwd').value, rsvp: 'yes' }
  }));
}

function handleRsvpNo(e) {
  e.preventDefault();
  submitWith(e.target, 'noErr', () => rpc('join_event', {
    p_slug: slug,
    p: { name: $('noName').value, rsvp: 'no', message: $('noMsg').value }
  }));
}

function handleSignIn(e) {
  e.preventDefault();
  submitWith(e.target, 'loginError', () => rpc('sign_in', {
    p_slug: slug, p_ident: $('loginIdent').value, p_password: $('loginPwd').value
  }));
}

// ----------------------
// 3. Dashboard (responded)
// ----------------------
function renderEventDashboard() {
  const ev = view.event;
  const me = view.me;
  const isHost = me.is_host;

  const deletionBanner = ev.deleting
    ? `<p style="color:#b45309;background:#fffbeb;padding:8px;border:1px solid #f59e0b;border-radius:6px;">
         This event is scheduled for deletion. The host can undo this for 7 days.</p>`
    : '';

  const passwordNudge = !me.has_password ? `
    <div class="nudge" id="pwdNudge">
      You don't have a password, so you can only make changes from this browser.
      <button type="button" class="linkish" id="showPwdForm">Add a password</button>
      <form id="pwdForm" style="display:none;margin-top:6px;gap:6px;flex-wrap:wrap;">
        <input type="password" id="newPwd" maxlength="72" autocomplete="new-password" placeholder="New password (4+ characters)">
        <button type="submit">Save</button>
        <div id="pwdErr" class="err"></div>
      </form>
    </div>` : '';

  $('app').innerHTML = `
    <h2 class="event-title">${esc(ev.name)}</h2>
    <div class="event-info">
      ${deletionBanner}
      ${eventInfoHTML()}
      <p style="font-size:.9rem;color:#475569;">
        Responding as <strong>${esc(me.name)}</strong>${me.rsvp === 'no' ? ' (not going)' : ''} ·
        <button type="button" class="linkish" id="signOutBtn">Not you?</button>
      </p>
      ${passwordNudge}
      <div id="shareUrlContainer">
        <input type="text" id="shareUrl" value="${esc(eventUrl())}" readonly>
        <button id="copyShareUrl" type="button">Copy URL to Share Event</button>
        ${isHost ? `
          <button id="editEventBtn" type="button">Edit Event</button>
          ${ev.collect_emails ? `<button id="sendRemindersBtn" type="button">Send Email Reminders</button>` : ''}
          ${ev.deleting
            ? `<button id="undeleteEventBtn" type="button" style="background:#dcfce7;color:#14532d;">Undo Delete</button>`
            : `<button id="deleteEventBtn" type="button" style="background:#fee2e2;color:#7f1d1d;">Delete Event</button>`}
        ` : ''}
      </div>
    </div>
    ${isHost ? renderHostSummary() : ''}
    <div class="dashboard">
      <div class="items">
        <h3>Items Needed</h3>
        ${isHost ? `
          <div class="csv-actions" style="margin:10px 0; display:flex; gap:8px; align-items:center;">
            <button id="exportCSV" type="button">Export CSV</button>
            <button id="importCSV" type="button">Import CSV</button>
            <input id="importCSVInput" type="file" accept=".csv,text/csv" style="display:none" />
          </div>
          ${renderManageItems()}` : renderViewItems()}
      </div>
      <div class="commitments">
        <h3>Your Commitments</h3>
        <div id="commitErr" class="err"></div>
        ${renderCommitmentForm()}
        ${!isHost && me.rsvp === 'yes' ? `
        <details id="declineInline" style="margin-top:12px;">
          <summary style="cursor:pointer;">Can't make it? RSVP "No"</summary>
          <form id="declineInlineForm" style="margin-top:8px;">
            <label for="declineInlineMsg" style="display:block;margin-bottom:4px;">Message to host (optional)</label>
            <textarea id="declineInlineMsg" rows="3" maxlength="280" style="width:100%;"></textarea>
            <div style="margin-top:8px;display:flex;gap:8px;justify-content:flex-end;">
              <button type="submit">Confirm RSVP "No"</button>
            </div>
            <div id="declineInlineErr" class="err"></div>
          </form>
        </details>` : ''}
        ${me.rsvp === 'no' ? `<p style="margin-top:12px;">Plans changed? <button type="button" class="linkish" id="rsvpYesAgain">Switch to going</button></p>` : ''}
      </div>
    </div>
  `;

  $('signOutBtn').addEventListener('click', signOut);
  $('showPwdForm')?.addEventListener('click', () => { $('pwdForm').style.display = 'flex'; $('newPwd').focus(); });
  $('pwdForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    submitWith(e.target, 'pwdErr', () => rpc('update_me', { p_slug: slug, p: { password: $('newPwd').value } }));
  });
  $('copyShareUrl').addEventListener('click', copyShareUrl);
  $('declineInlineForm')?.addEventListener('submit', (e) => {
    e.preventDefault();
    submitWith(e.target, 'declineInlineErr', () => rpc('update_me', { p_slug: slug, p: { rsvp: 'no', message: $('declineInlineMsg').value } }));
  });
  $('rsvpYesAgain')?.addEventListener('click', () => mutate(() => rpc('update_me', { p_slug: slug, p: { rsvp: 'yes' } })));
  $('app').querySelectorAll('[data-commit]').forEach((b) => b.addEventListener('click', () => commitItem(b.dataset.commit)));

  if (isHost) {
    $('exportCSV').addEventListener('click', exportCSV);
    $('importCSV').addEventListener('click', () => $('importCSVInput').click());
    $('importCSVInput').addEventListener('change', importCSVFile);
    $('editEventBtn').addEventListener('click', showEditEventForm);
    $('sendRemindersBtn')?.addEventListener('click', sendReminderEmails);
    $('deleteEventBtn')?.addEventListener('click', () => confirmDeletion(true));
    $('undeleteEventBtn')?.addEventListener('click', () => confirmDeletion(false));
    $('addItemForm')?.addEventListener('submit', handleAddItem);
    $('app').querySelectorAll('[data-update-item]').forEach((b) => b.addEventListener('click', () => updateItem(b.dataset.updateItem)));
    $('app').querySelectorAll('[data-delete-item]').forEach((b) => b.addEventListener('click', () => deleteItem(b.dataset.deleteItem)));
    $('app').querySelectorAll('[data-remove-guest]').forEach((b) => b.addEventListener('click', () => removeGuest(b.dataset.removeGuest)));
  }

  promptForEmailIfRequired();
}

// Run a mutation that returns a fresh view; report errors with alert.
async function mutate(fn) {
  try { apply(await fn()); }
  catch (err) { alert(errMsg(err)); }
}

async function copyShareUrl() {
  try { await navigator.clipboard.writeText(eventUrl()); }
  catch { $('shareUrl').select(); document.execCommand('copy'); }
}

async function signOut() {
  const warn = view.me.has_password
    ? 'Sign out of this event on this browser? You can sign back in with your name and password.'
    : 'You have no password, so after signing out you will NOT be able to change your response again. Continue?';
  if (!confirm(warn)) return;
  await mutate(() => rpc('sign_out', { p_slug: slug }));
}

// ---------- Host summary ----------
function renderHostSummary() {
  const guests = view.guests || [];
  const yes = guests.filter((g) => g.rsvp === 'yes');
  const no = guests.filter((g) => g.rsvp === 'no');
  const removeBtn = (g) => g.name === view.event.host ? '' :
    ` <button type="button" class="linkish" style="font-size:.8rem;color:#991b1b" data-remove-guest="${esc(g.name)}">remove</button>`;

  return `
    <details open class="creator-summary" style="margin:14px 0;border:1px solid #e5e7eb;border-radius:10px;background:#fff;">
      <summary style="cursor:pointer;padding:.7rem 1rem;font-weight:600;color:#0f172a">
        Event Summary — <span style="color:#0a5">${yes.length} going</span> · <span style="color:#a00">${no.length} no</span>
      </summary>
      <div style="padding:.75rem 1rem 1rem 1rem;">
        ${view.items.length ? `
          <div style="margin:.5rem 0 1rem 0;">
            <div style="font-weight:600;margin-bottom:.25rem;">Commitment Breakdown</div>
            ${renderBreakdownTable()}
          </div>` : ''}
        ${yes.length ? `
          <div style="margin:1rem 0;">
            <div style="font-weight:600;margin-bottom:.25rem;">RSVP "Yes"</div>
            <ul style="list-style:none;padding:0;margin:0;">
              ${yes.map((g) => `
                <li style="margin:.35rem 0;padding:.4rem .6rem;background:#f8fafc;border:1px solid #eef2f7;border-radius:8px;">
                  <strong>${esc(g.name)}</strong>${g.email ? ` <span style="color:#64748b;">— ${esc(g.email)}</span>` : ''}${removeBtn(g)}
                </li>`).join('')}
            </ul>
          </div>` : ''}
        ${no.length ? `
          <div style="margin:1rem 0;">
            <div style="font-weight:600;margin-bottom:.25rem;">RSVP "No"</div>
            <ul style="list-style:none;padding:0;margin:0;">
              ${no.map((g) => `
                <li style="margin:.5rem 0;padding:.5rem .75rem;background:#fafafa;border:1px solid #eee;border-radius:8px;">
                  <strong>${esc(g.name)}</strong>${g.message ? ` — <em>${esc(g.message)}</em>` : ''}${removeBtn(g)}
                  <div style="color:#666;font-size:.85rem;margin-top:2px;">${esc(new Date(g.responded_at).toLocaleString())}</div>
                </li>`).join('')}
            </ul>
          </div>` : ''}
      </div>
    </details>
  `;
}

function renderBreakdownTable() {
  const rows = view.items.map((it) => {
    const chips = it.who.map((w) => `<span class="pill">${esc(w.name)} × ${Number(w.qty)}</span>`).join(' ');
    let cls = 'cb-row-open';
    if (it.committed >= it.needed) cls = 'cb-row-full';
    else if (it.committed > 0) cls = 'cb-row-partial';
    return `
      <tr class="${cls}">
        <td style="padding:10px 12px;">${esc(it.name)}</td>
        <td style="padding:10px 12px;">${Number(it.needed)}</td>
        <td style="padding:10px 12px;">${Number(it.committed)}</td>
        <td style="padding:10px 12px;">${chips || '<span style="color:#94a3b8">—</span>'}</td>
      </tr>`;
  }).join('');
  return `
    <table style="width:100%; border-collapse:collapse; font-size:14px;">
      <thead class="cb-head"><tr>
        <th style="text-align:left; padding:10px 12px;">Item</th>
        <th style="text-align:left; padding:10px 12px;">Required</th>
        <th style="text-align:left; padding:10px 12px;">Total</th>
        <th style="text-align:left; padding:10px 12px;">Who</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// ---------- Items ----------
function renderManageItems() {
  return `
    <div id="itemList">
      ${view.items.map((item) => `
        <div class="item-card">
          <input type="text" value="${esc(item.name)}" id="edit-item-${esc(item.id)}" maxlength="120">
          <input type="number" value="${Number(item.needed)}" id="edit-qty-${esc(item.id)}" min="1" max="999">
          <input type="text" value="${esc(item.description || '')}" id="edit-desc-${esc(item.id)}" maxlength="300" placeholder="Item description (optional)">
          <button type="button" data-update-item="${esc(item.id)}">Update</button>
          <button type="button" data-delete-item="${esc(item.id)}">Delete</button>
        </div>`).join('')}
    </div>
    <form id="addItemForm" class="form">
      <input type="text" id="newItemName" placeholder="Item Name" maxlength="120" required>
      <input type="number" id="newItemQuantity" placeholder="Quantity" min="1" max="999" required>
      <input type="text" id="newItemDescription" placeholder="Item description (optional)" maxlength="300">
      <button type="submit">Add Item</button>
    </form>
  `;
}

function renderViewItems() {
  if (!view.items.length) return `<p>No items listed for this event yet.</p>`;
  return view.items.map((item) => `
    <div class="item-card">
      <p>${esc(item.name)} — ${Number(item.committed)} of ${Number(item.needed)} covered</p>
      ${item.description ? `<p><em>${esc(item.description)}</em></p>` : ''}
      ${item.who.length ? `<p style="color:#475569;font-size:.85rem;">${item.who.map((w) => `${esc(w.name)} × ${Number(w.qty)}`).join(', ')}</p>` : ''}
    </div>`).join('');
}

function renderCommitmentForm() {
  if (view.me.rsvp !== 'yes') return '<p>You said you can\'t make it.</p>';
  const committed = [], open = [], full = [];
  view.items.forEach((item) => {
    const remaining = Math.max(0, item.needed - item.committed);
    const canCommit = item.needed - (item.committed - item.mine) > 0 || item.mine > 0;
    const card = `
      <div class="commitment-card" style="border:1px solid #e5e7eb;border-radius:10px;padding:12px;margin:8px 0;background:#fff;">
        <strong style="display:block;text-align:center;margin-bottom:6px;">${esc(item.name)}</strong>
        <div>Required: ${Number(item.needed)}</div>
        <div>Total Committed: ${Number(item.committed)}</div>
        <div>Your Commitment: ${Number(item.mine)}</div>
        <div style="display:flex;gap:8px;align-items:center;margin-top:6px;">
          <input type="number" id="commit-${esc(item.id)}" value="${Number(item.mine)}" min="0" max="999" style="flex:1;"/>
          <span>Remaining: ${remaining}</span>
          <button type="button" data-commit="${esc(item.id)}" ${canCommit ? '' : 'disabled aria-disabled="true" style="opacity:.5;cursor:not-allowed;"'}>${item.mine > 0 ? 'Update' : 'Commit'}</button>
        </div>
      </div>`;
    if (item.mine > 0) committed.push(card);
    else if (item.committed < item.needed) open.push(card);
    else full.push(card);
  });
  let html = '';
  if (committed.length) html += `<h4 class="commit-sec-title">Items You've Committed To</h4>${committed.join('')}`;
  if (open.length) html += `<div class="sec-divider"></div><h4 class="commit-sec-title open">Items Still Open (Under-committed)</h4>${open.join('')}`;
  if (full.length) html += `<div class="sec-divider"></div><h4 class="commit-sec-title full">Items Fully Committed</h4>${full.join('')}`;
  return html || '<p>No items yet.</p>';
}

// ----------------------
// 4. Actions
// ----------------------
async function commitItem(itemId) {
  const raw = $(`commit-${itemId}`).value.trim();
  const qty = Number(raw);
  if (raw === '' || !Number.isInteger(qty) || qty < 0) { showErr('commitErr', 'Please enter a whole number (0 or more).'); return; }
  try { apply(await rpc('set_commitment', { p_item_id: itemId, p_qty: qty })); }
  catch (err) { showErr('commitErr', errMsg(err)); }
}

function handleAddItem(e) {
  e.preventDefault();
  mutate(() => rpc('host_save_item', {
    p_slug: slug, p_item_id: null,
    p_name: $('newItemName').value,
    p_needed: parseInt($('newItemQuantity').value, 10),
    p_description: $('newItemDescription').value
  }));
}

function updateItem(itemId) {
  mutate(() => rpc('host_save_item', {
    p_slug: slug, p_item_id: itemId,
    p_name: $(`edit-item-${itemId}`).value,
    p_needed: parseInt($(`edit-qty-${itemId}`).value, 10),
    p_description: $(`edit-desc-${itemId}`).value
  }));
}

function deleteItem(itemId) {
  if (!confirm('Delete this item? Any commitments to it are removed too.')) return;
  mutate(() => rpc('host_delete_item', { p_slug: slug, p_item_id: itemId }));
}

function removeGuest(name) {
  if (!confirm(`Remove ${name} and anything they signed up to bring?`)) return;
  mutate(() => rpc('host_remove_guest', { p_slug: slug, p_name: name }));
}

function overlay(innerHTML) {
  const o = document.createElement('div');
  o.style = 'position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:3000;';
  const box = document.createElement('div');
  box.style = 'background:#fff;padding:20px;border-radius:10px;max-width:480px;width:92%;max-height:90vh;overflow:auto;';
  box.innerHTML = innerHTML;
  o.appendChild(box);
  document.body.appendChild(o);
  return o;
}

function showEditEventForm() {
  const ev = view.event;
  const o = overlay(`
    <h3>Edit Event</h3>
    <div id="editErr" class="err"></div>
    <label>Event Name</label>
    <input type="text" id="editEventName" maxlength="120" value="${esc(ev.name)}" />
    <label style="margin-top:10px;">Event Description</label>
    <textarea id="editEventDescription" maxlength="2000">${esc(ev.description || '')}</textarea>
    <label style="margin-top:10px;">Event Date</label>
    <input type="date" id="editEventDate" value="${esc(ev.date || '')}" />
    <label style="margin-top:10px;">Event Time</label>
    <input type="time" id="editEventTime" value="${esc(ev.time || '')}" />
    <label style="margin-top:10px;">Event Location</label>
    <input type="text" id="editEventLocation" maxlength="300" value="${esc(ev.location || '')}" />
    <label style="margin-top:10px;display:flex;gap:.5rem;align-items:center;">
      <input type="checkbox" id="editCollectEmails" ${ev.collect_emails ? 'checked' : ''}>
      Require attendee emails for reminders
    </label>
    <div style="margin-top:15px; text-align:right;">
      <button id="saveEventChanges">Save</button>
      <button id="cancelEventEdit" style="margin-left:8px; background:#ccc; color:#000;">Cancel</button>
    </div>
  `);

  const loc = { lat: ev.lat ?? '', lng: ev.lng ?? '', place_id: '' };
  attachOSMAutocomplete($('editEventLocation'), (place) => {
    loc.place_id = place.osm_id ? `osm:${place.osm_type}:${place.osm_id}` : '';
    loc.lat = place.lat || ''; loc.lng = place.lon || '';
  });
  $('editEventLocation').addEventListener('input', () => { loc.lat = ''; loc.lng = ''; loc.place_id = ''; });

  $('cancelEventEdit').addEventListener('click', () => o.remove());
  $('saveEventChanges').addEventListener('click', async () => {
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
          invite_url: ev.invite_url || ''
        }
      });
      o.remove();
      apply(result);
    } catch (err) {
      showErr('editErr', errMsg(err));
    }
  });
}

function confirmDeletion(deleting) {
  const o = overlay(deleting ? `
    <h3 style="margin:0 0 8px">Delete this event?</h3>
    <p style="margin:0 0 10px;color:#444">It will be permanently removed after 7 days. You can undo until then.</p>
    <div style="display:flex;gap:8px;justify-content:flex-end;">
      <button id="cancelDel" type="button">Cancel</button>
      <button id="confirmDel" type="button" style="background:#b91c1c;color:#fff;">Delete</button>
    </div>` : `
    <h3 style="margin:0 0 8px">Undo deletion?</h3>
    <p style="margin:0 0 10px;color:#444">This cancels the scheduled deletion and re-opens RSVPs.</p>
    <div style="display:flex;gap:8px;justify-content:flex-end;">
      <button id="cancelDel" type="button">Cancel</button>
      <button id="confirmDel" type="button" style="background:#166534;color:#fff;">Undo Delete</button>
    </div>`);
  $('cancelDel').onclick = () => o.remove();
  $('confirmDel').onclick = async () => {
    o.remove();
    await mutate(() => rpc('host_set_deleted', { p_slug: slug, p_deleted: deleting }));
  };
}

// Host turned on emails after this guest joined.
function promptForEmailIfRequired() {
  const me = view.me;
  if (!view.event.collect_emails || me.rsvp !== 'yes' || me.email || me.is_host) return;
  if ($('emailOverlay')) return;
  const o = overlay(`
    <h3>Email requested</h3>
    <p>The host turned on email reminders for this event. Only the host can see your email.</p>
    <div id="forceEmailErr" class="err"></div>
    <input type="email" id="forceEmail" maxlength="254" style="width:100%;margin:10px 0;" placeholder="you@example.com">
    <div style="text-align:right;display:flex;gap:8px;justify-content:flex-end;">
      <button id="skipEmailBtn" type="button" style="background:#ccc;color:#000;">Not now</button>
      <button id="saveEmailBtn" type="button">Save</button>
    </div>
  `);
  o.id = 'emailOverlay';
  $('skipEmailBtn').onclick = () => o.remove();
  $('saveEmailBtn').onclick = async () => {
    try {
      const result = await rpc('update_me', { p_slug: slug, p: { email: $('forceEmail').value } });
      o.remove();
      apply(result);
    } catch (err) { showErr('forceEmailErr', errMsg(err)); }
  };
}

function sendReminderEmails() {
  const btn = $('sendRemindersBtn');
  const o = overlay(`
    <h3 style="margin:0 0 8px">Send reminder emails</h3>
    <p style="margin:0 0 8px;color:#555">Optional message to include near the top of the email:</p>
    <textarea id="hostMsg" rows="5" maxlength="1000" style="width:100%;resize:vertical;" placeholder="(Optional) Add a note for attendees..."></textarea>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px;">
      <button id="cancelSend" type="button">Cancel</button>
      <button id="confirmSend" type="button">Send</button>
    </div>
  `);
  $('cancelSend').onclick = () => o.remove();
  $('confirmSend').onclick = async () => {
    const hostMsg = $('hostMsg').value.trim().slice(0, 1000);
    o.remove();
    btn.disabled = true;
    try {
      const { data, error } = await supabase.functions.invoke('send-reminders', { body: { slug, host_message: hostMsg } });
      if (error) {
        let detail = '';
        try { detail = (await error.context?.json())?.error || ''; } catch { /* non-JSON body */ }
        alert(`Error sending reminders: ${detail || error.message}`);
        return;
      }
      if (data?.cooldown_remaining_seconds) {
        const s = data.cooldown_remaining_seconds;
        alert(`Too soon. Try again in ${Math.floor(s / 60)}m ${s % 60}s.`);
        return;
      }
      alert(`Reminder emails sent: ${data?.sent ?? 0}`);
    } catch (e) {
      console.error('[send-reminders]', e);
      alert('Error sending reminders. Please try again.');
    } finally {
      btn.disabled = false;
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
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${slug || 'event'}-items.csv`; a.click();
  URL.revokeObjectURL(url);
}
async function importCSVFile(evt) {
  const file = evt.target.files?.[0];
  evt.target.value = '';
  if (!file) return;
  const { header, rows } = parseCSV(await file.text());
  const col = (...names) => header.findIndex((h) => names.includes(h));
  const idxName = col('item_name', 'name', 'item');
  const idxQty = col('quantity_required', 'quantity', 'qty', 'count');
  const idxDesc = col('item_description', 'description', 'desc');
  if (idxName === -1 || idxQty === -1) { alert('CSV must include headers: item_name and quantity_required.'); return; }
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
// 5. Routing
// ----------------------
async function route() {
  const m = window.location.hash.match(/^#\/event\/([^/?#]+)/);
  if (m) await loadEvent(decodeURIComponent(m[1]));
  else renderCreateEventForm();
}
window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', route);
