// Import Supabase client and config
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

// Initialize Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
let currentEvent = null;
let currentUser = null; // Managed via supabase.auth

// Utility: Construct event-specific email from username and event slug.
function constructEmail(username, slug) {
  // For example, if your domain is mailinator.com
  return `${username}.${slug}@mailinator.com`;
}

// ----------------------
// 1. Event Creation (for creators)
// ----------------------
async function renderCreateEventForm() {
  const app = document.getElementById('app');
  // NEW: Add optional fields for event description, date, and time.
  app.innerHTML = `
    <form id="eventForm">
      <h2>Create New Event</h2>
      <label for="eventName">Event Name:</label>
      <input type="text" id="eventName" required>
      <label for="eventDescription">Event Description (optional):</label>
      <textarea id="eventDescription"></textarea>
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
  const eventDescription = document.getElementById('eventDescription').value.trim(); // NEW
  const eventDate = document.getElementById('eventDate').value; // NEW
  const eventTime = document.getElementById('eventTime').value; // NEW
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value.trim();
  if (!eventName || !username) {
    alert('Event name and username are required.');
    return;
  }
  const slug = generateSlug(eventName);
  const email = constructEmail(username, slug);
  
  // Sign up via Supabase Auth.
  const { data: authData, error: signUpError } = await supabase.auth.signUp({
    email,
    password: password || 'no-password'
  });
  if (signUpError) {
    alert(`Error signing up: ${signUpError.message}`);
    return;
  }
  
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError || !sessionData.session) {
    alert('Error: User not fully authenticated after signup.');
    return;
  }
  const userId = sessionData.session.user.id;
  
  // Create the event including new optional fields.
  const { data: eventData, error: eventError } = await supabase
    .from('events')
    .insert([{
      event_name: eventName,
      slug,
      created_by: username,
      event_description: eventDescription || null, // NEW
      event_date: eventDate || null,               // NEW
      event_time: eventTime || null                // NEW
    }])
    .select()
    .single();
  if (eventError) {
    alert(`Error creating event: ${eventError.message}`);
    return;
  }
  
  const eventId = eventData.id;
  
  // Create event-specific profile.
  const { data: profileData, error: profileError } = await supabase
    .from('event_users')
    .insert([{ id: userId, event_id: eventId, username }])
    .select()
    .single();
  if (profileError) {
    alert(`Error creating event user: ${profileError.message}`);
    return;
  }
  currentUser = profileData;
  
  alert(`Event created successfully! Share this link: ${location.origin}/#/event/${slug}`);
  window.location.hash = `#/event/${slug}`;
  loadEvent(slug);
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
    alert('Event not found.');
    renderCreateEventForm();
    return;
  }
  currentEvent = eventData;
  currentEvent.items = eventData.event_items || [];
  
  // Check Supabase Auth session.
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    renderLoginForm(slug);
  } else {
    const { data: profileData } = await supabase
      .from('event_users')
      .select('*')
      .eq('id', session.user.id)
      .eq('event_id', currentEvent.id)
      .single();
    if (!profileData) {
      alert("No event-specific profile found; please sign up for this event.");
      renderLoginForm(slug);
    } else {
      currentUser = profileData;
      renderEventDashboard();
    }
  }
}

function renderLoginForm(slug) {
  const app = document.getElementById('app');
  app.innerHTML = `
    <h2>${currentEvent.event_name}</h2>
    <form id="loginForm">
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
  
  // Attempt to sign in
  let { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
    email, 
    password: password || 'no-password'
  });
  if (signInError) {
    // If the error indicates the user doesn't exist, try signing up.
    if (signInError.message.includes("Invalid login credentials")) {
      const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
        email, 
        password: password || 'no-password'
      });
      if (signUpError) {
        alert(`Error signing up: ${signUpError.message}`);
        return;
      }
      signInData = signUpData;
    } else {
      alert(`Error signing in: ${signInError.message}`);
      return;
    }
  }
  
  // Fetch (or create) the event-specific profile.
  const { data: profileData } = await supabase
    .from('event_users')
    .select('*')
    .eq('id', signInData.session.user.id)
    .eq('event_id', currentEvent.id)
    .single();
  if (!profileData) {
    const { data: newProfile, error: newProfileError } = await supabase
      .from('event_users')
      .insert([{ id: signInData.session.user.id, event_id: currentEvent.id, username }])
      .select()
      .single();
    if (newProfileError) {
      alert(`Error creating event user: ${newProfileError.message}`);
      return;
    }
    currentUser = newProfile;
  } else {
    currentUser = profileData;
  }
  renderEventDashboard();
}

// ----------------------
// 3. Event Dashboard & Detailed Commitment Display
// ----------------------
async function renderEventDashboard() {
  const app = document.getElementById('app');
  const isCreator = currentUser?.username === currentEvent.created_by;
  const commitmentFormHTML = await renderCommitmentForm();
  // NEW: For creators, include a commitment breakdown.
  const commitmentBreakdownHTML = isCreator ? await renderCommitmentBreakdown() : '';
  // Optionally, display event description/date/time.
  const eventInfoHTML = `
    ${currentEvent.event_description ? `<p>${currentEvent.event_description}</p>` : ''}
    ${currentEvent.event_date ? `<p>Date: ${currentEvent.event_date}</p>` : ''}
    ${currentEvent.event_time ? `<p>Time: ${new Date('1970-01-01T' + currentEvent.event_time + 'Z').toLocaleTimeString()}</p>` : ''}
  `;
  
  app.innerHTML = `
    <h2>${currentEvent.event_name}</h2>
    ${eventInfoHTML}
    <div style="display: flex; gap: 20px;">
      <div>
        <h3>Items Needed</h3>
        ${isCreator ? renderManageItems() : renderViewItems()}
        ${isCreator ? commitmentBreakdownHTML : ''}
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
          <!-- NEW: Optional item description input -->
          <input type="text" value="${item.item_description || ''}" id="edit-desc-${item.id}" placeholder="Item description (optional)">
          <button onclick="updateItem('${item.id}')">Update</button>
          <button onclick="deleteItem('${item.id}')">Delete</button>
        </div>
      `).join('')}
    </div>
    <form id="addItemForm">
      <input type="text" id="newItemName" placeholder="Item Name" required>
      <input type="number" id="newItemQuantity" placeholder="Quantity" min="1" required>
      <!-- NEW: Optional item description input -->
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
    <p>
      ${item.item_name} - ${item.quantity_required} needed
      ${item.item_description ? `<br><em>${item.item_description}</em>` : ''}
    </p>
  `).join('');
}

