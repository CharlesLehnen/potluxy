 // main.js (Google Maps-only link version + email collection)
// Import Supabase client and config
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

// Initialize Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
let currentEvent = null;
let currentUser = null; // Managed via supabase.auth

// ✨ Helpers: UI messaging + username sanitation/validation
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

// Utility: Construct event-specific email from (sanitized) username and event slug.
function constructEmail(username, slug) {
  return `${username}.${slug}@mailinator.com`;
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
    limit: 5,
  });
  const res = await fetch(
    `https://nominatim.openstreetmap.org/search?${params.toString()}`,
    { headers: { 'Accept-Language': 'en' } },
  );
  if (!res.ok) return [];
  return await res.json();
}

// Lightweight autocomplete dropdown under an input.
// onSelect(place) gets called with OSM place object.
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

// Build a Google Maps link for web/mobile from event's location
function buildGoogleMapsUrl(evt) {
  const hasCoords = evt.event_lat && evt.event_lng;
  if (hasCoords) return `https://www.google.com/maps/search/?api=1&query=${evt.event_lat},${evt.event_lng}`;
  if (evt.event_location) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(evt.event_location)}`;
  }
  return null;
}

// time formatter
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
      <br><br>

      <label for="eventDescription">Event Description (optional):</label>
      <textarea id="eventDescription" placeholder="Enter a description..."></textarea>
      <br><br>

      <label for="eventDate">Event Date (optional):</label>
      <input type="date" id="eventDate">
      <br><br>

      <label for="eventTime">Event Time (optional):</label>
      <input type="time" id="eventTime">
      <br><br>

      <label for="eventLocation">Event Location (optional):</label>
      <input type="text" id="eventLocation" placeholder="Start typing an address...">
      <input type="hidden" id="eventLocationPlaceId">
      <input type="hidden" id="eventLocationLat">
      <input type="hidden" id="eventLocationLng">
      <br><br>

      <!-- host chooses if this event collects real emails -->
      <label style="display:flex;gap:.5rem;align-items:center;">
        <input type="checkbox" id="collectEmails">
        Collect attendee emails for reminders (optional)
      </label>
      <p style="font-size:.8rem;color:#666;margin-top:.3rem;">If checked, people joining this event will be required to provide an email.</p>
      <br>

      <label for="username">Your Event Username:</label>
      <input type="text" id="username" required placeholder="e.g., Jane Doe">
      <small style="display:block;color:#666;margin-top:.25rem;">Spaces are allowed. We’ll store them as underscores.</small>
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

// ✨ Robust create flow with inline errors + auto sign-in
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

    // sign up (ignore "already registered" and proceed to sign-in)
    const { error: signUpError } = await supabase.auth.signUp({ email, password: pwd });
    if (signUpError && !/already|registered/i.test(signUpError.message)) {
      setText('eventFormError', `Sign up failed: ${signUpError.message}`);
      show(errBox); btn.disabled = false; return;
    }

    // always try to sign-in (covers the "already registered" case)
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
        created_by: cleanUsername,            // stored
        event_description: eventDescription || null,
        event_date: eventDate || null,
        event_time: eventTime || null,
        event_location: eventLocation || null,
        event_place_id: eventLocationPlaceId || null,
        event_lat: eventLocationLat ? Number(eventLocationLat) : null,
        event_lng: eventLocationLng ? Number(eventLocationLng) : null,
        collect_real_emails: collectEmails,
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

// ✨ Login form with inline error and contextual labels
function renderLoginForm(slug) {
  const requiresEmail = !!currentEvent.collect_real_emails;
  const nameLabel = requiresEmail ? 'Your Name:' : 'Username:';

  const app = document.getElementById('app');
  app.innerHTML = `
    <h2 class="event-title">${currentEvent.event_name}</h2>
    <form id="loginForm" class="form">
      <div id="loginError" style="display:none;color:#b00020;margin:.25rem 0;"></div>

      <label for="username">${nameLabel}</label>
      <input type="text" id="username" required placeholder="e.g., Jane Doe">

      ${
        requiresEmail
          ? `
        <label for="realEmail">Email (required):</label>
        <input type="email" id="realEmail" required placeholder="you@example.com">
        <p style="font-size:.8rem;color:#666;">Host is collecting emails for this event.</p>`
          : `<input type="email" id="realEmail" style="display:none;">`
      }

      <label for="password">Password (optional):</label>
      <input type="password" id="password">
      <button type="submit">Login / Sign Up</button>
    </form>
    <p>If you don't have an account for this event, signing up will create one.</p>
  `;
  document.getElementById('loginForm').addEventListener('submit', (e) => handleLogin(e, slug));
}

async function handleLogin(e, slug) {
  e.preventDefault();
  const errBox = document.getElementById('loginError'); setText('loginError',''); hide(errBox);

  const rawUsername = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value.trim();
  const realEmailInput = document.getElementById('realEmail');
  const realEmail = realEmailInput ? realEmailInput.value.trim() : '';
  const requiresEmail = !!currentEvent.collect_real_emails;

  const usernameErr = validateUsername(rawUsername);
  if (usernameErr) { setText('loginError', usernameErr); show(errBox); return; }
  if (requiresEmail && !realEmail) { setText('loginError', 'Email is required for this event.'); show(errBox); return; }

  const cleanUsername = sanitizeUsername(rawUsername);
  const email = constructEmail(cleanUsername, slug);
  const pwd = password || 'no-password';

  let { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({ email, password: pwd });
  if (signInError) {
    if (/invalid login credentials/i.test(signInError.message)) {
      const { data: signUpData, error: signUpError } = await supabase.auth.signUp({ email, password: pwd });
      if (signUpError && !/already|registered/i.test(signUpError.message)) {
        setText('loginError', `Sign up failed: ${signUpError.message}`); show(errBox); return;
      }
      // try to sign in again
      const { data: signIn2, error: signInErr2 } = await supabase.auth.signInWithPassword({ email, password: pwd });
      if (signInErr2) { setText('loginError', `Sign in failed: ${signInErr2.message}`); show(errBox); return; }
      signInData = signIn2;
    } else {
      setText('loginError', `Sign in failed: ${signInError.message}`); show(errBox); return;
    }
  }

  // ensure event profile exists
  const { data: existingProfile } = await supabase
    .from('event_users')
    .select('*')
    .eq('id', signInData.session.user.id)
    .eq('event_id', currentEvent.id)
    .maybeSingle();

  let finalProfile = existingProfile;

  if (!existingProfile) {
    const { data: newProfile, error: newProfileError } = await supabase
      .from('event_users')
      .insert([{ id: signInData.session.user.id, event_id: currentEvent.id, username: cleanUsername }])
      .select()
      .single();
    if (newProfileError) { setText('loginError', `Error creating event user: ${newProfileError.message}`); show(errBox); return; }
    finalProfile = newProfile;
  }

  if (requiresEmail) {
    const currentEmail = finalProfile.real_email;
    if (!currentEmail && realEmail) {
      const { error: updErr } = await supabase
        .from('event_users')
        .update({ real_email: realEmail })
        .eq('id', finalProfile.id);
      if (updErr) { setText('loginError', `Could not save attendee email: ${updErr.message}`); show(errBox); }
      else { finalProfile.real_email = realEmail; }
    }
  }

  currentUser = finalProfile;
  renderEventDashboard();
}

// ----------------------
// 3. Event Dashboard & Detailed Commitment Display
// ----------------------
async function renderEventDashboard() {
  const app = document.getElementById('app');
  const isCreator = currentUser?.username === currentEvent.created_by;

  const googleMapsUrl = buildGoogleMapsUrl(currentEvent);

  // creator-only email list if collecting
  let emailsHTML = '';
  if (isCreator && currentEvent.collect_real_emails) {
    const { data: attendeeRows } = await supabase
      .from('event_users')
      .select('username, real_email')
      .eq('event_id', currentEvent.id)
      .order('username', { ascending: true });

    emailsHTML = `
      <h4>Attendee Emails</h4>
      <ul>
        ${(attendeeRows || []).filter((r) => r.real_email).map((r) => `<li>${r.username} — ${r.real_email}</li>`).join('')}
      </ul>
    `;
  }

  const eventInfoHTML = `
    <div class="event-info">
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
        ${ isCreator ? `<button id="editEventBtn" type="button">Edit Event</button>
                         <button id="sendRemindersBtn" type="button">Send Email Reminders</button>` : '' }
      </div>
    </div>
  `;

  let itemsSectionHTML = '';
  if (isCreator) {
    const commitmentBreakdownHTML = await renderCommitmentBreakdown();
    itemsSectionHTML = `
      ${emailsHTML}
      <div class="commitment-breakdown">${commitmentBreakdownHTML}</div>

      <h3>Items Needed</h3>

      <!-- CSV actions are always visible for creators -->
      <div class="csv-actions" style="margin:10px 0; display:flex; gap:8px; align-items:center;">
        <button id="exportCSV" type="button">Export CSV</button>
        <button id="importCSV" type="button">Import CSV</button>
        <input id="importCSVInput" type="file" accept=".csv,text/csv" style="display:none" />
      </div>

      ${renderManageItems()}
    `;
  } else {
    itemsSectionHTML = `
      <h3>Items Needed</h3>
      <br><br>
      ${renderViewItems()}
    `;
  }

  const commitmentFormHTML = await renderCommitmentForm();

  app.innerHTML = `
    <h2 class="event-title">${currentEvent.event_name}</h2>
    ${eventInfoHTML}
    <div class="dashboard">
      <div class="items">${itemsSectionHTML}</div>
      <div class="commitments">
        <h3>Your Commitments</h3>
        <br><br>
        ${commitmentFormHTML}
      </div>
    </div>
  `;

  if (isCreator) {
    document.getElementById('addItemForm')?.addEventListener('submit', handleAddItem);

    // CSV
    const exportBtn = document.getElementById('exportCSV');
    const importBtn = document.getElementById('importCSV');
    const fileInput = document.getElementById('importCSVInput');
    exportBtn.addEventListener('click', exportCSV);
    importBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', importCSVFile);

    const editBtn = document.getElementById('editEventBtn');
    if (editBtn) editBtn.addEventListener('click', showEditEventForm);

    const sendBtn = document.getElementById('sendRemindersBtn');
    if (sendBtn) sendBtn.addEventListener('click', sendReminderEmails);
  }

  const copyBtn = document.getElementById('copyShareUrl');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      const url = `${location.origin}/#/event/${currentEvent.slug}`;
      try { await navigator.clipboard.writeText(url); console.log('Copied!'); }
      catch {
        const shareInput = document.getElementById('shareUrl'); shareInput.select(); document.execCommand('copy');
      }
    });
  }

  attachCommitListeners();
  promptForEmailIfRequired(); // NEW
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
        collect_real_emails: collectEmails,
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

