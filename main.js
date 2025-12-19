// main.js (Google Maps-only link version + email collection)
// Import Supabase client and config
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

// Initialize Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
let currentEvent = null;
let currentUser = null; // Managed via supabase.auth

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
  `;
  document.head.appendChild(s);
})();

// Helpers
function setText(id, msg) {
  const el = document.getElementById(id);
  if (el) el.textContent = msg || '';
}
function show(el) { el && (el.style.display = 'block'); }
function hide(el) { el && (el.style.display = 'none'); }

// allow spaces; store as underscores; allow letters, numbers, underscores, dashes, periods
function sanitizeUsername(raw) {
  if (!raw) return '';
  const withUnderscores = raw.trim().replace(/\s+/g, '_');
  return withUnderscores.replace(/[^a-zA-Z0-9._-]/g, '_');
}
function validateUsername(raw) {
  if (!raw || raw.trim().length < 2) return 'Please enter a name or username (2+ characters).';
  return null;
}
function constructEmail(username, slug) {
  return `${username}.${slug}@mailinator.com`;
}

// RSVP counts (fallback to rsvps table if present for "no")
async function getRsvpCounts() {
  const c = { yes: 0, no: 0 };

  const { data: eu, error: euErr } = await supabase
    .from('event_users')
    .select('rsvp_status')
    .eq('event_id', currentEvent.id);

  if (!euErr && Array.isArray(eu)) {
    eu.forEach(r => {
      if (r.rsvp_status === 'yes') c.yes++;
      else if (r.rsvp_status === 'no') c.no++;
    });
  }

  try {
    const { data: rs } = await supabase
      .from('rsvps')
      .select('status')
      .eq('event_id', currentEvent.id);
    if (Array.isArray(rs)) c.no += rs.filter(r => r.status === 'no').length;
  } catch { /* optional */ }

  return c;
}


// If there is a pre-existing anonymous RSVP "no" row for this username,
// reassign it to the logged-in user's id so we can flip to "yes" cleanly.
// Works under your eu_upsert_no policy (no secrets needed).
async function mergeAnonNoToUserId(userId, username) {
  await supabase
    .from('event_users')
    .update({ id: userId }) // re-key to the authenticated user
    .eq('event_id', currentEvent.id)
    .eq('username', username)
    .eq('rsvp_status', 'no')
    .eq('wants_reminders', false);
}


// -----------------------------------------------------------------------------
// OpenStreetMap / Nominatim helpers (no API key needed)
// -----------------------------------------------------------------------------
async function osmSearch(query) {
  if (!query || query.length < 3) return [];
  const params = new URLSearchParams({
    q: query,
    format: 'json',
    addressdetails: 1,
    limit: 5
  });
  const res = await fetch(
    `https://nominatim.openstreetmap.org/search?${params.toString()}`,
    { headers: { 'Accept-Language': 'en' } }
  );
  if (!res.ok) return [];
  return await res.json();
}

function attachOSMAutocomplete(inputEl, onSelect) {
  if (!inputEl) return;

  const dropdown = document.createElement('div');
  dropdown.style.position = 'absolute';
  dropdown.style.background = '#fff';
  dropdown.style.border = '1px solid #ccc';
  dropdown.style.zIndex = 1500;
  dropdown.style.width = inputEl.offsetWidth + 'px';
  dropdown.style.maxHeight = '180px';
  dropdown.style.overflowY = 'auto';
  dropdown.style.display = 'none';

  const wrapper = document.createElement('div');
  wrapper.style.position = 'relative';
  inputEl.parentNode.insertBefore(wrapper, inputEl);
  wrapper.appendChild(inputEl);
  wrapper.appendChild(dropdown);

  inputEl.addEventListener('input', async () => {
    const q = inputEl.value.trim();
    if (q.length < 3) { dropdown.style.display = 'none'; return; }
    const results = await osmSearch(q);
    dropdown.innerHTML = '';
    if (!results.length) { dropdown.style.display = 'none'; return; }

    results.forEach((r) => {
      const item = document.createElement('div');
      item.textContent = r.display_name;
      item.style.padding = '6px 8px';
      item.style.cursor = 'pointer';
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
  });

  document.addEventListener('click', (e) => {
    if (!wrapper.contains(e.target)) dropdown.style.display = 'none';
  });
}

function buildGoogleMapsUrl(evt) {
  const hasCoords = evt.event_lat && evt.event_lng;
  if (hasCoords) return `https://www.google.com/maps/search/?api=1&query=${evt.event_lat},${evt.event_lng}`;
  if (evt.event_location) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(evt.event_location)}`;
  }
  return null;
}

function formatEventTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// ----------------------
// 1. Event Creation (for creators)
// ----------------------
async function renderCreateEventForm() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <form id="eventForm" class="form">
      <h2>Create New Event</h2>
      <div id="eventFormError" style="display:none;color:#b00020;margin:.25rem 0;"></div>
      <br>

      <label for="eventName">Event Name:</label>
      <input type="text" id="eventName" required>
      <small style="display:block;color:#666;margin-top:.25rem;">No emojis</small>
      <br><br>

      <label for="eventDescription">Event Description (optional):</label>
      <textarea id="eventDescription" placeholder="Enter a description..."></textarea>
      <small style="display:block;color:#666;margin-top:.25rem;">No emojis</small>
      <br><br>

      <label for="eventDate">Event Date (optional):</label>
      <input type="date" id="eventDate">
      <br><br>

      <label for="eventTime">Event Time (optional):</label>
      <input type="time" id="eventTime">
      <br><br>

      <label for="eventLocation">Event Location (optional):</label>
      <input type="text" id="eventLocation" placeholder="Search by typing an address...">
      <input type="hidden" id="eventLocationPlaceId">
      <input type="hidden" id="eventLocationLat">
      <input type="hidden" id="eventLocationLng">
      <br><br>

      <label style="display:flex;gap:.5rem;align-items:center;">
        <input type="checkbox" id="collectEmails">
        Collect attendee emails for reminders (optional)
      </label>
      <p style="font-size:.8rem;color:#666;margin-top:.3rem;">If checked, people joining this event will be required to provide an email.</p>
      <br>

      <label for="username">Your Name:</label>
      <input type="text" id="username" required placeholder="e.g., Jane Doe">
      <small style="display:block;color:#666;margin-top:.25rem;"></small>
      <br><br>

      <label for="password">Password (optional for editing):</label>
      <input type="password" id="password">
      <br><br>

      <button id="createEventBtn" type="submit">Create Event</button>
    </form>
  `;
  document.getElementById('eventForm').addEventListener('submit', createEvent);

  const locInput = document.getElementById('eventLocation');
  attachOSMAutocomplete(locInput, (place) => {
    document.getElementById('eventLocationPlaceId').value = place.osm_id ? `osm:${place.osm_type}:${place.osm_id}` : '';
    document.getElementById('eventLocationLat').value = place.lat || '';
    document.getElementById('eventLocationLng').value = place.lon || '';
  });
}

function generateSlug(eventName) {
  const uniqueId = Math.random().toString(36).substring(2, 10);
  return eventName.toLowerCase().trim().replace(/\s+/g, '-') + '-' + uniqueId;
}

async function createEvent(e) {
  e.preventDefault();
  const errBox = document.getElementById('eventFormError');
  setText('eventFormError', ''); hide(errBox);
  const btn = document.getElementById('createEventBtn');
  btn.disabled = true;

  try {
    const eventName = document.getElementById('eventName').value.trim();
    const eventDescription = document.getElementById('eventDescription').value.trim();
    const eventDate = document.getElementById('eventDate').value;
    const eventTime = document.getElementById('eventTime').value;
    const eventLocation = document.getElementById('eventLocation').value.trim();
    const eventLocationPlaceId = document.getElementById('eventLocationPlaceId').value.trim();
    const eventLocationLat = document.getElementById('eventLocationLat').value.trim();
    const eventLocationLng = document.getElementById('eventLocationLng').value.trim();
    const collectEmails = document.getElementById('collectEmails').checked;
    const rawUsername = document.getElementById('username').value;
    const password = document.getElementById('password').value.trim();

    const usernameErr = validateUsername(rawUsername);
    if (usernameErr) { setText('eventFormError', usernameErr); show(errBox); btn.disabled = false; return; }

    if (!eventName) { setText('eventFormError', 'Event name is required.'); show(errBox); btn.disabled = false; return; }

    const cleanUsername = sanitizeUsername(rawUsername);
    const slug = generateSlug(eventName);
    const email = constructEmail(cleanUsername, slug);
    const pwd = password || 'no-password';

    const { error: signUpError } = await supabase.auth.signUp({ email, password: pwd });
    if (signUpError && !/already|registered/i.test(signUpError.message)) {
      setText('eventFormError', `Sign up failed: ${signUpError.message}`);
      show(errBox); btn.disabled = false; return;
    }

    const { error: signInErr } = await supabase.auth.signInWithPassword({ email, password: pwd });
    if (signInErr) {
      setText('eventFormError', `Sign in failed: ${signInErr.message}. If your Supabase project requires email confirmations, disable them for this flow or use a server-side admin create.`);
      show(errBox); btn.disabled = false; return;
    }

    const { data: sessionData } = await supabase.auth.getSession();
    if (!sessionData?.session) {
      setText('eventFormError', 'Could not establish a session after sign-in. Check Supabase Auth settings.');
      show(errBox); btn.disabled = false; return;
    }
    const userId = sessionData.session.user.id;

    const { data: eventData, error: eventError } = await supabase
      .from('events')
      .insert([{
        event_name: eventName,
        slug,
        created_by: cleanUsername,
        event_description: eventDescription || null,
        event_date: eventDate || null,
        event_time: eventTime || null,
        event_location: eventLocation || null,
        event_place_id: eventLocationPlaceId || null,
        event_lat: eventLocationLat ? Number(eventLocationLat) : null,
        event_lng: eventLocationLng ? Number(eventLocationLng) : null,
        collect_real_emails: collectEmails
      }])
      .select().single();

    if (eventError) {
      setText('eventFormError', `Error creating event: ${eventError.message}`);
      show(errBox); btn.disabled = false; return;
    }

    const eventId = eventData.id;

    const { data: profileData, error: profileError } = await supabase
      .from('event_users')
      .insert([{ id: userId, event_id: eventId, username: cleanUsername }])
      .select().single();
    if (profileError) {
      setText('eventFormError', `Error creating event user: ${profileError.message}`);
      show(errBox); btn.disabled = false; return;
    }

    currentUser = profileData;
    window.location.hash = `#/event/${slug}`;
    await loadEvent(slug);
  } catch (err) {
    setText('eventFormError', String(err));
    show(errBox);
  } finally {
    btn.disabled = false;
  }
}

// ----------------------
// 2. Event Loading & Login (Per Event)
// ----------------------
async function loadEvent(slug) {
  const { data: eventData, error: eventError } = await supabase
    .from('events')
    .select('*, event_items(*)')
    .eq('slug', slug)
    .single();
  if (eventError || !eventData) {
    console.error('Event not found.');
    renderCreateEventForm();
    return;
  }
  currentEvent = eventData;
  currentEvent.items = eventData.event_items || [];

  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    renderLoginForm(slug);
  } else {
    const { data: profileData } = await supabase
      .from('event_users')
      .select('*')
      .eq('id', session.user.id)
      .eq('event_id', currentEvent.id)
      .maybeSingle();
    if (!profileData) {
      renderLoginForm(slug);
    } else {
      currentUser = profileData;
      renderEventDashboard();
    }
  }
}

