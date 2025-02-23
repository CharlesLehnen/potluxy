// Import Supabase client and config
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

// Initialize Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
let currentEvent = null;
let currentUser = JSON.parse(localStorage.getItem('currentUser')) || null;

// ----------------------
// 1. Event Creation (for creators)
// ----------------------
function renderCreateEventForm() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <form id="eventForm">
      <h2>Create New Event</h2>
      <label for="eventName">Event Name:</label>
      <input type="text" id="eventName" required>
      <label for="username">Your Event Username:</label>
      <input type="text" id="username" required>
      <label for="password">Password (optional for editing):</label>
      <input type="password" id="password">
      <button type="submit">Create Event</button>
    </form>
  `;
  document.getElementById('eventForm').addEventListener('submit', createEvent);
}

function generateSlug(eventName) {
  const uniqueId = Math.random().toString(36).substring(2, 10);
  return eventName.toLowerCase().replace(/\s+/g, '-') + '-' + uniqueId;
}

async function hashPassword(password) {
  if (!password) return null;
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function createEvent(e) {
  e.preventDefault();
  const eventNameInput = document.getElementById('eventName');
  const usernameInput = document.getElementById('username');
  const passwordInput = document.getElementById('password');

  if (!eventNameInput || !usernameInput) {
    alert('Missing required form fields.');
    return;
  }

  const eventName = eventNameInput.value.trim();
  const username = usernameInput.value.trim();
  const password = passwordInput?.value.trim() || '';

  if (!eventName || !username) {
    alert('Event name and username are required.');
    return;
  }

  const slug = generateSlug(eventName);
  const passwordHash = password ? await hashPassword(password) : null;

  try {
    // Create the event
    const { data: eventData, error: eventError } = await supabase
      .from('events')
      .insert([{ event_name: eventName, slug, created_by: username }])
      .select()
      .single();
    if (eventError) throw new Error(`Error creating event: ${eventError.message}`);
    const eventId = eventData.id;

    // Create the event creator's user record (and retrieve the full record)
    const { data: newUser, error: userError } = await supabase
      .from('users')
      .insert([{ event_id: eventId, username, password_hash: passwordHash }])
      .select()
      .single();
    if (userError) throw new Error(`Error creating user: ${userError.message}`);
    currentUser = newUser;
    localStorage.setItem('currentUser', JSON.stringify(currentUser));

    alert(`Event created successfully! Share this link: ${location.origin}/event/${slug}`);
    window.history.pushState({}, '', `/event/${slug}`);
    loadEvent(slug);
  } catch (error) {
    console.error(error);
    alert(error.message || 'Failed to create the event.');
  }
}

// ----------------------
// 2. Event Loading & Guest Login
// ----------------------
async function loadEvent(slug) {
  const { data: eventData, error: eventError } = await supabase
    .from('events')
    .select('*, event_items(*)')
    .eq('slug', slug)
    .single();
  if (eventError || !eventData) {
    alert('Event not found.');
    renderCreateEventForm();
    return;
  }
  currentEvent = eventData;
  currentEvent.items = eventData.event_items || [];
  // If no user is logged in, show the login form for guests.
  if (!currentUser) {
    renderLoginForm();
  } else {
    await renderEventDashboard();
  }
}

function renderLoginForm() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <h2>${currentEvent.event_name}</h2>
    <form id="loginForm">
      <label for="username">Username:</label>
      <input type="text" id="username" required>
      <label for="password">Password (if set):</label>
      <input type="password" id="password">
      <button type="submit">Login / Sign Up</button>
    </form>
    <p>If you don't have an account for this event, signing up will create one.</p>
  `;
  document.getElementById('loginForm').addEventListener('submit', handleLogin);
}

async function handleLogin(e) {
  e.preventDefault();
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value.trim();
  const passwordHash = password ? await hashPassword(password) : null;

  const { data: userData, error: userError } = await supabase
    .from('users')
    .select('*')
    .eq('event_id', currentEvent.id)
    .eq('username', username)
    .single();

  if (userData) {
    if (userData.password_hash && userData.password_hash !== passwordHash) {
      alert('Incorrect password.');
      return;
    }
    currentUser = userData;
    localStorage.setItem('currentUser', JSON.stringify(currentUser));
    await renderEventDashboard();
  } else {
    // Create a new user if one doesn't exist.
    const { data: newUser, error: newUserError } = await supabase
      .from('users')
      .insert([{ event_id: currentEvent.id, username, password_hash: passwordHash }])
      .select()
      .single();
    if (newUserError) {
      alert(`Error signing up: ${newUserError.message}`);
      return;
    }
    currentUser = newUser;
    localStorage.setItem('currentUser', JSON.stringify(currentUser));
    await renderEventDashboard();
  }
}

// ----------------------
// 3. Event Dashboard & Detailed Commitment Display
// ----------------------
async function renderEventDashboard() {
  const app = document.getElementById('app');
  const isCreator = currentUser?.username === currentEvent.created_by;
  // Render the detailed commitment form.
  const commitmentFormHTML = await renderCommitmentForm();
  app.innerHTML = `
    <h2>${currentEvent.event_name}</h2>
    <div style="display: flex; gap: 20px;">
      <div>
        <h3>Items Needed</h3>
        ${isCreator ? renderManageItems() : renderViewItems()}
      </div>
      <div>
        <h3>Your Commitments</h3>
        ${commitmentFormHTML}
      </div>
    </div>
  `;
  if (isCreator) {
    document.getElementById('addItemForm')?.addEventListener('submit', handleAddItem);
  }
  attachCommitListeners();
}

