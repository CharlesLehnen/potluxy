// main.js

// No direct Supabase client initialization here.
// All calls are made via secure API endpoints (handled by Django/Edge Functions).
let currentEvent = null;
let currentUser = null; // Managed via server-side sessions

// Utility: Construct an event-specific email (used only for authentication on the backend)
function constructEmail(username, slug) {
  return `${username}.${slug}@mailinator.com`;
}

// ----------------------
// 1. Event Creation (for creators)
// ----------------------
async function renderCreateEventForm() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <form id="eventForm" class="form">
      <h2>Create New Event</h2>
      <label for="eventName">Event Name:</label>
      <input type="text" id="eventName" required>
      <label for="eventDescription">Event Description (optional):</label>
      <textarea id="eventDescription" placeholder="Enter a description..."></textarea>
      <label for="eventDate">Event Date (optional):</label>
      <input type="date" id="eventDate">
      <label for="eventTime">Event Time (optional):</label>
      <input type="time" id="eventTime">
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

async function createEvent(e) {
  e.preventDefault();
  const eventName = document.getElementById('eventName').value.trim();
  const eventDescription = document.getElementById('eventDescription').value.trim();
  const eventDate = document.getElementById('eventDate').value;
  const eventTime = document.getElementById('eventTime').value;
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value.trim();
  if (!eventName || !username) {
    alert('Event name and username are required.');
    return;
  }
  const slug = generateSlug(eventName);
  const email = constructEmail(username, slug);
  
  // POST to your secure backend endpoint for event creation.
  const response = await fetch('/api/create_event/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event_name: eventName,
      slug: slug,
      event_description: eventDescription || null,
      event_date: eventDate || null,
      event_time: eventTime || null,
      username: username,
      password: password || 'no-password',
      email: email
    })
  });
  const result = await response.json();
  if (!response.ok) {
    alert(`Error creating event: ${result.error}`);
    return;
  }
  
  // The backend returns the created event and user profile.
  currentEvent = result.event;
  currentUser = result.profile;
  
  alert(`Event created successfully! Share this link: ${location.origin}/#/event/${slug}`);
  window.location.hash = `#/event/${slug}`;
  loadEvent(slug);
}

// ----------------------
// 2. Event Loading & Login (Per Event)
// ----------------------
async function loadEvent(slug) {
  // Call your backend endpoint to load event details (with event items).
  const response = await fetch(`/api/load_event/?slug=${encodeURIComponent(slug)}`);
  const result = await response.json();
  if (!response.ok) {
    alert('Event not found.');
    renderCreateEventForm();
    return;
  }
  currentEvent = result.event;
  // currentEvent.items should be included from the backend.
  
  // Check session status via your backend.
  const sessionResponse = await fetch('/api/get_session/');
  const sessionResult = await sessionResponse.json();
  if (!sessionResult.session) {
    renderLoginForm(slug);
  } else {
    // Fetch the event-specific profile for the logged-in user.
    const profileResponse = await fetch(`/api/get_profile/?event_id=${currentEvent.id}`);
    const profileResult = await profileResponse.json();
    if (!profileResult.profile) {
      alert("No event-specific profile found; please sign up for this event.");
      renderLoginForm(slug);
    } else {
      currentUser = profileResult.profile;
      renderEventDashboard();
    }
  }
}

function renderLoginForm(slug) {
  const app = document.getElementById('app');
  app.innerHTML = `
    <h2>${currentEvent.event_name}</h2>
    <form id="loginForm" class="form">
      <label for="username">Username:</label>
      <input type="text" id="username" required>
      <label for="password">Password:</label>
      <input type="password" id="password">
      <button type="submit">Login / Sign Up</button>
    </form>
    <p>If you don't have an account for this event, signing up will create one.</p>
  `;
  document.getElementById('loginForm').addEventListener('submit', (e) => handleLogin(e, slug));
}