// ----------------------
// 2a) Recipient RSVP panel (no pop-ups)
// ----------------------
function renderLoginForm(slug) {
  const requiresEmail = !!currentEvent.collect_real_emails;
  const googleMapsUrl = buildGoogleMapsUrl(currentEvent);

  const app = document.getElementById('app');
  app.innerHTML = `
    <h2 class="event-title">${currentEvent.event_name}</h2>

    <div class="event-info">
      ${currentEvent.event_description ? `<p class="event-description">${currentEvent.event_description}</p>` : ''}
      ${currentEvent.event_date ? `<p class="event-date">Date: ${currentEvent.event_date}</p>` : ''}
      ${currentEvent.event_time ? `<p class="event-time">Time: ${formatEventTime(currentEvent.event_time)}</p>` : ''}
      ${
        currentEvent.event_location
          ? `<p class="event-location">
               Location: ${currentEvent.event_location}
               ${googleMapsUrl ? `(<a href="${googleMapsUrl}" target="_blank" rel="noopener noreferrer">open in Google Maps</a>)` : ''}
             </p>`
          : ''
      }
    </div>

    <div class="form">
      <h3 style="text-align:center">How would you like to respond?</h3>
      <div style="display:flex;gap:8px;justify-content:center;margin-top:10px;">
        <button id="chooseYes" type="button">RSVP Yes</button>
        <button id="chooseNo" type="button">RSVP No</button>
        <button id="chooseAlready" type="button">I already RSVP'd</button>
      </div>
      <p style="text-align:center;color:#666;font-size:.85rem;margin-top:8px;">
        Email will only be required if the host enabled it for this event.
      </p>
    </div>

    <!-- YES -->
    <form id="rsvpYesForm" class="form" style="display:none;">
      <div id="yesErr" style="display:none;color:#b00020;margin:.25rem 0;"></div>
      <label for="yesName">Name</label>
      <input type="text" id="yesName" placeholder="e.g., Jane Doe" required>
      ${
        requiresEmail
          ? `
            <label for="yesEmail">Email (required)</label>
            <input type="email" id="yesEmail" placeholder="you@example.com" required>
            <p style="font-size:.8rem;color:#666;">The host required email for reminders.</p>
            `
          : ''
      }
      <label for="yesPwd">Create a password (optional)</label>
      <input type="password" id="yesPwd" placeholder="Set one if you want to sign back in">

      <button type="submit">Join Event</button>
    </form>

    <!-- NO -->
    <form id="rsvpNoForm" class="form" style="display:none;">
      <div id="noErr" style="display:none;color:#b00020;margin:.25rem 0;"></div>
      <label for="noName">Name</label>
      <input type="text" id="noName" placeholder="e.g., Sam" required>
      <label for="noMsg">Message to host (optional)</label>
      <textarea id="noMsg" placeholder="So sorry—out of town."></textarea>
      <button type="submit" class="login">Send</button>
      <p style="font-size:.85rem;color:#666;margin-top:6px;">Thanks — we’ll let the host know.</p>
    </form>

    <!-- ALREADY -->
    <form id="loginForm" class="form" style="display:none;">
      <div id="loginError" style="display:none;color:#b00020;margin:.25rem 0;"></div>
      <label for="loginIdent">Name or Email</label>
      <input type="text" id="loginIdent" placeholder="Name or Email" required>
      <label for="loginPwd">Password</label>
      <input type="password" id="loginPwd" required>
      <button type="submit" class="login">Log In</button>
    </form>
  `;

  const yesForm = document.getElementById('rsvpYesForm');
  const noForm = document.getElementById('rsvpNoForm');
  const alreadyForm = document.getElementById('loginForm');
  document.getElementById('chooseYes').onclick = () => { yesForm.style.display='block'; noForm.style.display='none'; alreadyForm.style.display='none'; };
  document.getElementById('chooseNo').onclick = () => { yesForm.style.display='none'; noForm.style.display='block'; alreadyForm.style.display='none'; };
  document.getElementById('chooseAlready').onclick = () => { yesForm.style.display='none'; noForm.style.display='none'; alreadyForm.style.display='block'; };

  yesForm.addEventListener('submit', (e) => handleRsvpYes(e, slug));
  noForm.addEventListener('submit', handleRsvpNo);
  alreadyForm.addEventListener('submit', handleReturningLogin);
}