// Modified to group commitments into three sections.
async function renderCommitmentForm() {
  const { data: allCommitments } = await supabase
    .from('commitments').select('*').eq('event_id', currentEvent.id);
  const commitmentTotals = {};
  const userCommitments = {};
  (allCommitments || []).forEach((commit) => {
    commitmentTotals[commit.item_id] = (commitmentTotals[commit.item_id] || 0) + commit.quantity;
    if (currentUser && commit.user_id === currentUser.id) userCommitments[commit.item_id] = commit.quantity;
  });

  const committedItems = [];
  const uncommittedItems = [];
  const fullyCommittedItems = [];

  currentEvent.items.forEach((item) => {
    const totalCommitted = commitmentTotals[item.id] || 0;
    const yourCommitment = userCommitments[item.id] ?? 0;
    const remaining = item.quantity_required - totalCommitted;
    const card = `
      <div class="commitment-card">
        <strong style="text-align: center; display: block;">${item.item_name}</strong>
        <div>Required: ${item.quantity_required}</div>
        <div>Total Committed: ${totalCommitted}</div>
        <div>Your Commitment: ${yourCommitment}</div>
        <div>
          <input type="number" id="commit-${item.id}" value="${yourCommitment || 1}" min="1">
          Remaining: ${remaining}
          <button onclick="commitItem('${item.id}')">Commit</button>
        </div>
      </div>
    `;
    if (yourCommitment > 0) committedItems.push(card);
    else if (totalCommitted < item.quantity_required) uncommittedItems.push(card);
    else fullyCommittedItems.push(card);
  });

  let html = '';
  if (committedItems.length) html += "<h4>Items You've Committed To</h4>" + committedItems.join('');
  if (uncommittedItems.length) html += '<h4>Items Still Open (Under-committed)</h4>' + uncommittedItems.join('');
  if (fullyCommittedItems.length) html += '<h4>Items Fully Committed</h4>' + fullyCommittedItems.join('');
  return html;
}