function renderManageItems() {
  return `
    <div id="itemList">
      ${currentEvent.items.map(item => `
        <div>
          <input type="text" value="${item.item_name}" id="edit-item-${item.id}">
          <input type="number" value="${item.quantity_required}" id="edit-qty-${item.id}">
          <button onclick="updateItem('${item.id}')">Update</button>
          <button onclick="deleteItem('${item.id}')">Delete</button>
        </div>
      `).join('')}
    </div>
    <form id="addItemForm">
      <input type="text" id="newItemName" placeholder="Item Name" required>
      <input type="number" id="newItemQuantity" placeholder="Quantity" min="1" required>
      <button type="submit">Add Item</button>
    </form>
  `;
}

function renderViewItems() {
  if (!currentEvent.items || currentEvent.items.length === 0) {
    return `<p>No items listed for this event yet.</p>`;
  }
  return currentEvent.items.map(item => `
    <p>${item.item_name} - ${item.quantity_required} needed</p>
  `).join('');
}

async function renderCommitmentForm() {
  // Query all commitments for the event.
  const { data: allCommitments } = await supabase
    .from('commitments')
    .select('*')
    .eq('event_id', currentEvent.id);
  const commitmentTotals = {};
  const userCommitments = {};
  if (allCommitments) {
    allCommitments.forEach(commit => {
      commitmentTotals[commit.item_id] = (commitmentTotals[commit.item_id] || 0) + commit.quantity;
      if (currentUser && commit.user_id === currentUser.id) {
        userCommitments[commit.item_id] = commit.quantity;
      }
    });
  }
  return currentEvent.items.map(item => {
    const totalCommitted = commitmentTotals[item.id] || 0;
    const yourCommitment = userCommitments[item.id] || 0;
    const remaining = item.quantity_required - totalCommitted;
    return `
      <div>
        <strong>${item.item_name}</strong><br>
        Required: ${item.quantity_required} | Total Committed: ${totalCommitted} | Your Commitment: 
        <input type="number" id="commit-${item.id}" value="${yourCommitment}" min="0">
        | Remaining: ${remaining}
        <button onclick="commitItem('${item.id}')">Commit</button>
      </div>
    `;
  }).join('');
}

// ----------------------
// 4. Item & Commitment Actions
// ----------------------
async function handleAddItem(e) {
  e.preventDefault();
  const newItemName = document.getElementById('newItemName').value.trim();
  const newItemQuantity = parseInt(document.getElementById('newItemQuantity').value);
  if (!newItemName || newItemQuantity <= 0) {
    alert("Please provide a valid item name and quantity.");
    return;
  }
  const { error } = await supabase
    .from('event_items')
    .insert([{
      event_id: currentEvent.id,
      item_name: newItemName,
      quantity_required: newItemQuantity
    }]);
  if (error) {
    alert("Error adding item: " + error.message);
  } else {
    alert("Item added!");
    await loadEvent(currentEvent.slug);
  }
}

async function updateItem(itemId) {
  const newItemName = document.getElementById(`edit-item-${itemId}`).value.trim();
  const newQuantity = parseInt(document.getElementById(`edit-qty-${itemId}`).value);
  if (!newItemName || newQuantity <= 0) {
    alert("Please provide valid values.");
    return;
  }
  const { error } = await supabase
    .from('event_items')
    .update({ item_name: newItemName, quantity_required: newQuantity })
    .eq('id', itemId);
  if (error) {
    alert(`Error updating item: ${error.message}`);
  } else {
    alert("Item updated!");
    await loadEvent(currentEvent.slug);
  }
}

async function deleteItem(itemId) {
  const { error } = await supabase
    .from('event_items')
    .delete()
    .eq('id', itemId);
  if (error) {
    alert(`Error deleting item: ${error.message}`);
  } else {
    alert("Item deleted!");
    await loadEvent(currentEvent.slug);
  }
}

async function commitItem(itemId) {
  const quantity = parseInt(document.getElementById(`commit-${itemId}`).value);
  // Allow zero or more as valid; upsert will insert or update.
  if (quantity >= 0) {
    const { error } = await supabase
      .from('commitments')
      .upsert([{ 
        event_id: currentEvent.id,
        user_id: currentUser.id,
        item_id: itemId,
        quantity
      }]);
    if (error) {
      alert(`Error committing item: ${error.message}`);
    } else {
      alert('Commitment successful!');
      await loadEvent(currentEvent.slug);
    }
  }
}

// ----------------------
// 5. Helper: Attach Commit Listeners (stub in case extra wiring is needed)
// ----------------------
function attachCommitListeners() {
  // Currently, our inline onclick handlers on commitment buttons handle commits.
  // If additional wiring is needed, add it here.
}

// Expose functions so inline onclick attributes can find them.
window.updateItem = updateItem;
window.deleteItem = deleteItem;
window.commitItem = commitItem;

// ----------------------
// 6. App Initialization
// ----------------------
window.addEventListener('DOMContentLoaded', () => {
  const slug = window.location.pathname.split('/event/')[1];
  if (slug) {
    loadEvent(slug);
  } else {
    renderCreateEventForm();
  }
});