// ----------------------
// 2b) RSVP handlers
// ----------------------
async function handleRsvpYes(e, slug) {
  e.preventDefault();
  const errBox = document.getElementById('yesErr'); setText('yesErr',''); hide(errBox);

  const rawName = document.getElementById('yesName').value.trim();
  const password = document.getElementById('yesPwd').value.trim();
  const requiresEmail = !!currentEvent.collect_real_emails;
  const realEmail = requiresEmail ? document.getElementById('yesEmail').value.trim() : '';

  const nameErr = validateUsername(rawName);
  if (nameErr) { setText('yesErr', nameErr); show(errBox); return; }
  if (requiresEmail && !realEmail) { setText('yesErr', 'Email is required for this event.'); show(errBox); return; }

  const cleanUsername = sanitizeUsername(rawName);
  const aliasEmail = constructEmail(cleanUsername, slug);
  const pwd = password || 'no-password';

  // 1) Sign in (or soft sign-up) with constructed alias email
  let { error: signInErr } = await supabase.auth.signInWithPassword({ email: aliasEmail, password: pwd });
  if (signInErr) {
    const { error: signUpErr } = await supabase.auth.signUp({ email: aliasEmail, password: pwd });
    if (signUpErr && !/already|registered/i.test(signUpErr.message)) {
      setText('yesErr', `Sign up failed: ${signUpErr.message}`); show(errBox); return;
    }
    const { error: signInErr2 } = await supabase.auth.signInWithPassword({ email: aliasEmail, password: pwd });
    if (signInErr2) { setText('yesErr', `Sign in failed: ${signInErr2.message}`); show(errBox); return; }
  }

  const { data: sessionData } = await supabase.auth.getSession();
  if (!sessionData?.session) { setText('yesErr', 'Could not establish a session.'); show(errBox); return; }

  // 2) Claim/flip the username to RSVP 'yes' (handles existing "no" rows)
  const { data: claimed, error: claimErr } = await supabase.rpc('rsvp_yes_claim', {
    p_event_id: currentEvent.id,
    p_username: cleanUsername,
    p_real_email: requiresEmail ? realEmail : null
  });

  if (claimErr) { setText('yesErr', `Could not set RSVP: ${claimErr.message}`); show(errBox); return; }
  if (!claimed) { setText('yesErr', 'Unexpected: claim returned no row.'); show(errBox); return; }

  // 3) Local state → yes; go to dashboard
  currentUser = claimed;
  renderEventDashboard();
}

async function handleRsvpNo(e) {
  e.preventDefault();
  const errBox = document.getElementById('noErr'); setText('noErr',''); hide(errBox);

  const rawName = document.getElementById('noName').value.trim();
  const nameErr = validateUsername(rawName);
  if (nameErr) { setText('noErr', nameErr); show(errBox); return; }
  const cleanUsername = sanitizeUsername(rawName);

  const rawMsg = (document.getElementById('noMsg').value || '').trim();
  const message = rawMsg.slice(0, 280);

  const { data: existing } = await supabase
    .from('event_users')
    .select('id')
    .eq('event_id', currentEvent.id)
    .eq('username', cleanUsername)
    .maybeSingle();

  const nowIso = new Date().toISOString();

  try {
    if (existing?.id) {
      await supabase.from('event_users').update({
        rsvp_status: 'no',
        wants_reminders: false,
        decline_message: message || null,
        decline_at: nowIso
      }).eq('id', existing.id);
    } else {
      const id = (crypto && crypto.randomUUID) ? crypto.randomUUID() : 'decline_' + Math.random().toString(36).slice(2);
      await supabase.from('event_users').insert([{
        id,
        event_id: currentEvent.id,
        username: cleanUsername,
        rsvp_status: 'no',
        wants_reminders: false,
        decline_message: message || null,
        decline_at: nowIso
      }]);
    }
  } catch (error) {
    const msg = String(error?.message || '');
    if (msg.includes('column') || error?.code === '42703') {
      if (existing?.id) {
        await supabase.from('event_users').update({
          rsvp_status: 'no',
          wants_reminders: false
        }).eq('id', existing.id);
      } else {
        const id = (crypto && crypto.randomUUID) ? crypto.randomUUID() : 'decline_' + Math.random().toString(36).slice(2);
        await supabase.from('event_users').insert([{
          id,
          event_id: currentEvent.id,
          username: cleanUsername,
          rsvp_status: 'no',
          wants_reminders: false
        }]);
      }
    } else {
      setText('noErr', `Could not record decline: ${error.message || 'Unknown error'}`); show(errBox); return;
    }
  }

  // BEST-EFFORT fallback table
  try {
    await supabase.from('rsvps').upsert(
      [{ event_id: currentEvent.id, username: cleanUsername, status: 'no', message, created_at: nowIso }],
      { onConflict: ['event_id','username','status'] }
    );
  } catch {}

  // If viewer is signed in for this event, flip them to "no" AND remove commitments
  const { data: sessionData } = await supabase.auth.getSession();
  const userId = sessionData?.session?.user?.id;
  if (userId) {
    try {
      await supabase.from('event_users').update({
        rsvp_status: 'no',
        wants_reminders: false,
        decline_message: message || null,
        decline_at: nowIso
      }).eq('id', userId).eq('event_id', currentEvent.id);
    } catch {
      await supabase.from('event_users').update({
        rsvp_status: 'no',
        wants_reminders: false
      }).eq('id', userId).eq('event_id', currentEvent.id);
    }
    // delete commitments for this user
    try {
      await supabase.from('commitments').delete()
        .eq('event_id', currentEvent.id)
        .eq('user_id', userId);
    } catch {}
  }

  const noForm = document.getElementById('rsvpNoForm');
  if (noForm) noForm.innerHTML = `<p style="color:#1b5e20;">Thanks — we’ve let the host know you can’t make it.</p>`;
}

async function handleReturningLogin(e) {
  e.preventDefault();
  const errBox = document.getElementById('loginError'); setText('loginError',''); hide(errBox);

  const identifier = document.getElementById('loginIdent').value.trim();
  const password = document.getElementById('loginPwd').value.trim();
  if (!identifier) { setText('loginError', 'Enter your name or email.'); show(errBox); return; }
  if (!password) { setText('loginError', 'Please enter your password.'); show(errBox); return; }

  let aliasEmail;
  if (/@/.test(identifier)) {
    const { data: row } = await supabase
      .from('event_users')
      .select('username')
      .eq('event_id', currentEvent.id)
      .ilike('real_email', identifier)
      .maybeSingle();
    if (!row?.username) { setText('loginError', 'No attendee found with that email.'); show(errBox); return; }
    const cleanUsername = sanitizeUsername(row.username);
    aliasEmail = constructEmail(cleanUsername, currentEvent.slug);
  } else {
    const cleanUsername = sanitizeUsername(identifier);
    const ve = validateUsername(cleanUsername);
    if (ve) { setText('loginError', ve); show(errBox); return; }
    aliasEmail = constructEmail(cleanUsername, currentEvent.slug);
  }

  const { data: signInData, error: signInErr } = await supabase.auth.signInWithPassword({ email: aliasEmail, password });
  if (signInErr) { setText('loginError', `Sign in failed: ${signInErr.message}`); show(errBox); return; }

  const userId = signInData.session.user.id;
  const { data: existingProfile } = await supabase
    .from('event_users').select('*').eq('id', userId).eq('event_id', currentEvent.id).maybeSingle();
  if (!existingProfile) {
    const aliasUsername = aliasEmail.split('@')[0].split('.')[0];
    await supabase.from('event_users').insert([{ id: userId, event_id: currentEvent.id, username: aliasUsername }]);
  }

  const { data: profile } = await supabase
    .from('event_users').select('*').eq('id', userId).eq('event_id', currentEvent.id).maybeSingle();

  currentUser = profile || null;
  renderEventDashboard();
}