async function renderCommitmentForm() {
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
    const yourCommitment = (userCommitments[item.id] === undefined) ? 0 : userCommitments[item.id];
    const remaining = item.quantity_required - totalCommitted;
    return `
      <div>
        <strong>${item.item_name}</strong><br>
        Required: ${item.quantity_required} | Total Committed: ${totalCommitted} | Your Commitment: ${yourCommitment}
        <input type="number" id="commit-${item.id}" value="${yourCommitment}" min="0">
        | Remaining: ${remaining}
        <button onclick="commitItem('${item.id}')">Commit</button>
      </div>
    `;
  }).join('');
}

// NEW: For creators, render a breakdown of who committed what.
async function renderCommitmentBreakdown() {
    // First, fetch all event_users for the current event.
    const { data: usersData, error: usersError } = await supabase
      .from('event_users')
      .select('id, username')
      .eq('event_id', currentEvent.id);
    const userLookup = {};
    if (usersData) {
      usersData.forEach(user => {
        userLookup[user.id] = user.username;
      });
    }
    // Now fetch all commitments for the event.
    const { data: breakdownData, error } = await supabase
      .from('commitments')
      .select('quantity, item_id, user_id')
      .eq('event_id', currentEvent.id);
    if (error) {
      return `<p>Error loading commitment breakdown.</p>`;
    }
    // Group commitments by item_id.
    const breakdownByItem = {};
    breakdownData.forEach(row => {
      const itemId = row.item_id;
      const username = userLookup[row.user_id] || "Unknown";
      if (!breakdownByItem[itemId]) breakdownByItem[itemId] = [];
      breakdownByItem[itemId].push(`${username}: ${row.quantity}`);
    });
    // Build HTML for each item.
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
  const newItemDescription = document.getElementById('newItemDescription').value.trim(); // NEW
  if (!newItemName || newItemQuantity <= 0) {
    alert("Please provide a valid item name and quantity.");
    return;
  }
  const insertData = {
    event_id: currentEvent.id,
    item_name: newItemName,
    quantity_required: newItemQuantity
  };
  if (newItemDescription) {
    insertData.item_description = newItemDescription;
  }
  const { error } = await supabase
    .from('event_items')
    .insert([insertData]);
  if (error) {
    alert("Error adding item: " + error.message);
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
  // Get total committed so far
  const { data: commitmentsData } = await supabase
    .from('commitments')
    .select('quantity')
    .eq('item_id', itemId);
  const totalCommitted = commitmentsData?.reduce((sum, c) => sum + c.quantity, 0) || 0;
  if (newQuantity < totalCommitted) {
    alert(`Cannot reduce required quantity to ${newQuantity}. ${totalCommitted} already committed.`);
    return;
  }
  const updateData = { item_name: newItemName, quantity_required: newQuantity };
  if (newDescription !== undefined) {
    updateData.item_description = newDescription;
  }
  const { error } = await supabase
    .from('event_items')
    .update(updateData)
    .eq('id', itemId);
  if (error) {
    alert(`Error updating item: ${error.message}`);
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
  const { error } = await supabase
    .from('event_items')
    .delete()
    .eq('id', itemId);
  if (error) {
    alert(`Error deleting item: ${error.message}`);
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
  // Get current item info
  const { data: itemData, error: itemError } = await supabase
    .from('event_items')
    .select('quantity_required')
    .eq('id', itemId)
    .single();
  if (itemError || !itemData) {
    alert(`Error fetching item details: ${itemError?.message}`);
    return;
  }
  const requiredQuantity = itemData.quantity_required;
  // Get total committed so far
  const { data: commitmentsData } = await supabase
    .from('commitments')
    .select('quantity')
    .eq('item_id', itemId);
  const totalCommitted = commitmentsData?.reduce((sum, c) => sum + c.quantity, 0) || 0;
  // Get current user's existing commitment for this item.
  const { data: myCommitData } = await supabase
    .from('commitments')
    .select('quantity')
    .eq('item_id', itemId)
    .eq('user_id', currentUser.id)
    .single();
  const myCurrent = myCommitData ? myCommitData.quantity : 0;
  const available = requiredQuantity - (totalCommitted - myCurrent);
  if (quantity > available) {
    alert(`Cannot commit ${quantity}. Only ${available} slots are available.`);
    return;
  }
  const { error } = await supabase
    .from('commitments')
    .upsert([{
      event_id: currentEvent.id,
      user_id: currentUser.id,
      item_id: itemId,
      quantity
    }], { onConflict: ['event_id', 'user_id', 'item_id'] });
  if (error) {
    alert(`Error committing item: ${error.message}`);
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

// Expose functions so inline onclick attributes can find them.
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