async function renderCommitmentBreakdown() {
  const { data: usersData } = await supabase.from('event_users').select('id, username').eq('event_id', currentEvent.id);
  const userLookup = {};
  (usersData || []).forEach((u) => { if (u?.id) userLookup[u.id] = u.username || 'Unknown'; });

  const { data: breakdownData, error } = await supabase
    .from('commitments').select('quantity, item_id, user_id').eq('event_id', currentEvent.id);
  if (error) return `<p>Error loading commitment breakdown.</p>`;

  const breakdownByItem = {};
  (breakdownData || []).forEach((row) => {
    const itemId = row.item_id;
    const username = row.user_id ? userLookup[row.user_id] || 'Unknown' : 'Unknown';
    if (!breakdownByItem[itemId]) breakdownByItem[itemId] = { lines: [], total: 0 };
    breakdownByItem[itemId].lines.push(`${username}: ${row.quantity}`);
    breakdownByItem[itemId].total += parseInt(row.quantity, 10);
  });

  let html = '<h4>Commitment Breakdown</h4>';
  currentEvent.items.forEach((item) => {
    if (breakdownByItem[item.id]) {
      let warning = '';
      if (breakdownByItem[item.id].total > item.quantity_required ||
          (item.quantity_required == 0 && breakdownByItem[item.id].total > 0)) {
        warning = ` <span style="color:red;font-weight:bold;">OVERCOMMITTED!</span>`;
      }
      html += `<p><strong>${item.item_name}:</strong> ${breakdownByItem[item.id].lines.join(', ')}${warning}</p>`;
    }
  });
  return html;
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
    ...(newItemDescription ? { item_description: newItemDescription } : {}),
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
  const inputEl = document.getElementById(`commit-${itemId}`);
  const quantity = parseInt(inputEl.value, 10);
  if (isNaN(quantity) || quantity <= 0) { alert('Please enter a positive integer.'); return; }

  const { data: itemData, error: itemError } = await supabase
    .from('event_items').select('quantity_required').eq('id', itemId).single();
  if (itemError || !itemData) { alert(`Error fetching item details: ${itemError?.message}`); return; }

  const requiredQuantity = itemData.quantity_required;
  const { data: commitmentsData } = await supabase.from('commitments').select('quantity').eq('item_id', itemId);
  const totalCommitted = (commitmentsData || []).reduce((sum, c) => sum + c.quantity, 0);

  const { data: myCommitData } = await supabase
    .from('commitments').select('quantity').eq('item_id', itemId).eq('user_id', currentUser.id).maybeSingle();
  const myCurrent = myCommitData ? myCommitData.quantity : 0;

  const available = requiredQuantity - (totalCommitted - myCurrent);
  if (quantity > available) { alert(`Cannot commit ${quantity}. Only ${available} slots are available.`); return; }

  const { error } = await supabase
    .from('commitments')
    .upsert([{ event_id: currentEvent.id, user_id: currentUser.id, item_id: itemId, quantity }], { onConflict: ['event_id', 'user_id', 'item_id'] });
  if (error) alert(`Error committing item: ${error.message}`);
  else loadEvent(currentEvent.slug);
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
      collect_real_emails: updatedCollect,
    })
    .eq('id', currentEvent.id);

  if (error) { alert('Error updating event: ' + error.message); return; }
  await loadEvent(currentEvent.slug);
}