// ----------------------
// 3. Event Dashboard & Detailed Commitment Display
// ----------------------
async function renderEventDashboard() {
  const app = document.getElementById('app');
  const isCreator = currentUser?.username === currentEvent.created_by;
  const googleMapsUrl = buildGoogleMapsUrl(currentEvent);

  // Canonical deletion flag: delete_requested_at (stop using legacy marked_for_deletion in UI)
  const deletionBanner = currentEvent.delete_requested_at
    ? `<p style="color:#b45309;background:#fffbeb;padding:8px;border:1px solid #f59e0b;border-radius:6px;">
         This event is scheduled for deletion. The host can undo deletion for a limited time.
       </p>`
    : '';

  const eventInfoHTML = `
    <div class="event-info">
      ${deletionBanner}
      ${currentEvent.event_description ? `<p class="event-description">${currentEvent.event_description}</p>` : ''}
      ${currentEvent.event_date ? `<p class="event-date">Date: ${currentEvent.event_date}</p>` : ''}
      ${currentEvent.event_time ? `<p class="event-time">Time: ${formatEventTime(currentEvent.event_time)}</p>` : ''}
      ${
        currentEvent.event_location
          ? `<p class="event-location">Location: ${currentEvent.event_location} ${
              googleMapsUrl ? `(<a href="${googleMapsUrl}" target="_blank" rel="noopener noreferrer">open in Google Maps</a>)` : ''
            }</p>`
          : ''
      }
      <div id="shareUrlContainer">
        <input type="text" id="shareUrl" value="${location.origin}/#/event/${currentEvent.slug}" readonly>
        <button id="copyShareUrl" type="button">Copy URL to Share Event</button>
        ${ isCreator ? `
            <button id="editEventBtn" type="button">Edit Event</button>
            ${ currentEvent.collect_real_emails ? `<button id="sendRemindersBtn" type="button">Send Email Reminders</button>` : '' }
            ${
              currentEvent.delete_requested_at
                ? `<button id="undeleteEventBtn" type="button" style="background:#dcfce7;color:#14532d;">Undo Delete</button>`
                : `<button id="deleteEventBtn" type="button" style="background:#fee2e2;color:#7f1d1d;">Delete Event</button>`
            }
          ` : '' }
      </div>
    </div>
  `;

  const creatorSummaryHTML = isCreator ? await renderCreatorSummaryBox() : '';

  const itemsSectionHTML = isCreator
    ? `
      <h3>Items Needed</h3>
      <div class="csv-actions" style="margin:10px 0; display:flex; gap:8px; align-items:center;">
        <button id="exportCSV" type="button">Export CSV</button>
        <button id="importCSV" type="button">Import CSV</button>
        <input id="importCSVInput" type="file" accept=".csv,text/csv" style="display:none" />
      </div>
      ${renderManageItems()}
    `
    : `
      <h3>Items Needed</h3>
      <br><br>
      ${renderViewItems()}
    `;

  const commitmentFormHTML = await renderCommitmentForm();

  app.innerHTML = `
    <h2 class="event-title">${currentEvent.event_name}</h2>
    ${eventInfoHTML}
    ${creatorSummaryHTML}
    <div class="dashboard">
      <div class="items">${itemsSectionHTML}</div>
      <div class="commitments">
        <h3>Your Commitments</h3>
        <br><br>
        ${commitmentFormHTML}
        <details id="declineInline" style="margin-top:12px;">
          <summary style="cursor:pointer;">Can't make it? RSVP “No”</summary>
          <form id="declineInlineForm" style="margin-top:8px;">
            <label for="declineInlineMsg" style="display:block;margin-bottom:4px;">Message to host (optional)</label>
            <textarea id="declineInlineMsg" rows="3" style="width:100%;"></textarea>
            <div style="margin-top:8px;display:flex;gap:8px;justify-content:flex-end;">
              <button type="submit">Confirm RSVP “No”</button>
            </div>
            <div id="declineInlineErr" style="display:none;color:#b00020;margin-top:.25rem;"></div>
          </form>
        </details>
      </div>
    </div>
  `;

  if (isCreator) {
    document.getElementById('addItemForm')?.addEventListener('submit', handleAddItem);
    document.getElementById('exportCSV')?.addEventListener('click', exportCSV);
    const importBtn = document.getElementById('importCSV');
    const fileInput = document.getElementById('importCSVInput');
    importBtn?.addEventListener('click', () => fileInput.click());
    fileInput?.addEventListener('change', importCSVFile);
    document.getElementById('editEventBtn')?.addEventListener('click', showEditEventForm);
    document.getElementById('sendRemindersBtn')?.addEventListener('click', sendReminderEmails);
    document.getElementById('deleteEventBtn')?.addEventListener('click', confirmDeleteEvent);
    document.getElementById('undeleteEventBtn')?.addEventListener('click', confirmUndeleteEvent);
  }

  document.getElementById('copyShareUrl')?.addEventListener('click', async () => {
    const url = `${location.origin}/#/event/${currentEvent.slug}`;
    try { await navigator.clipboard.writeText(url); }
    catch {
      const shareInput = document.getElementById('shareUrl');
      shareInput.select();
      document.execCommand('copy');
    }
  });

  document.getElementById('declineInlineForm')?.addEventListener('submit', declineFromDashboard);

  attachCommitListeners();
  promptForEmailIfRequired();
}

// ---------- Creator Summary ----------
async function renderCreatorSummaryBox() {
  const counts = await getRsvpCounts();
  const breakdownTable = await renderCommitmentBreakdownTable();
  const yesListHTML = await renderYesList();
  const declinesHTML = await renderDeclinesList();

  return `
    <details open style="margin:14px 0;border:1px solid #e5e7eb;border-radius:10px;background:#fff;">
      <summary style="cursor:pointer;padding:.7rem 1rem;font-weight:600;color:#0f172a">
        Event Summary — <span style="color:#0a5">${counts.yes} going</span> · <span style="color:#a00">${counts.no} no</span>
      </summary>
      <div style="padding:.75rem 1rem 1rem 1rem;">
        ${breakdownTable ? `
          <div style="margin:.5rem 0 1rem 0;">
            <div style="font-weight:600;margin-bottom:.25rem;">Commitment Breakdown</div>
            ${breakdownTable}
          </div>` : ''}

        ${yesListHTML ? `
          <div style="margin:1rem 0;">
            <div style="font-weight:600;margin-bottom:.25rem;">RSVP “Yes”</div>
            ${yesListHTML}
          </div>` : ''}

        ${declinesHTML ? `
          <div style="margin:1rem 0;">
            <div style="font-weight:600;margin-bottom:.25rem;">RSVP “No”</div>
            ${declinesHTML}
          </div>` : ''}
      </div>
    </details>
  `;
}


async function renderYesList() {
  const { data: rows, error } = await supabase
    .from('event_users')
    .select('username, real_email, created_at')
    .eq('event_id', currentEvent.id)
    .eq('rsvp_status', 'yes')
    .order('username', { ascending: true });

  if (error || !rows || rows.length === 0) return '';

  const esc = (s='') => s.replace(/&/g,'&amp;').replace(/</g,'&lt;');
  return `
    <ul style="list-style:none;padding:0;margin:0;">
      ${rows.map(d => `
        <li style="margin:.35rem 0; padding:.4rem .6rem; background:#f8fafc; border:1px solid #eef2f7; border-radius:8px;">
          <strong>${esc(d.username)}</strong>
          ${d.real_email ? ` <span style="color:#64748b;">— ${esc(d.real_email)}</span>` : ''}
        </li>
      `).join('')}
    </ul>
  `;
}


