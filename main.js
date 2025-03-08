// main.js – Browser code that renders forms and calls separate edge function endpoints.
let currentEvent = null;
let currentUserToken = null; // This will store the token (here, the user’s id) returned from login or createEvent.

// Utility: Construct event-specific email.
function constructEmail(username, slug) {
  return `${username}.${slug}@mailinator.com`;
}

// ----------------------
// 1. Event Creation (for creators)
// ----------------------
function renderCreateEventForm() {
  const app = document.getElementById("app");
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
  document.getElementById("eventForm").addEventListener("submit", createEvent);
}

async function createEvent(e) {
  e.preventDefault();
  const eventName = document.getElementById("eventName").value.trim();
  const eventDescription = document.getElementById("eventDescription").value.trim();
  const eventDate = document.getElementById("eventDate").value;
  const eventTime = document.getElementById("eventTime").value;
  const username = document.getElementById("username").value.trim();
  const password = document.getElementById("password").value.trim();
  if (!eventName || !username) {
    alert("Event name and username are required.");
    return;
  }
  const response = await fetch("/api/createEvent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ eventName, eventDescription, eventDate, eventTime, username, password }),
  });
  const result = await response.json();
  if (result.error) {
    alert("Error: " + result.error);
    return;
  }
  alert(`Event created successfully! Share this link: ${location.origin}/#/event/${result.slug}`);
  currentUserToken = result.token;
  window.location.hash = `#/event/${result.slug}`;
  loadEvent(result.slug);
}

// ----------------------
// 2. Event Loading & Login (Per Event)
// ----------------------
async function loadEvent(slug) {
  const response = await fetch(`/api/event?slug=${slug}`);
  const result = await response.json();
  if (result.error) {
    alert("Event not found.");
    renderCreateEventForm();
    return;
  }
  currentEvent = result.event;
  if (!currentUserToken) {
    renderLoginForm(slug);
  } else {
    renderEventDashboard();
  }
}

function renderLoginForm(slug) {
  const app = document.getElementById("app");
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
  document.getElementById("loginForm").addEventListener("submit", (e) => handleLogin(e, slug));
}

async function handleLogin(e, slug) {
  e.preventDefault();
  const username = document.getElementById("username").value.trim();
  const password = document.getElementById("password").value.trim();
  const response = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password, slug }),
  });
  const result = await response.json();
  if (result.error) {
    alert("Error: " + result.error);
    return;
  }
  currentUserToken = result.token;
  renderEventDashboard();
}

// ----------------------
// 3. Event Dashboard & Detailed Commitment Display
// ----------------------
async function renderEventDashboard() {
  const app = document.getElementById("app");
  // For simplicity, assume that if the current user token equals the event creator’s id, they are the creator.
  // (In a real app, you would fetch the logged-in user's profile details.)
  const isCreator = currentEvent.created_by === "demo_creator"; // Replace with your actual logic.
  const commitmentFormHTML = await renderCommitmentForm();
  const commitmentBreakdownHTML = isCreator ? await renderCommitmentBreakdown() : "";
  const eventInfoHTML = `
    ${currentEvent.event_description ? `<p>${currentEvent.event_description}</p>` : ""}
    ${currentEvent.event_date ? `<p>Date: ${currentEvent.event_date}</p>` : ""}
    ${currentEvent.event_time ? `<p>Time: ${new Date("1970-01-01T" + currentEvent.event_time + "Z").toLocaleTimeString()}</p>` : ""}
  `;
  app.innerHTML = `
    <h2>${currentEvent.event_name}</h2>
    ${eventInfoHTML}
    <div class="dashboard">
      <div class="items">
        <h3>Items Needed</h3>
        <br><br>
        ${isCreator ? renderManageItems() : renderViewItems()}
        ${isCreator ? commitmentBreakdownHTML : ""}
      </div>
      <div class="commitments">
        <h3>Your Commitments</h3>
        <br><br>
        ${commitmentFormHTML}
      </div>
    </div>
  `;
  if (isCreator) {
    document.getElementById("addItemForm")?.addEventListener("submit", handleAddItem);
  }
}

