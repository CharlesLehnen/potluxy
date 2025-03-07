// Set your base URL for all Edge Function endpoints:
const EDGE_BASE_URL = "https://wkbksxgqltncpluhvhdj.supabase.co/functions/v1/";

// Utility: Construct event-specific email from username and event slug.
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
      <br><br>
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
      <label for="username">Your Event Username:</label>
      <input type="text" id="username" required>
      <br><br>
      <label for="password">Password (optional for editing):</label>
      <input type="password" id="password">
      <br><br>
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
  
  // Call your Edge Function to create an event.
  const response = await fetch(EDGE_BASE_URL + "createEvent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      eventName,
      eventDescription,
      eventDate,
      eventTime,
      username,
      password,
      slug,
      email
    })
  });
  if (!response.ok) {
    const errorData = await response.json();
    alert("Error creating event: " + errorData.error);
    return;
  }
  const result = await response.json();
  // Expecting the endpoint to return the created event and user profile data.
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
  const response = await fetch(EDGE_BASE_URL + "loadEvent?slug=" + encodeURIComponent(slug));
  if (!response.ok) {
    alert('Event not found.');
    renderCreateEventForm();
    return;
  }
  const eventData = await response.json();
  currentEvent = eventData;
  
  // Check if the user is authenticated (for example, via a token stored in localStorage)
  const token = localStorage.getItem("authToken");
  if (!token) {
    renderLoginForm(slug);
  } else {
    // Get the event-specific profile using the token.
    const profileResp = await fetch(EDGE_BASE_URL + "getProfile", {
      method: "POST",
      headers: { 
        "Content-Type": "application/json",
        "Authorization": "Bearer " + token
      },
      body: JSON.stringify({ eventId: currentEvent.id })
    });
    if (!profileResp.ok) {
      renderLoginForm(slug);
    } else {
      currentUser = await profileResp.json();
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
  
  // Call your Edge Function to handle authentication.
  const response = await fetch(EDGE_BASE_URL + "auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, eventId: currentEvent.id, username })
  });
  if (!response.ok) {
    const errorData = await response.json();
    alert("Error during auth: " + errorData.error);
    return;
  }
  const result = await response.json();
  // Save the auth token and user profile
  localStorage.setItem("authToken", result.authToken);
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
        <br><br>
        ${isCreator ? renderManageItems() : renderViewItems()}
        ${isCreator ? commitmentBreakdownHTML : ''}
      </div>
      <div class="commitments">
        <h3>Your Commitments</h3>
        <br><br>
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
  const response = await fetch(EDGE_BASE_URL + "getCommitments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ eventId: currentEvent.id })
  });
  const allCommitments = await response.json();
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
    const yourCommitment = (userCommitments[item.id] === undefined) ? 0 : userCommitments[item.id];
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
  const response = await fetch(EDGE_BASE_URL + "getCommitmentBreakdown", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ eventId: currentEvent.id })
  });
  const breakdownData = await response.json();
  let html = '<h4>Commitment Breakdown</h4>';
  for (const item of currentEvent.items) {
    if (breakdownData[item.id]) {
      html += `<p><strong>${item.item_name}:</strong> ${breakdownData[item.id].join(', ')}</p>`;
    }
  }
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
  const response = await fetch(EDGE_BASE_URL + "addItem", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      eventId: currentEvent.id,
      item_name: newItemName,
      quantity_required: newItemQuantity,
      item_description: newItemDescription
    })
  });
  if (!response.ok) {
    const err = await response.json();
    alert("Error adding item: " + err.error);
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
  const response = await fetch(EDGE_BASE_URL + "updateItem", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      itemId,
      newItemName,
      newQuantity,
      newDescription,
      eventId: currentEvent.id
    })
  });
  if (!response.ok) {
    const err = await response.json();
    alert("Error updating item: " + err.error);
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
  const response = await fetch(EDGE_BASE_URL + "deleteItem", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ itemId, eventId: currentEvent.id })
  });
  if (!response.ok) {
    const err = await response.json();
    alert("Error deleting item: " + err.error);
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
  const response = await fetch(EDGE_BASE_URL + "commitItem", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      eventId: currentEvent.id,
      userId: currentUser.id,
      itemId,
      quantity
    })
  });
  if (!response.ok) {
    const err = await response.json();
    alert("Error committing item: " + err.error);
  } else {
    alert("Commitment successful!");
    loadEvent(currentEvent.slug);
  }
}

// ----------------------
// 5. Helper: Attach Commit Listeners (stub)
// ----------------------
function attachCommitListeners() {
  // Inline onclicks in renderCommitmentForm handle commits.
}

// Global variables for current event and user.
let currentEvent = null;
let currentUser = null;

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