// "RSVP No" list (filters out stale fallback rows when username is not currently "no")
async function renderDeclinesList() {
  let rows = [];
  const noSet = new Set();

  try {
    const { data: eu, error } = await supabase
      .from('event_users')
      .select('username, decline_message, decline_at, created_at, rsvp_status')
      .eq('event_id', currentEvent.id);
    if (!error && Array.isArray(eu)) {
      eu.forEach(r => { if (r.rsvp_status === 'no') noSet.add(String(r.username || '').toLowerCase()); });
      rows.push(
        ...eu
          .filter(r => r.rsvp_status === 'no')
          .map(d => ({
            username: d.username,
            message: d.decline_message,
            ts: d.decline_at || d.created_at
          }))
      );
    }
  } catch {}

  try {
    const { data: rs } = await supabase
      .from('rsvps')
      .select('username, message, created_at, status')
      .eq('event_id', currentEvent.id);
    if (Array.isArray(rs)) {
      rows.push(
        ...rs
          .filter(r => r.status === 'no' && !noSet.has(String(r.username || '').toLowerCase()))
          .map(r => ({ username: r.username, message: r.message, ts: r.created_at }))
      );
    }
  } catch {}

  if (!rows.length) return '';

  rows.sort((a,b) => new Date(b.ts) - new Date(a.ts));
  const esc = (s='') => s.replace(/&/g,'&amp;').replace(/</g,'&lt;');

  return `
    <ul style="list-style:none;padding:0;margin:0;">
      ${rows.map(d => `
        <li style="margin:.5rem 0; padding:.5rem .75rem; background:#fafafa; border:1px solid #eee; border-radius:8px;">
          <strong>${esc(d.username)}</strong>
          ${d.message ? ` — <em>${esc(d.message)}</em>` : ''}
          <div style="color:#666;font-size:.85rem;margin-top:2px;">
            ${new Date(d.ts).toLocaleString()}
          </div>
        </li>
      `).join('')}
    </ul>
  `;
}

// Commitment breakdown table
async function renderCommitmentBreakdownTable() {
  const { data: usersData } = await supabase
    .from('event_users')
    .select('id, username')
    .eq('event_id', currentEvent.id);
  const nameById = Object.fromEntries((usersData || []).map(u => [u.id, u.username]));

  const { data: rows } = await supabase
    .from('commitments')
    .select('quantity, item_id, user_id')
    .eq('event_id', currentEvent.id);

  if (!rows || rows.length === 0) return '';

  const byItem = {};
  rows.forEach(r => {
    const itemId = r.item_id;
    if (!byItem[itemId]) byItem[itemId] = [];
    byItem[itemId].push({ user: nameById[r.user_id] || 'Unknown', qty: Number(r.quantity || 0) });
  });

  const body = currentEvent.items.map(it => {
    const list = byItem[it.id] || [];
    const total = list.reduce((s, r) => s + r.qty, 0);
    const chips = list.map(r => `<span class="pill">${r.user} × ${r.qty}</span>`).join(' ');
    let cls = 'cb-row-open';
    if (total >= it.quantity_required && it.quantity_required > 0) cls = 'cb-row-full';
    else if (total > 0 && total < it.quantity_required) cls = 'cb-row-partial';

    return `
      <tr class="${cls}">
        <td style="padding:10px 12px;">${it.item_name}</td>
        <td style="padding:10px 12px;">${it.quantity_required}</td>
        <td style="padding:10px 12px;">${total}</td>
        <td style="padding:10px 12px;">${chips || '<span style="color:#94a3b8">—</span>'}</td>
      </tr>
    `;
  }).join('');

  return `
    <table style="width:100%; border-collapse:collapse; font-size:14px;">
      <thead class="cb-head">
        <tr>
          <th style="text-align:left; padding:10px 12px;">Item</th>
          <th style="text-align:left; padding:10px 12px;">Required</th>
          <th style="text-align:left; padding:10px 12px;">Total</th>
          <th style="text-align:left; padding:10px 12px;">Who</th>
        </tr>
      </thead>
      <tbody>${body}</tbody>
    </table>
  `;
}

function showEditEventForm() {
  if (!currentUser || currentUser.username !== currentEvent.created_by) return;

  const overlay = document.createElement('div');
  overlay.id = 'editEventOverlay';
  overlay.style.position = 'fixed';
  overlay.style.top = 0; overlay.style.left = 0;
  overlay.style.width = '100%'; overlay.style.height = '100%';
  overlay.style.backgroundColor = 'rgba(0,0,0,0.5)';
  overlay.style.display = 'flex'; overlay.style.alignItems = 'center'; overlay.style.justifyContent = 'center';
  overlay.style.zIndex = 2000;

  const box = document.createElement('div');
  box.style.background = '#fff'; box.style.padding = '20px'; box.style.borderRadius = '8px';
  box.style.maxWidth = '420px'; box.style.width = '90%';

  box.innerHTML = `
    <h3>Edit Event</h3>
    <label>Event Name</label>
    <input type="text" id="editEventName" value="${currentEvent.event_name}" />

    <label style="margin-top:10px;">Event Description</label>
    <textarea id="editEventDescription">${currentEvent.event_description || ''}</textarea>

    <label style="margin-top:10px;">Event Date</label>
    <input type="date" id="editEventDate" value="${currentEvent.event_date || ''}" />

    <label style="margin-top:10px;">Event Time</label>
    <input type="time" id="editEventTime" value="${currentEvent.event_time || ''}" />

    <label style="margin-top:10px;">Event Location</label>
    <input type="text" id="editEventLocation" value="${currentEvent.event_location || ''}" />
    <input type="hidden" id="editEventLocationPlaceId" value="${currentEvent.event_place_id || ''}" />
    <input type="hidden" id="editEventLocationLat" value="${currentEvent.event_lat || ''}" />
    <input type="hidden" id="editEventLocationLng" value="${currentEvent.event_lng || ''}" />

    <label style="margin-top:10px;display:flex;gap:.5rem;align-items:center;">
      <input type="checkbox" id="editCollectEmails" ${currentEvent.collect_real_emails ? 'checked' : ''}>
      Require attendee emails for reminders
    </label>

    <div style="margin-top:15px; text-align:right;">
      <button id="saveEventChanges">Save</button>
      <button id="cancelEventEdit" style="margin-left:8px; background:#ccc; color:#000;">Cancel</button>
    </div>
  `;

  overlay.appendChild(box);
  document.body.appendChild(overlay);

  const editLocInput = document.getElementById('editEventLocation');
  attachOSMAutocomplete(editLocInput, (place) => {
    document.getElementById('editEventLocationPlaceId').value = place.osm_id ? `osm:${place.osm_type}:${place.osm_id}` : '';
    document.getElementById('editEventLocationLat').value = place.lat || '';
    document.getElementById('editEventLocationLng').value = place.lon || '';
  });

  document.getElementById('cancelEventEdit').addEventListener('click', closeEditEventForm);
  document.getElementById('saveEventChanges').addEventListener('click', async () => {
    const newName = document.getElementById('editEventName').value.trim();
    const newDesc = document.getElementById('editEventDescription').value.trim();
    const newDate = document.getElementById('editEventDate').value;
    const newTime = document.getElementById('editEventTime').value;
    const newLoc = document.getElementById('editEventLocation').value.trim();
    const newLocPlaceId = document.getElementById('editEventLocationPlaceId').value.trim();
    const newLocLat = document.getElementById('editEventLocationLat').value.trim();
    const newLocLng = document.getElementById('editEventLocationLng').value.trim();
    const collectEmails = document.getElementById('editCollectEmails').checked;

    const { error } = await supabase
      .from('events')
      .update({
        event_name: newName,
        event_description: newDesc || null,
        event_date: newDate || null,
        event_time: newTime || null,
        event_location: newLoc || null,
        event_place_id: newLocPlaceId || null,
        event_lat: newLocLat ? Number(newLocLat) : null,
        event_lng: newLocLng ? Number(newLocLng) : null,
        collect_real_emails: collectEmails
      })
      .eq('id', currentEvent.id);

    if (error) { alert('Error updating event: ' + error.message); return; }

    closeEditEventForm();
    loadEvent(currentEvent.slug);
  });
}

function closeEditEventForm() {
  const el = document.getElementById('editEventOverlay');
  if (el) el.remove();
}