function renderManageItems() {
  return `
    <div id="itemList">
      ${currentEvent.items.map(
        (item) => `
      <div class="item-card">
        <input type="text" value="${item.item_name}" id="edit-item-${item.id}">
        <input type="number" value="${item.quantity_required}" id="edit-qty-${item.id}">
        <input type="text" value="${item.item_description || ""}" id="edit-desc-${item.id}" placeholder="Item description (optional)">
        <button onclick="updateItem('${item.id}')">Update</button>
        <button onclick="deleteItem('${item.id}')">Delete</button>
      </div>
      `
      ).join("")}
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
  return currentEvent.items.map(
    (item) => `
    <div class="item-card">
      <p>${item.item_name} - ${item.quantity_required} needed</p>
      ${item.item_description ? `<p><em>${item.item_description}</em></p>` : ""}
    </div>
    `
  ).join("");
}

async function renderCommitmentForm() {
  const response = await fetch(`/api/event?slug=${currentEvent.slug}`);
  const { commitments } = await response.json();
  const commitmentTotals = {};
  const userCommitments = {};
  if (commitments) {
    commitments.forEach((commit) => {
      commitmentTotals[commit.item_id] = (commitmentTotals[commit.item_id] || 0) + commit.quantity;
      if (commit.user_id === currentUserToken) {
        userCommitments[commit.item_id] = commit.quantity;
      }
    });
  }
  return currentEvent.items.map((item) => {
    const totalCommitted = commitmentTotals[item.id] || 0;
    const yourCommitment = userCommitments[item.id] || 0;
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
  }).join("");
}

async function renderCommitmentBreakdown() {
  const response = await fetch(`/api/event?slug=${currentEvent.slug}`);
  const { commitments, users } = await response.json();
  const userLookup = {};
  if (users) {
    users.forEach((user) => {
      if (user && user.username) {
        userLookup[user.id] = user.username;
      }
    });
  }
  const breakdownByItem = {};
  if (commitments) {
    commitments.forEach((row) => {
      const itemId = row.item_id;
      const username = row.user_id ? (userLookup[row.user_id] || "Unknown") : "Unknown";
      if (!breakdownByItem[itemId]) breakdownByItem[itemId] = [];
      breakdownByItem[itemId].push(`${username}: ${row.quantity}`);
    });
  }
  let html = "<h4>Commitment Breakdown</h4>";
  currentEvent.items.forEach((item) => {
    if (breakdownByItem[item.id]) {
      html += `<p><strong>${item.item_name}:</strong> ${breakdownByItem[item.id].join(", ")}</p>`;
    }
  });
  return html;
}

// ----------------------
// 4. Item & Commitment Actions
// ----------------------
async function handleAddItem(e) {
  e.preventDefault();
  const newItemName = document.getElementById("newItemName").value.trim();
  const newItemQuantity = parseInt(document.getElementById("newItemQuantity").value);
  const newItemDescription = document.getElementById("newItemDescription").value.trim();
  if (!newItemName || newItemQuantity <= 0) {
    alert("Please provide a valid item name and quantity.");
    return;
  }
  const response = await fetch("/api/addItem", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + currentUserToken,
    },
    body: JSON.stringify({ newItemName, newItemQuantity, newItemDescription, eventSlug: currentEvent.slug }),
  });
  const result = await response.json();
  if (result.error) {
    alert("Error: " + result.error);
  } else {
    alert("Item added!");
    loadEvent(currentEvent.slug);
  }
}

async function updateItem(itemId) {
  const newItemName = document.getElementById(`edit-item-${itemId}`).value.trim();
  const newQuantity = parseInt(document.getElementById(`edit-qty-${itemId}`).value);
  const newDescription = document.getElementById(`edit-desc-${itemId}`)?.value.trim();
  if (!newItemName || newQuantity <= 0) {
    alert("Please provide valid values.");
    return;
  }
  const response = await fetch("/api/updateItem", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + currentUserToken,
    },
    body: JSON.stringify({ itemId, newItemName, newQuantity, newDescription, eventSlug: currentEvent.slug }),
  });
  const result = await response.json();
  if (result.error) {
    alert("Error: " + result.error);
  } else {
    alert("Item updated successfully!");
    loadEvent(currentEvent.slug);
  }
}

async function deleteItem(itemId) {
  if (!confirm("Are you sure you want to delete this item? This cannot be undone.")) {
    return;
  }
  const response = await fetch("/api/deleteItem", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + currentUserToken,
    },
    body: JSON.stringify({ itemId, eventSlug: currentEvent.slug }),
  });
  const result = await response.json();
  if (result.error) {
    alert("Error: " + result.error);
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
  const response = await fetch("/api/commitItem", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + currentUserToken,
    },
    body: JSON.stringify({ itemId, quantity, eventSlug: currentEvent.slug }),
  });
  const result = await response.json();
  if (result.error) {
    alert("Error: " + result.error);
  } else {
    alert("Commitment successful!");
    loadEvent(currentEvent.slug);
  }
}

// Expose functions for inline onclicks.
window.updateItem = updateItem;
window.deleteItem = deleteItem;
window.commitItem = commitItem;

window.addEventListener("DOMContentLoaded", async () => {
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
