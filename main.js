// Import Supabase client and config
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

// Initialize Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
let currentEvent = null;
let currentUser = null;

// Render Event Creation Form
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

// Generate Unique Slug for Event
function generateSlug(eventName) {
    const uniqueId = Math.random().toString(36).substring(2, 10);
    return eventName.toLowerCase().replace(/\s+/g, '-') + '-' + uniqueId;
}

// Hash Password (SHA-256)
async function hashPassword(password) {
    if (!password) return null;
    const encoder = new TextEncoder();
    const data = encoder.encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer))
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join('');
}

// Create Event in Supabase
async function createEvent(e) {
  e.preventDefault();

  // Correct input ID references to match the HTML form
  const eventNameInput = document.getElementById('eventName');
  const usernameInput = document.getElementById('username');  // Corrected ID
  const passwordInput = document.getElementById('password');  // Corrected ID

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

  // Generate slug for the event
  const slug = generateSlug(eventName);

  // Hash the password if provided
  const passwordHash = password ? await hashPassword(password) : null;

  try {
      // Insert the event
      const { data: eventData, error: eventError } = await supabase
          .from('events')
          .insert([{ event_name: eventName, slug, created_by: username }])
          .select()
          .single();

      if (eventError) {
          throw new Error(`Error creating event: ${eventError.message}`);
      }

      const eventId = eventData.id;

      // Create user associated with the event
      const { error: userError } = await supabase
          .from('users')
          .insert([{ event_id: eventId, username, password_hash: passwordHash }]);

      if (userError) {
          throw new Error(`Error creating user: ${userError.message}`);
      }

      // Automatically log in as the event creator
      currentUser = { username, passwordHash };
      alert(`Event created successfully! Share this link: ${location.origin}/event/${slug}`);
      window.history.pushState({}, '', `/event/${slug}`);
      loadEvent(slug, username, passwordHash);


  } catch (error) {
      console.error(error);
      alert(error.message || 'Failed to create the event.');
  }
}



async function loadEvent(slug, username = null, passwordHash = null) {
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

  // If user info is passed, auto-login
  if (username && passwordHash) {
      const { data: userData, error: userError } = await supabase
          .from('users')
          .select('*')
          .eq('event_id', currentEvent.id)
          .eq('username', username)
          .single();

      if (userData && userData.password_hash === passwordHash) {
          currentUser = userData;
          renderEventDashboard();
          return;
      }
  }

  // If no auto-login, show login form
  renderLoginForm();
}



// Render Login Form
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
    `;

    document.getElementById('loginForm').addEventListener('submit', handleLogin);
}

// Handle User Login and Signup
async function handleLogin(e) {
    e.preventDefault();
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value;
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
    } else {
        // Sign up user if not exists
        const { data: newUser, error: newUserError } = await supabase
            .from('users')
            .insert([{ 
                event_id: currentEvent.id,
                username,
                password_hash: passwordHash
            }])
            .select()
            .single();

        if (newUserError) {
            alert(`Error signing up: ${newUserError.message}`);
            return;
        }
        currentUser = newUser;
    }

    renderEventDashboard();
}

// Render Event Dashboard
function renderEventDashboard() {
    const app = document.getElementById('app');
    const isCreator = currentUser.username === currentEvent.created_by;

    app.innerHTML = `
      <h2>${currentEvent.event_name}</h2>
      <div style="display: flex; gap: 20px;">
          <div>
              <h3>Items Needed</h3>
              ${isCreator ? renderManageItems() : renderViewItems()}
          </div>
          <div>
              <h3>Your Commitments</h3>
              ${renderCommitmentForm()}
          </div>
      </div>
    `;

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
          <input type="text" id="itemName" placeholder="Item Name" required>
          <input type="number" id="itemQuantity" placeholder="Quantity" min="1" required>
          <button type="submit">Add Item</button>
      </form>
  `;
}


// Render View Items (Guests)
function renderViewItems() {
  if (!currentEvent.items || currentEvent.items.length === 0) {
      return `<p>No items listed for this event yet.</p>`;
  }

  return currentEvent.items.map(item => `
      <p>${item.item_name} - ${item.quantity_required} needed</p>
  `).join('');
}


// Render Commitment Form
function renderCommitmentForm() {
  return currentEvent.items.map(item => `
      <div>
          ${item.item_name} (${item.quantity_required} needed)
          <input type="number" id="commit-${item.id}" min="0">
          <button onclick="commitItem('${item.id}')">Commit</button>
      </div>
  `).join('');
}

// Commit Item
async function commitItem(itemId) {
    const quantity = parseInt(document.getElementById(`commit-${itemId}`).value);
    if (quantity > 0) {
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
        }
    }
}

// Update an Item (Event Creator Only)
async function updateItem(itemId) {
  const itemName = document.getElementById(`edit-item-${itemId}`).value.trim();
  const quantity = parseInt(document.getElementById(`edit-qty-${itemId}`).value);

  const { error } = await supabase
      .from('event_items')
      .update({ item_name: itemName, quantity_required: quantity })
      .eq('id', itemId);

  if (error) {
      alert(`Error updating item: ${error.message}`);
  } else {
      alert('Item updated!');
      loadEvent(currentEvent.slug);
  }
}

// Delete an Item (Event Creator Only)
async function deleteItem(itemId) {
  const { error } = await supabase
      .from('event_items')
      .delete()
      .eq('id', itemId);

  if (error) {
      alert(`Error deleting item: ${error.message}`);
  } else {
      alert('Item deleted!');
      loadEvent(currentEvent.slug);
  }
}

// Update Commitment
async function updateCommitment(itemId) {
  const quantity = parseInt(document.getElementById(`commit-${itemId}`).value);

  const { error } = await supabase
      .from('commitments')
      .upsert([{ 
          event_id: currentEvent.id,
          user_id: currentUser.id,
          item_id: itemId,
          quantity
      }]);

  if (error) {
      alert(`Error updating commitment: ${error.message}`);
  } else {
      alert('Commitment updated!');
      loadEvent(currentEvent.slug);
  }
}


// Initialize App
window.addEventListener('DOMContentLoaded', () => {
    const slug = window.location.pathname.split('/event/')[1];
    if (slug) {
        loadEvent(slug);
    } else {
        renderCreateEventForm();
    }
});
