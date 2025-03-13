// Import Supabase client and config
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

// Initialize Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
let currentEvent = null;
let currentUser = null; // Managed via supabase.auth

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
    console.error('Event name and username are required.');
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
    console.error(`Error signing up: ${signUpError.message}`);
    return;
  }
  
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError || !sessionData.session) {
    console.error('Error: User not fully authenticated after signup.');
    return;
  }
  const userId = sessionData.session.user.id;
  
  // Create the event.
  const { data: eventData, error: eventError } = await supabase
    .from('events')
    .insert([{
      event_name: eventName,
      slug,
      created_by: username,
      event_description: eventDescription || null,
      event_date: eventDate || null,
      event_time: eventTime || null
    }])
    .select()
    .single();
  if (eventError) {
    console.error(`Error creating event: ${eventError.message}`);
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
    console.error(`Error creating event user: ${profileError.message}`);
    return;
  }
  currentUser = profileData;
  
  console.log(`Event created successfully! Share this link: ${location.origin}/#/event/${slug}`);
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
    console.error('Event not found.');
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
      console.error("No event-specific profile found; please sign up for this event.");
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
  
  // Attempt to sign in
  let { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
    email, 
    password: password || 'no-password'
  });
  if (signInError) {
    if (signInError.message.includes("Invalid login credentials")) {
      const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
        email, 
        password: password || 'no-password'
      });
      if (signUpError) {
        console.error(`Error signing up: ${signUpError.message}`);
        return;
      }
      signInData = signUpData;
    } else {
      console.error(`Error signing in: ${signInError.message}`);
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
      console.error(`Error creating event user: ${newProfileError.message}`);
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
  let commitmentBreakdownHTML = "";
  if (isCreator) {
    commitmentBreakdownHTML = await renderCommitmentBreakdown();
  }
  const commitmentFormHTML = await renderCommitmentForm();
  const eventInfoHTML = `
    ${currentEvent.event_description ? `<p>${currentEvent.event_description}</p>` : ""}
    ${currentEvent.event_date ? `<p>Date: ${currentEvent.event_date}</p>` : ""}
    ${currentEvent.event_time ? `<p>Time: ${new Date("1970-01-01T" + currentEvent.event_time + "Z").toLocaleTimeString()}</p>` : ""}
    <div id="shareUrlContainer" style="margin-top:10px;">
      <input type="text" id="shareUrl" value="${location.origin}/#/event/${currentEvent.slug}" readonly style="width:80%;">
      <button id="copyShareUrl" type="button">Copy URL to Share Event</button>
    </div>
  `;
  
  app.innerHTML = `
    <h2>${currentEvent.event_name}</h2>
    ${isCreator ? commitmentBreakdownHTML : ""}
    ${eventInfoHTML}
    <div class="dashboard">
      <div class="items">
        <h3>Items Needed</h3>
        <br><br>
        ${isCreator ? renderManageItems() : renderViewItems()}
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
  
  // Set up the share URL copy functionality.
  const copyBtn = document.getElementById('copyShareUrl');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      const shareInput = document.getElementById('shareUrl');
      shareInput.select();
      document.execCommand('copy');
      console.log('Share URL copied to clipboard.');
    });
  }
  
  attachCommitListeners();
}

function renderManageItems() {
  return `
    <div id="itemList">
      ${currentEvent.items.map(item => `
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
  if (!currentEvent.items || currentEvent.items.length === 0) {
    return `<p>No items listed for this event yet.</p>`;
  }
  return currentEvent.items.map(item => `
    <div class="item-card">
      <p>${item.item_name} - ${item.quantity_required} needed</p>
      ${item.item_description ? `<p><em>${item.item_description}</em></p>` : ""}
    </div>
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
      <div class="commitment-card">
        <strong style="text-align: center; display: block;">${item.item_name}</strong>
        <div>Required: ${item.quantity_required}</div>
        <div>Total Committed: ${totalCommitted}</div>
        <div>Your Commitment: ${yourCommitment}</div>
        <div>
            <input type="number" id="commit-${item.id}" value="${yourCommitment}" min="1">
            Remaining: ${remaining}
            <button onclick="commitItem('${item.id}')">Commit</button>
        </div>
      </div>
    `;
  }).join('');
}

async function renderCommitmentBreakdown() {
  const { data: usersData } = await supabase
    .from('event_users')
    .select('id, username')
    .eq('event_id', currentEvent.id);
  const userLookup = {};
  if (usersData) {
    usersData.forEach(user => {
      if (user && user.username) {
        userLookup[user.id] = user.username;
      }
    });
  }
  const { data: breakdownData, error } = await supabase
    .from('commitments')
    .select('quantity, item_id, user_id')
    .eq('event_id', currentEvent.id);
  if (error) {
    console.error("Error loading commitment breakdown:", error.message);
    return `<p>Error loading commitment breakdown.</p>`;
  }
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
  if (!newItemName || isNaN(newItemQuantity) || newItemQuantity <= 0) {
    console.error("Please provide a valid item name and a positive integer for quantity.");
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
    console.error("Error adding item:", error.message);
  } else {
    loadEvent(currentEvent.slug);
  }
}

async function updateItem(itemId) {
  if (currentUser?.username !== currentEvent.created_by) {
    console.error("Only the event creator can update items.");
    return;
  }
  const newItemName = document.getElementById(`edit-item-${itemId}`).value.trim();
  const newQuantity = parseInt(document.getElementById(`edit-qty-${itemId}`).value);
  const newDescription = document.getElementById(`edit-desc-${itemId}`)?.value.trim();
  if (!newItemName || isNaN(newQuantity) || newQuantity <= 0) {
    console.error("Please provide valid values. Quantities must be positive integers.");
    return;
  }
  const { data: commitmentsData } = await supabase
    .from('commitments')
    .select('quantity')
    .eq('item_id', itemId);
  const totalCommitted = commitmentsData?.reduce((sum, c) => sum + c.quantity, 0) || 0;
  if (newQuantity < totalCommitted) {
    console.error(`Cannot reduce required quantity to ${newQuantity}. ${totalCommitted} already committed.`);
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
    console.error(`Error updating item: ${error.message}`);
  } else {
    loadEvent(currentEvent.slug);
  }
}

async function deleteItem(itemId) {
  if (currentUser?.username !== currentEvent.created_by) {
    console.error("Only the event creator can delete items.");
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
    console.error(`Error deleting item: ${error.message}`);
  } else {
    loadEvent(currentEvent.slug);
  }
}

async function commitItem(itemId) {
  const inputEl = document.getElementById(`commit-${itemId}`);
  const quantity = parseInt(inputEl.value);
  if (isNaN(quantity) || quantity <= 0) { // only allow positive integers
    console.error("Please enter a positive integer for commitment.");
    return;
  }
  const { data: itemData, error: itemError } = await supabase
    .from('event_items')
    .select('quantity_required')
    .eq('id', itemId)
    .single();
  if (itemError || !itemData) {
    console.error(`Error fetching item details: ${itemError?.message}`);
    return;
  }
  const requiredQuantity = itemData.quantity_required;
  const { data: commitmentsData } = await supabase
    .from('commitments')
    .select('quantity')
    .eq('item_id', itemId);
  const totalCommitted = commitmentsData?.reduce((sum, c) => sum + c.quantity, 0) || 0;
  const { data: myCommitData } = await supabase
    .from('commitments')
    .select('quantity')
    .eq('item_id', itemId)
    .eq('user_id', currentUser.id)
    .single();
  const myCurrent = myCommitData ? myCommitData.quantity : 0;
  const available = requiredQuantity - (totalCommitted - myCurrent);
  if (quantity > available) {
    console.error(`Cannot commit ${quantity}. Only ${available} slots are available.`);
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
    console.error(`Error committing item: ${error.message}`);
  } else {
    loadEvent(currentEvent.slug);
  }
}

// ----------------------
// 5. Helper: Attach Commit Listeners (stub)
// ----------------------
function attachCommitListeners() {
  // Inline onclick handlers in renderCommitmentForm already handle commitments.
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