function renderManageItems() {
  return `
    <div id="itemList">
      ${currentEvent.items.map((item) => `
        <div class="item-card">
          <input type="text" value="${item.item_name}" id="edit-item-${item.id}">
          <input type="number" value="${item.quantity_required}" id="edit-qty-${item.id}" min="1">
          <input type="text" value="${item.item_description || ''}" id="edit-desc-${item.id}" placeholder="Item description (optional)">
          <button onclick="updateItem('${item.id}')">Update</button>
          <button onclick="deleteItem('${item.id}')">Delete</button>
        </div>
      `).join('')}
    </div>
    <form id="addItemForm" class="form">
      <input type="text" id="newItemName" placeholder="Item Name" required>
      <input type="number" id="newItemQuantity" placeholder="Quantity" min="1" required>
      <input type="text" id="newItemDescription" placeholder="Item description (optional)">
      <button type="submit">Add Item</button>
    </form>
  `;
}

function renderViewItems() {
  if (!currentEvent.items || currentEvent.items.length === 0) return `<p>No items listed for this event yet.</p>`;
  return currentEvent.items.map((item) => `
    <div class="item-card">
      <p>${item.item_name} - ${item.quantity_required} needed</p>
      ${item.item_description ? `<p><em>${item.item_description}</em></p>` : ''}
    </div>
  `).join('');
}

// ---------- Commitments UI ----------
async function renderCommitmentForm() {
  const { data: allCommitments } = await supabase
    .from('commitments').select('*').eq('event_id', currentEvent.id);

  const totals = {};
  const mine = {};
  (allCommitments || []).forEach(c => {
    totals[c.item_id] = (totals[c.item_id] || 0) + Number(c.quantity || 0);
    if (currentUser && c.user_id === currentUser.id) mine[c.item_id] = Number(c.quantity || 0);
  });

  const committed = [];
  const open = [];
  const full = [];

  currentEvent.items.forEach(item => {
    const total = totals[item.id] || 0;
    const myQty = mine[item.id] ?? 0;
    const remaining = Math.max(0, item.quantity_required - total);

    const availableForOthers = item.quantity_required - (total - myQty);

    let disabledAttr = '';
    let btnLabel = myQty > 0 ? 'Update' : 'Commit';
    if (availableForOthers <= 0 && myQty === 0) {
      disabledAttr = 'disabled aria-disabled="true" style="opacity:.5;cursor:not-allowed;"';
    }

    const card = `
      <div class="commitment-card" style="border:1px solid #e5e7eb;border-radius:10px;padding:12px;margin:8px 0;background:#fff;">
        <strong style="display:block;text-align:center;margin-bottom:6px;">${item.item_name}</strong>
        <div>Required: ${item.quantity_required}</div>
        <div>Total Committed: ${total}</div>
        <div>Your Commitment: ${myQty}</div>
        <div style="display:flex;gap:8px;align-items:center;margin-top:6px;">
          <input type="number" id="commit-${item.id}" value="${String(myQty ?? 0)}" min="0" style="flex:1;"/>
          <span>Remaining: ${remaining}</span>
          <button id="commitbtn-${item.id}" ${disabledAttr} onclick="commitItem('${item.id}')">${btnLabel}</button>
        </div>
      </div>
    `;

    if (myQty > 0) committed.push(card);
    else if (total < item.quantity_required) open.push(card);
    else full.push(card);
  });

  let html = '';
  if (committed.length) {
    html += `<h4 class="commit-sec-title">Items You’ve Committed To</h4>${committed.join('')}`;
  }
  if (open.length) {
    html += `<div class="sec-divider"></div><h4 class="commit-sec-title open">Items Still Open (Under-committed)</h4>${open.join('')}`;
  }
  if (full.length) {
    html += `<div class="sec-divider"></div><h4 class="commit-sec-title full">Items Fully Committed</h4>${full.join('')}`;
  }
  return html || '<p>No items yet.</p>';
}

// ----------------------
// 4. Item & Commitment Actions
// ----------------------
async function handleAddItem(e) {
  e.preventDefault();
  const newItemName = document.getElementById('newItemName').value.trim();
  const newItemQuantity = parseInt(document.getElementById('newItemQuantity').value, 10);
  const newItemDescription = document.getElementById('newItemDescription').value.trim();
  if (!newItemName || isNaN(newItemQuantity) || newItemQuantity <= 0) {
    alert('Please provide a valid item name and a positive integer for quantity.');
    return;
  }
  const insertData = {
    event_id: currentEvent.id,
    item_name: newItemName,
    quantity_required: newItemQuantity,
    ...(newItemDescription ? { item_description: newItemDescription } : {})
  };
  const { error } = await supabase.from('event_items').insert([insertData]);
  if (error) alert('Error adding item: ' + error.message);
  else loadEvent(currentEvent.slug);
}

async function updateItem(itemId) {
  if (currentUser?.username !== currentEvent.created_by) { alert('Only the event creator can update items.'); return; }
  const newItemName = document.getElementById(`edit-item-${itemId}`).value.trim();
  const newQuantity = parseInt(document.getElementById(`edit-qty-${itemId}`).value, 10);
  const newDescription = document.getElementById(`edit-desc-${itemId}`)?.value.trim();
  if (!newItemName || isNaN(newQuantity) || newQuantity <= 0) { alert('Please provide valid values.'); return; }

  const { data: commitmentsData } = await supabase.from('commitments').select('quantity').eq('item_id', itemId);
  const totalCommitted = (commitmentsData || []).reduce((s, c) => s + c.quantity, 0);
  if (newQuantity < totalCommitted) { alert(`Cannot reduce required quantity to ${newQuantity}. ${totalCommitted} already committed.`); return; }

  const updateData = { item_name: newItemName, quantity_required: newQuantity };
  if (newDescription !== undefined) updateData.item_description = newDescription;

  const { error } = await supabase.from('event_items').update(updateData).eq('id', itemId);
  if (error) alert(`Error updating item: ${error.message}`);
  else loadEvent(currentEvent.slug);
}

async function deleteItem(itemId) {
  if (currentUser?.username !== currentEvent.created_by) { alert('Only the event creator can delete items.'); return; }
  if (!confirm('Are you sure you want to delete this item? This cannot be undone.')) return;
  const { error } = await supabase.from('event_items').delete().eq('id', itemId);
  if (error) alert(`Error deleting item: ${error.message}`);
  else loadEvent(currentEvent.slug);
}

async function commitItem(itemId) {
  if (currentUser?.rsvp_status !== 'yes') {
    alert('You need to RSVP “Yes” to make commitments.');
    return;
  }

  const inputEl = document.getElementById(`commit-${itemId}`);
  const raw = inputEl.value.trim();
  if (raw === '') { alert('Please enter a number (0 or more).'); return; }
  const quantity = Number(raw);
  if (!Number.isInteger(quantity) || quantity < 0) { alert('Please enter a non-negative integer.'); return; }

  const { data: itemData, error: itemErr } = await supabase
    .from('event_items').select('quantity_required').eq('id', itemId).single();
  if (itemErr || !itemData) { alert(`Error fetching item details: ${itemErr?.message}`); return; }
  const required = Number(itemData.quantity_required);

  const { data: all } = await supabase
    .from('commitments')
    .select('user_id, quantity')
    .eq('item_id', itemId);

  const myCurrent = (all || []).find(r => r.user_id === currentUser.id)?.quantity || 0;
  const totalOthers = (all || []).reduce((s, r) => s + (r.user_id === currentUser.id ? 0 : Number(r.quantity || 0)), 0);

  if (quantity > (required - totalOthers)) {
    const available = Math.max(0, required - totalOthers);
    alert(`Cannot commit ${quantity}. Only ${available} slot(s) available.`);
    return;
  }

  if (quantity === 0) {
    await supabase.from('commitments')
      .delete()
      .eq('event_id', currentEvent.id)
      .eq('user_id', currentUser.id)
      .eq('item_id', itemId);
  } else {
    await supabase.from('commitments').upsert([
      { event_id: currentEvent.id, user_id: currentUser.id, item_id: itemId, quantity }
    ], { onConflict: ['event_id', 'user_id', 'item_id'] });
  }

  await loadEvent(currentEvent.slug);
}

