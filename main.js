// Import Supabase client and config
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

// Initialize Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
let currentEvent = null;
let currentUser = JSON.parse(localStorage.getItem('currentUser')) || null;

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

    const eventName = document.getElementById('eventName').value.trim();
    const username = document.getElementById('username').value.trim();
    const password = document.getElementById('password').value.trim() || '';

    if (!eventName || !username) {
        alert('Event name and username are required.');
        return;
    }

    const slug = generateSlug(eventName);
    const passwordHash = password ? await hashPassword(password) : null;

    try {
        // Insert event
        const { data: eventData, error: eventError } = await supabase
            .from('events')
            .insert([{ event_name: eventName, slug, created_by: username }])
            .select()
            .single();

        if (eventError) throw new Error(`Error creating event: ${eventError.message}`);

        const eventId = eventData.id;

        // Insert user associated with the event
        const { error: userError } = await supabase
            .from('users')
            .insert([{ event_id: eventId, username, password_hash: passwordHash }]);

        if (userError) throw new Error(`Error creating user: ${userError.message}`);

        // Fetch user ID and store in currentUser
        const { data: userData, error: userFetchError } = await supabase
            .from('users')
            .select('id')
            .eq('event_id', eventId)
            .eq('username', username)
            .single();

        if (userFetchError) throw new Error(`Error fetching user ID: ${userFetchError.message}`);

        currentUser = { username, passwordHash, id: userData.id };
        localStorage.setItem('currentUser', JSON.stringify(currentUser));

        alert(`Event created successfully! Share this link: ${location.origin}/event/${slug}`);
        window.history.pushState({}, '', `/event/${slug}`);
        loadEvent(slug);
    } catch (error) {
        console.error(error);
        alert(error.message || 'Failed to create the event.');
    }
}

// Load Event
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

    // Ensure currentUser ID is populated
    if (currentUser?.username) {
        const { data: userData, error: userError } = await supabase
            .from('users')
            .select('id')
            .eq('event_id', currentEvent.id)
            .eq('username', currentUser.username)
            .single();

        if (userData) {
            currentUser.id = userData.id;
            localStorage.setItem('currentUser', JSON.stringify(currentUser));
        }
    }

    renderEventDashboard();
}

// Render Event Dashboard
function renderEventDashboard() {
    const app = document.getElementById('app');
    const isCreator = currentUser?.username === currentEvent.created_by;

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

    if (isCreator) {
        document.getElementById('addItemForm')?.addEventListener('submit', handleAddItem);
    }

    attachCommitListeners();
}

// Handle Add Item
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
        .insert([{ event_id: currentEvent.id, item_name: newItemName, quantity_required: newItemQuantity }]);

    if (error) {
        alert(`Error adding item: ${error.message}`);
    } else {
        alert("Item added successfully!");
        loadEvent(currentEvent.slug);
    }
}

// Render Manage Items
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

// Attach Commit Listeners
function attachCommitListeners() {
    currentEvent.items.forEach(item => {
        const button = document.getElementById(`commit-btn-${item.id}`);
        if (button) {
            button.addEventListener('click', () => commitItem(item.id));
        }
    });
}

// Render Commitment Form
function renderCommitmentForm() {
    return currentEvent.items.map(item => `
        <div>
            ${item.item_name} (${item.quantity_required} needed)
            <input type="number" id="commit-${item.id}" min="0">
            <button id="commit-btn-${item.id}">Commit</button>
        </div>
    `).join('');
}

// Commit Item
async function commitItem(itemId) {
    const quantity = parseInt(document.getElementById(`commit-${itemId}`).value);
    if (quantity > 0 && currentUser?.id) {
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
            loadEvent(currentEvent.slug);
        }
    } else {
        alert('Invalid quantity or user not authenticated.');
    }
}

// Update Item (Event Creator Only)
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
        alert('Item updated successfully!');
        loadEvent(currentEvent.slug);
    }
}

// Delete Item (Event Creator Only)
async function deleteItem(itemId) {
    const { error } = await supabase
        .from('event_items')
        .delete()
        .eq('id', itemId);

    if (error) {
        alert(`Error deleting item: ${error.message}`);
    } else {
        alert('Item deleted successfully!');
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
