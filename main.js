// Import Supabase client and config
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

// Initialize Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
let currentEvent = null;
let currentUser = null; // This will be managed via supabase.auth

// Utility: Construct event-specific email from username and event slug.
function constructEmail(username, slug) {
  // For example, if your domain is example.com, use:
  return `${username}.${slug}@mailinator.com`;
}

// ----------------------
// 1. Event Creation (for creators)
// ----------------------
async function renderCreateEventForm() {
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

// Ensure the user is authenticated before inserting into event_users
async function createEvent(e) {
    e.preventDefault();
    const eventName = document.getElementById('eventName').value.trim();
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value.trim();
    const eventSlug = generateSlug(eventName);
    const email = constructEmail(username, eventSlug);

    // 1. Sign up the user
    const { data: authData, error: signUpError } = await supabase.auth.signUp({
        email,
        password: password || 'no-password'
    });

    if (signUpError) {
        alert(`Error signing up: ${signUpError.message}`);
        return;
    }

    // 2. Ensure the user session is active
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
    if (sessionError || !sessionData.session) {
        alert('Error: User not fully authenticated after signup.');
        return;
    }

    const userId = sessionData.session.user.id;

    // 3. Create the event
    const { data: eventData, error: eventError } = await supabase
        .from('events')
        .insert([{ event_name: eventName, slug: eventSlug, created_by: username }])
        .select()
        .single();

    if (eventError) {
        alert(`Error creating event: ${eventError.message}`);
        return;
    }

    const eventId = eventData.id;

    // 4. Insert event user (linked to auth.uid())
    const { data: profileData, error: profileError } = await supabase
        .from('event_users')
        .insert([{ id: userId, event_id: eventId, username }]);

    if (profileError) {
        alert(`Error creating event user: ${profileError.message}`);
        return;
    }

    alert(`Event created successfully! Share this link: ${location.origin}/event/${eventSlug}`);
    window.location.hash = `#/event/${eventSlug}`;
    loadEvent(eventSlug);
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
    // Fetch the event_users record for this user and event.
    const { data: profileData } = await supabase
      .from('event_users')
      .select('*')
      .eq('id', session.user.id)
      .eq('event_id', currentEvent.id)
      .single();
    if (!profileData) {
      // If no profile exists, you can create one now.
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
  
  // Sign in via Supabase Auth.
  const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
    email, password: password || 'no-password'
  });
  if (signInError) {
    alert(`Error signing in: ${signInError.message}`);
    return;
  }
  // Fetch (or create) the event-specific profile.
  const { data: profileData } = await supabase
    .from('event_users')
    .select('*')
    .eq('id', signInData.session.user.id)
    .eq('event_id', currentEvent.id)
    .single();
  if (!profileData) {
    // Create profile if it doesn't exist.
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
// (This section is similar to your existing code; the JWT is now managed by Supabase Auth.)
// ----------------------
async function renderEventDashboard() {
  const app = document.getElementById('app');
  const isCreator = currentUser?.username === currentEvent.created_by;
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
    if (!newItemName || newQuantity <= 0) {
        alert("Please provide valid values.");
        return;
    }

    // Get total committed so far
    const { data: commitmentsData, error: commitmentsError } = await supabase
        .from('commitments')
        .select('quantity')
        .eq('item_id', itemId);

    const totalCommitted = commitmentsData?.reduce((sum, c) => sum + c.quantity, 0) || 0;

    if (newQuantity < totalCommitted) {
        alert(`Cannot reduce required quantity to ${newQuantity}. ${totalCommitted} already committed.`);
        return;
    }

    // Update item quantity
    const { error } = await supabase
        .from('event_items')
        .update({ item_name: newItemName, quantity_required: newQuantity })
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
    const { data: commitmentsData, error: commitmentsError } = await supabase
        .from('commitments')
        .select('quantity')
        .eq('item_id', itemId);

    const totalCommitted = commitmentsData?.reduce((sum, c) => sum + c.quantity, 0) || 0;
    const available = requiredQuantity - (totalCommitted - (currentUser?.quantity || 0));  // Subtract user's current commitment

    if (quantity > available) {
        alert(`Cannot commit ${quantity}. Only ${available} slots are available.`);
        return;
    }

    // Upsert commitment using onConflict.
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
// 6. App Initialization
// ----------------------
window.addEventListener('DOMContentLoaded', async () => {
  const hash = window.location.hash;
  if (hash && hash.startsWith("#/event/")) {
    const slug = hash.split("#/event/")[1];
    await loadEvent(slug);
  } else {
    renderCreateEventForm();
  }
});