// inline decline from dashboard (yes → no) + delete commitments
async function declineFromDashboard(e) {
  e.preventDefault();
  const msgEl = document.getElementById('declineInlineMsg');
  const errEl = document.getElementById('declineInlineErr');
  setText('declineInlineErr',''); hide(errEl);

  if (!currentUser) { alert('Please sign in first.'); return; }

  const nowIso = new Date().toISOString();
  const message = (msgEl.value || '').trim().slice(0, 280);

  const { error: uErr } = await supabase.from('event_users').update({
    rsvp_status: 'no',
    wants_reminders: false,
    decline_message: message || null,
    decline_at: nowIso
  }).eq('id', currentUser.id).eq('event_id', currentEvent.id);
  if (uErr) { setText('declineInlineErr', `Error updating RSVP: ${uErr.message}`); show(errEl); return; }

  await supabase.from('commitments').delete()
    .eq('event_id', currentEvent.id)
    .eq('user_id', currentUser.id);

  await loadEvent(currentEvent.slug);
}

// creator-only update handler (kept in sync with location)
async function handleUpdateEventDetails(e) {
  e.preventDefault();
  const nameEl = document.getElementById('editEventName');
  const descEl = document.getElementById('editEventDescription');
  const dateEl = document.getElementById('editEventDate');
  const timeEl = document.getElementById('editEventTime');
  const locEl = document.getElementById('editEventLocation');
  const locPlaceEl = document.getElementById('editEventLocationPlaceId');
  const locLatEl = document.getElementById('editEventLocationLat');
  const locLngEl = document.getElementById('editEventLocationLng');
  const collectEl = document.getElementById('editCollectEmails');

  const updatedName = nameEl.value.trim();
  const updatedDesc = descEl.value.trim();
  const updatedDate = dateEl.value ? dateEl.value : null;
  const updatedTime = timeEl.value ? timeEl.value : null;
  const updatedLoc = locEl ? locEl.value.trim() : '';
  const updatedLocPlace = locPlaceEl ? locPlaceEl.value.trim() : '';
  const updatedLocLat = locLatEl ? locLatEl.value.trim() : '';
  const updatedLocLng = locLngEl ? locLngEl.value.trim() : '';
  const updatedCollect = collectEl ? collectEl.checked : currentEvent.collect_real_emails;

  if (!updatedName) { alert('Event name is required.'); return; }

  const { error } = await supabase
    .from('events')
    .update({
      event_name: updatedName,
      event_description: updatedDesc || null,
      event_date: updatedDate,
      event_time: updatedTime,
      event_location: updatedLoc || null,
      event_place_id: updatedLocPlace || null,
      event_lat: updatedLocLat ? Number(updatedLocLat) : null,
      event_lng: updatedLocLng ? Number(updatedLocLng) : null,
      collect_real_emails: updatedCollect
    })
    .eq('id', currentEvent.id);

  if (error) { alert('Error updating event: ' + error.message); return; }
  await loadEvent(currentEvent.slug);
}

// ----------------------
// CSV Export & Import
// ----------------------
function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function parseCSV(text) {
  const rows = [];
  let i = 0, cur = '', inQ = false, row = [];
  while (i < text.length) {
    const ch = text[i++];
    if (inQ) {
      if (ch === '"') { if (text[i] === '"') { cur += '"'; i++; } else { inQ = false; } }
      else { cur += ch; }
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ',') { row.push(cur); cur = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i] === '\n') i++;
        row.push(cur); rows.push(row); row = []; cur = '';
      } else { cur += ch; }
    }
  }
  row.push(cur); rows.push(row);
  const cleaned = rows.filter(r => r.some(c => c.trim() !== ''));
  const header = (cleaned.shift() || []).map(h => h.trim().toLowerCase());
  return { header, rows: cleaned };
}
async function exportCSV() {
  if (!currentEvent || currentUser?.username !== currentEvent.created_by) { alert('Only the event creator can export CSV.'); return; }
  const { data: items, error } = await supabase
    .from('event_items')
    .select('item_name, quantity_required, item_description')
    .eq('event_id', currentEvent.id)
    .order('item_name', { ascending: true });
  if (error) { alert('Export failed: ' + error.message); return; }

  const header = ['item_name','quantity_required','item_description'];
  const lines = [header.join(',')].concat(
    (items || []).map(i => [csvEscape(i.item_name), csvEscape(i.quantity_required), csvEscape(i.item_description ?? '')].join(','))
  );
  const csv = lines.join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `${currentEvent.slug || 'event'}-items.csv`; a.click();
  URL.revokeObjectURL(url);
}
async function importCSVFile(evt) {
  const file = evt.target.files?.[0];
  evt.target.value = '';
  if (!file) return;
  if (!currentEvent || currentUser?.username !== currentEvent.created_by) { alert('Only the event creator can import CSV.'); return; }
  const text = await file.text();
  const { header, rows } = parseCSV(text);
  const col = (name, ...alts) => {
    const names = [name, ...alts].map(s => s.toLowerCase());
    return header.findIndex(h => names.includes(h));
  };
  const idxName = col('item_name', 'name', 'item');
  const idxQty  = col('quantity_required', 'quantity', 'qty', 'count');
  const idxDesc = col('item_description', 'description', 'desc');
  if (idxName === -1 || idxQty === -1) { alert('CSV must include headers: item_name and quantity_required.'); return; }

  const { data: existing, error: exErr } = await supabase.from('event_items').select('id, item_name').eq('event_id', currentEvent.id);
  if (exErr) { alert('Import failed: ' + exErr.message); return; }
  const byName = Object.create(null);
  (existing || []).forEach(it => { byName[it.item_name.toLowerCase()] = it; });

  const inserts = [];
  const updates = [];
  rows.forEach(r => {
    const name = (r[idxName] || '').trim();
    if (!name) return;
    const qty = parseInt(r[idxQty], 10) || 0;
    const desc = (idxDesc !== -1 && r[idxDesc]) ? String(r[idxDesc]).trim() : null;
    const match = byName[name.toLowerCase()];
    if (match) updates.push({ id: match.id, item_name: name, quantity_required: qty, item_description: desc });
    else inserts.push({ event_id: currentEvent.id, item_name: name, quantity_required: qty, item_description: desc });
  });

  if (inserts.length) {
    const { error } = await supabase.from('event_items').insert(inserts);
    if (error) { alert('Import (insert) failed: ' + error.message); return; }
  }
  for (const u of updates) {
    const { error } = await supabase.from('event_items')
      .update({ item_name: u.item_name, quantity_required: u.quantity_required, item_description: u.item_description })
      .eq('id', u.id);
    if (error) { alert('Import (update) failed: ' + error.message); return; }
  }
  alert(`Imported ${inserts.length} new item(s), updated ${updates.length} item(s).`);
  await loadEvent(currentEvent.slug);
}

// ----------------------
// 5. Helper: Commit Listeners
// ----------------------
function attachCommitListeners() {
  // Inline onclick handlers in renderCommitmentForm already handle commitments.
}

// NEW: force-prompt for email if host turned it on after user already joined
function promptForEmailIfRequired() {
  if (!currentEvent.collect_real_emails) return;
  if (!currentUser) return;
  if (currentUser.real_email) return;

  const overlay = document.createElement('div');
  overlay.style = 'position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:3000;';
  const box = document.createElement('div');
  box.style = 'background:#fff;padding:20px;border-radius:8px;max-width:360px;width:90%;';
  box.innerHTML = `
    <h3>Email required</h3>
    <p>The host enabled email reminders for this event. Please enter your email.</p>
    <input type="email" id="forceEmail" style="width:100%;margin:10px 0;" placeholder="you@example.com">
    <div style="text-align:right;"><button id="saveEmailBtn">Save</button></div>
  `;
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  document.getElementById('saveEmailBtn').addEventListener('click', async () => {
    const v = document.getElementById('forceEmail').value.trim();
    if (!v) { alert('Email is required.'); return; }
    const { error } = await supabase.from('event_users').update({ real_email: v }).eq('id', currentUser.id);
    if (error) { alert('Could not save email: ' + error.message); return; }
    currentUser.real_email = v; overlay.remove();
  });
}