// ----------------------
// CSV Export & Import Functionality
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
// 5. Helper: Attach Commit Listeners (stub)
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

  // local 30s button lock as a UI guard (server has the real cooldown)
  const now = Date.now();
  const until = Number(btn.dataset.cooldownUntil || 0);
  if (until && now < until) {
    const secs = Math.ceil((until - now) / 1000);
    alert(`Please wait ${secs}s before trying again.`);
    return;
  }

  btn.disabled = true;
  try {
    const { data, error } = await supabase.functions.invoke('send-reminders', {
      body: { event_id: currentEvent.id }
    });

    if (error) {
      const serverMsg = typeof data?.error === 'string' ? `\nDetails: ${data.error}` : '';
      alert(`Error sending reminders: ${error.message}${serverMsg}`);
      return;
    }

    if (data?.cooldown_remaining_seconds) {
      const s = data.cooldown_remaining_seconds;
      alert(`Too soon. Try again in ${Math.floor(s/60)}m ${s%60}s.`);
      // small local lock to avoid instant retry storm
      btn.dataset.cooldownUntil = String(Date.now() + 15_000);
      return;
    }

    if (Array.isArray(data?.errors) && data.errors.length) {
      console.warn('Per-recipient send errors:', data.errors);
    }

    alert(`Reminder emails attempted. Sent: ${data?.sent ?? 0}`);
  } finally {
    // 30s local lock
    btn.dataset.cooldownUntil = String(Date.now() + 30_000);
    btn.disabled = false;
  }
}



// Expose functions so inline onclick attributes can find them.
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