async function handleLogin(e, slug) {
  e.preventDefault();
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value.trim();
  const email = constructEmail(username, slug);
  
  // Send a POST request to your backend login endpoint.
  const response = await fetch('/api/login/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: password || 'no-password', email, slug })
  });
  const result = await response.json();
  if (!response.ok) {
    alert(`Error signing in: ${result.error}`);
    return;
  }
  
  currentUser = result.profile;
  renderEventDashboard();
}

// ----------------------
// 3. Event Dashboard & Detailed Commitment Display
// ----------------------
async function renderEventDashboard() {
  const app = document.getElementById('app');
  const isCreator = currentUser?.username === currentEvent.created_by;
  const commitmentFormHTML = await renderCommitmentForm();
  const commitmentBreakdownHTML = isCreator ? await renderCommitmentBreakdown() : '';
  const eventInfoHTML = `
    ${currentEvent.event_description ? `<p>${currentEvent.event_description}</p>` : ''}
    ${currentEvent.event_date ? `<p>Date: ${currentEvent.event_date}</p>` : ''}
    ${currentEvent.event_time ? `<p>Time: ${new Date('1970-01-01T' + currentEvent.event_time + 'Z').toLocaleTimeString()}</p>` : ''}
  `;
  
  app.innerHTML = `
    <h2>${currentEvent.event_name}</h2>
    ${eventInfoHTML}
    <div class="dashboard">
      <div class="items">
        <h3>Items Needed</h3>
        ${isCreator ? renderManageItems() : renderViewItems()}
        ${isCreator ? commitmentBreakdownHTML : ''}
      </div>
      <div class="commitments">
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
        <div class="item-card">
          <input type="text" value="${item.item_name}" id="edit-item-${item.id}">
          <input type="number" value="${item.quantity_required}" id="edit-qty-${item.id}">
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
  if (!currentEvent.items || currentEvent.items.length === 0) {
    return `<p>No items listed for this event yet.</p>`;
  }
  return currentEvent.items.map(item => `
    <div class="item-card">
      <p>${item.item_name} - ${item.quantity_required} needed</p>
      ${item.item_description ? `<p><em>${item.item_description}</em></p>` : ''}
    </div>
  `).join('');
}

async function renderCommitmentForm() {
  const response = await fetch(`/api/commitments/?event_id=${currentEvent.id}`);
  const result = await response.json();
  const allCommitments = result.commitments || [];
  const commitmentTotals = {};
  const userCommitments = {};
  allCommitments.forEach(commit => {
    commitmentTotals[commit.item_id] = (commitmentTotals[commit.item_id] || 0) + commit.quantity;
    if (currentUser && commit.user_id === currentUser.id) {
      userCommitments[commit.item_id] = commit.quantity;
    }
  });
  return currentEvent.items.map(item => {
    const totalCommitted = commitmentTotals[item.id] || 0;
    const yourCommitment = userCommitments[item.id] === undefined ? 0 : userCommitments[item.id];
    const remaining = item.quantity_required - totalCommitted;
    return `
      <div class="commitment-card">
        <strong style="text-align: center; display: block;">${item.item_name}</strong>
        <br><br>
        <div>Required: ${item.quantity_required}</div>
        <div>Total Committed: ${totalCommitted}</div>
        <div>Your Commitment: ${yourCommitment}</div>
        <div>
          <input type="number" id="commit-${item.id}" value="${yourCommitment}" min="0">
          Remaining: ${remaining}
          <button onclick="commitItem('${item.id}')">Commit</button>
        </div>
      </div>
    `;
  }).join('');
}

async function renderCommitmentBreakdown() {
  const usersResponse = await fetch(`/api/event_users/?event_id=${currentEvent.id}`);
  const usersResult = await usersResponse.json();
  const usersData = usersResult.users || [];
  const userLookup = {};
  usersData.forEach(user => {
    if (user && user.username) {
      userLookup[user.id] = user.username;
    }
  });
  const breakdownResponse = await fetch(`/api/commitments/?event_id=${currentEvent.id}`);
  const breakdownResult = await breakdownResponse.json();
  const breakdownData = breakdownResult.commitments || [];
  const breakdownByItem = {};
  breakdownData.forEach(row => {
    if (!row) return;
    const itemId = row.item_id;
    const username = row.user_id ? (userLookup[row.user_id] || "Unknown") : "Unknown";
    if (!breakdownByItem[itemId]) breakdownByItem[itemId] = [];
    breakdownByItem[itemId].push(`${username}: ${row.quantity}`);
  });
  let html = '<h4>Commitment Breakdown</h4>';
  currentEvent.items.forEach(item => {
    if (breakdownByItem[item.id]) {
      html += `<p><strong>${item.item_name}:</strong> ${breakdownByItem[item.id].join(', ')}</p>`;
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
  const newItemQuantity = parseInt(document.getElementById('newItemQuantity').value);
  const newItemDescription = document.getElementById('newItemDescription').value.trim();
  if (!newItemName || newItemQuantity <= 0) {
    alert("Please provide a valid item name and quantity.");
    return;
  }
  const response = await fetch('/api/add_item/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event_id: currentEvent.id,
      item_name: newItemName,
      quantity_required: newItemQuantity,
      item_description: newItemDescription || null
    })
  });
  const result = await response.json();
  if (!response.ok) {
    alert("Error adding item: " + result.error);
  } else {
    alert("Item added!");
    loadEvent(currentEvent.slug);
  }
}

async function updateItem(itemId) {
  if (currentUser?.username !== currentEvent.created_by) {
    alert("Only the event creator can update items.");
    return;
  }
  const newItemName = document.getElementById(`edit-item-${itemId}`).value.trim();
  const newQuantity = parseInt(document.getElementById(`edit-qty-${itemId}`).value);
  const newDescription = document.getElementById(`edit-desc-${itemId}`)?.value.trim();
  if (!newItemName || newQuantity <= 0) {
    alert("Please provide valid values.");
    return;
  }
  // First, check total commitments for this item.
  const response = await fetch(`/api/update_item/`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      item_id: itemId,
      item_name: newItemName,
      quantity_required: newQuantity,
      item_description: newDescription || null
    })
  });
  const result = await response.json();
  if (!response.ok) {
    alert(`Error updating item: ${result.error}`);
  } else {
    alert("Item updated successfully!");
    loadEvent(currentEvent.slug);
  }
}

async function deleteItem(itemId) {
  if (currentUser?.username !== currentEvent.created_by) {
    alert("Only the event creator can delete items.");
    return;
  }
  if (!confirm("Are you sure you want to delete this item? This cannot be undone.")) {
    return;
  }
  const response = await fetch('/api/delete_item/', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ item_id: itemId })
  });
  const result = await response.json();
  if (!response.ok) {
    alert(`Error deleting item: ${result.error}`);
  } else {
    alert("Item deleted successfully!");
    loadEvent(currentEvent.slug);
  }
}

async function commitItem(itemId) {
  const inputEl = document.getElementById(`commit-${itemId}`);
  const quantity = parseInt(inputEl.value);
  if (isNaN(quantity) || quantity < 0) {
    alert("Please enter a valid number for commitment.");
    return;
  }
  const response = await fetch('/api/commit_item/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event_id: currentEvent.id,
      user_id: currentUser.id,
      item_id: itemId,
      quantity: quantity
    })
  });
  const result = await response.json();
  if (!response.ok) {
    alert(`Error committing item: ${result.error}`);
  } else {
    alert('Commitment successful!');
    loadEvent(currentEvent.slug);
  }
}

// ----------------------
// 5. Helper: Attach Commit Listeners (stub)
// ----------------------
function attachCommitListeners() {
  // Inline onclicks in renderCommitmentForm handle commits.
}

// Expose functions to global scope for inline handlers.
window.updateItem = updateItem;
window.deleteItem = deleteItem;
window.commitItem = commitItem;

// ----------------------
// 6. App Initialization with Hash Routing
// ----------------------
window.addEventListener('DOMContentLoaded', async () => {
  let slug = null;
  if (window.location.hash && window.location.hash.startsWith("#/event/")) {
    slug = window.location.hash.split("#/event/")[1];
  }
  if (slug) {
    await loadEvent(slug);
  } else {
    renderCreateEventForm();
  }
});