// NEW: call Supabase Edge Function to send the emails (dashboard invoke)
async function sendReminderEmails() {
  if (currentUser?.username !== currentEvent.created_by) {
    alert('Only the event creator can send reminders.');
    return;
  }

  const btn = document.getElementById('sendRemindersBtn');
  if (!btn) return;

  const now = Date.now();
  const until = Number(btn.dataset.cooldownUntil || 0);
  if (until && now < until) {
    const secs = Math.ceil((until - now) / 1000);
    alert(`Please wait ${secs}s before trying again.`);
    return;
  }

  const overlay = document.createElement('div');
  overlay.style = 'position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:3000;';
  const box = document.createElement('div');
  box.style = 'background:#fff;padding:20px;border-radius:10px;max-width:520px;width:92%;';
  box.innerHTML = `
    <h3 style="margin:0 0 8px">Send reminder emails</h3>
    <p style="margin:0 0 8px;color:#555">
      Optional message to include near the top of the email:
    </p>
    <textarea id="hostMsg" rows="5" style="width:100%;resize:vertical;" placeholder="(Optional) Add a note for attendees..."></textarea>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px;">
      <button id="cancelSend" type="button">Cancel</button>
      <button id="confirmSend" type="button">Send</button>
    </div>
  `;
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  document.getElementById('cancelSend').onclick = () => overlay.remove();

  document.getElementById('confirmSend').onclick = async () => {
    const hostMsg = (document.getElementById('hostMsg').value || '')
      .trim()
      .replace(/\r?\n/g, '\n')
      .slice(0, 1000);

    overlay.remove();
    btn.disabled = true;

    try {
      const { data, error } = await supabase.functions.invoke('send-reminders', {
        body: { event_id: currentEvent.id, host_message: hostMsg }
      });

      if (error) {
        console.error('[send-reminders] invoke error:', error);
        const explanation =
          error.name === 'FunctionsFetchError'
            ? '\n(Network/CORS/blocked request — the function was not reached.)'
            : error.name === 'FunctionsHttpError'
            ? '\n(Edge Function responded with a non-2xx status.)'
            : '';
        const serverMsg =
          typeof data?.error === 'string' ? `\nDetails: ${data.error}` : '';
        alert(`Error sending reminders: ${error.message}${explanation}${serverMsg}`);
        return;
      }

      if (data?.cooldown_remaining_seconds) {
        const s = data.cooldown_remaining_seconds;
        alert(`Too soon. Try again in ${Math.floor(s / 60)}m ${s % 60}s.`);
        btn.dataset.cooldownUntil = String(Date.now() + 15_000);
        return;
      }

      if (Array.isArray(data?.errors) && data.errors.length) {
        console.warn('Per-recipient send errors:', data.errors);
      }

      alert(`Reminder emails attempted. Sent: ${data?.sent ?? 0}`);
    } catch (e) {
      console.error('[send-reminders] unexpected exception:', e);
      alert('Error sending reminders: an unexpected error occurred (see console).');
    } finally {
      btn.dataset.cooldownUntil = String(Date.now() + 30_000);
      btn.disabled = false;
    }
  };
}

// Creator: mark event for deletion (soft delete request)
function confirmDeleteEvent() {
  if (currentUser?.username !== currentEvent.created_by) return;

  const overlay = document.createElement('div');
  overlay.style = 'position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:3000;';
  const box = document.createElement('div');
  box.style = 'background:#fff;padding:20px;border-radius:10px;max-width:480px;width:92%;';
  box.innerHTML = `
    <h3 style="margin:0 0 8px">Delete this event?</h3>
    <p style="margin:0 0 10px;color:#444">This will mark the event for deletion. A server job will remove the event and all associated data.</p>
    <div style="display:flex;gap:8px;justify-content:flex-end;">
      <button id="cancelDelete" type="button">Cancel</button>
      <button id="confirmDelete" type="button" style="background:#b91c1c;color:#fff;">Mark for deletion</button>
    </div>
  `;
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  document.getElementById('cancelDelete').onclick = () => overlay.remove();
  document.getElementById('confirmDelete').onclick = async () => {
    const nowIso = new Date().toISOString();

    let ok = true;
    let errMsg = '';

    // Canonical: set delete_requested_at
    const { error } = await supabase
      .from('events')
      .update({ delete_requested_at: nowIso })
      .eq('id', currentEvent.id);

    if (error) {
      ok = false;
      errMsg = error.message;

      // Optional legacy support (older DBs): try boolean column
      try {
        const { error: legacyErr } = await supabase
          .from('events')
          .update({ marked_for_deletion: true })
          .eq('id', currentEvent.id);
        if (!legacyErr) ok = true;
      } catch { /* ignore */ }
    }

    overlay.remove();

    if (!ok) {
      alert('Could not mark event for deletion: ' + errMsg);
      return;
    }

    // Critical: do NOT invoke immediate purge here, or Undo will be impossible.
    alert('Event has been marked for deletion.');
    await loadEvent(currentEvent.slug);
  };
}

// Creator: undo soft deletion request
function confirmUndeleteEvent() {
  if (currentUser?.username !== currentEvent.created_by) return;

  const overlay = document.createElement('div');
  overlay.style = 'position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:3000;';
  const box = document.createElement('div');
  box.style = 'background:#fff;padding:20px;border-radius:10px;max-width:480px;width:92%;';
  box.innerHTML = `
    <h3 style="margin:0 0 8px">Undo deletion?</h3>
    <p style="margin:0 0 10px;color:#444">
      This will cancel the scheduled deletion and re-enable RSVPs/commitments.
    </p>
    <div style="display:flex;gap:8px;justify-content:flex-end;">
      <button id="cancelUndelete" type="button">Cancel</button>
      <button id="confirmUndelete" type="button" style="background:#166534;color:#fff;">Undo Delete</button>
    </div>
  `;
  overlay.appendChild(box);
  document.body.appendChild(overlay);

  document.getElementById('cancelUndelete').onclick = () => overlay.remove();

  document.getElementById('confirmUndelete').onclick = async () => {
    let ok = true;
    let errMsg = '';

    // Canonical: clear delete_requested_at
    const { error } = await supabase
      .from('events')
      .update({ delete_requested_at: null })
      .eq('id', currentEvent.id);

    if (error) {
      ok = false;
      errMsg = error.message;
    }

    // Optional legacy cleanup (ignore failures)
    if (ok) {
      try {
        await supabase
          .from('events')
          .update({ marked_for_deletion: false })
          .eq('id', currentEvent.id);
      } catch { /* ignore */ }
    }

    overlay.remove();

    if (!ok) {
      alert('Could not undo deletion: ' + errMsg);
      return;
    }

    alert('Deletion cancelled.');
    await loadEvent(currentEvent.slug);
  };
}

// Expose functions for inline handlers
window.updateItem = updateItem;
window.deleteItem = deleteItem;
window.commitItem = commitItem;
window.exportCSV = exportCSV;
window.importCSVFile = importCSVFile;
window.showEditEventForm = showEditEventForm;
window.sendReminderEmails = sendReminderEmails;

// ----------------------
// 6. App Initialization with Hash Routing
// ----------------------
window.addEventListener('DOMContentLoaded', async () => {
  let slug = null;
  if (window.location.hash && window.location.hash.startsWith('#/event/')) {
    slug = window.location.hash.split('#/event/')[1];
  }
  if (slug) await loadEvent(slug);
  else renderCreateEventForm();
});
