// Import Supabase client and config
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

// Initialize Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
let items = [];
let currentEvent = null;
let currentUser = null;
let eventCreator = null;

// Render Event Creation Form
function renderCreateEventForm() {
    const app = document.getElementById('app');
    app.innerHTML = `
        <form id="eventForm">
            <h2>Create New Event</h2>
            <label for="eventName">Event Name:</label>
            <input type="text" id="eventName" required>

            <label for="itemName">Item Name:</label>
            <input type="text" id="itemName">

            <label for="itemQuantity">Quantity Needed:</label>
            <input type="number" id="itemQuantity" min="1">

            <button type="button" id="addItemButton">Add Item</button>
            <div id="itemList"></div>

            <button type="submit">Create Event</button>
        </form>
    `;

    document.getElementById('addItemButton').addEventListener('click', addItem);
    document.getElementById('eventForm').addEventListener('submit', createEvent);
}

// Add Item to List
function addItem() {
    const itemName = document.getElementById('itemName').value;
    const itemQuantity = parseInt(document.getElementById('itemQuantity').value);
    if (itemName && itemQuantity > 0) {
        items.push({ name: itemName, quantity: itemQuantity });
        updateItemList();
        document.getElementById('itemName').value = '';
        document.getElementById('itemQuantity').value = '';
    }
}

// Update Item List Display
function updateItemList() {
    const itemList = document.getElementById('itemList');
    itemList.innerHTML = '';
    items.forEach((item, index) => {
        const itemElement = document.createElement('div');
        itemElement.innerHTML = `${item.name} (${item.quantity}) 
        <button class="removeItem" data-index="${index}">Remove</button>`;
        itemList.appendChild(itemElement);
    });

    document.querySelectorAll('.removeItem').forEach(button => {
        button.addEventListener('click', () => removeItem(button.dataset.index));
    });
}

// Remove Item from List
function removeItem(index) {
    items.splice(index, 1);
    updateItemList();
}

// Generate Unique Slug for Event
function generateSlug(eventName) {
    const uniqueId = Math.random().toString(36).substring(2, 10);
    return eventName.toLowerCase().replace(/\s+/g, '-') + '-' + uniqueId;
}

// Hash Password (SHA-256)
async function hashPassword(password) {
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
    const slug = generateSlug(eventName);

    if (!eventName || items.length === 0) {
        alert('Please enter an event name and add at least one item.');
        return;
    }

    try {
        // Insert the event
        const { data: eventData, error: eventError } = await supabase
            .from('events')
            .insert([{ event_name: eventName, slug, created_by: 'anonymous' }])
            .select()
            .single();

        if (eventError) {
            alert(`Error creating event: ${eventError.message}`);
            return;
        }

        const eventId = eventData.id;

        // Insert event items
        for (const item of items) {
            const { error: itemError } = await supabase
                .from('event_items')
                .insert([{ event_id: eventId, item_name: item.name, quantity_required: item.quantity }]);

            if (itemError) {
                alert(`Error adding item: ${itemError.message}`);
                return;
            }
        }

        alert(`Event created successfully! Share this link: ${location.origin}/event/${slug}`);
        window.history.pushState({}, '', `/event/${slug}`);
        loadEvent(slug);
    } catch (error) {
        console.error('Unexpected error:', error);
        alert('An unexpected error occurred while creating the event.');
    }
}

// Load Event by Slug
async function loadEvent(slug) {
    const { data: eventData, error: eventError } = await supabase
        .from('events')
        .select('id, event_name, created_by')
        .eq('slug', slug)
        .single();

    if (eventError || !eventData) {
        alert('Event not found.');
        renderCreateEventForm();
        return;
    }

    eventCreator = eventData.created_by;

    const { data: itemsData, error: itemsError } = await supabase
        .from('event_items')
        .select('*')
        .eq('event_id', eventData.id);

    if (itemsError) {
        alert(`Error fetching items: ${itemsError.message}`);
        return;
    }

    currentEvent = { id: eventData.id, name: eventData.event_name, items: itemsData };
    renderEventDetails();
}

// Render Event Details
function renderEventDetails() {
    const app = document.getElementById('app');
    app.innerHTML = `
        <h2>${currentEvent.name}</h2>
        <h3>Items Needed:</h3>
        <ul>
            ${currentEvent.items.map(item => `<li>${item.item_name} - ${item.quantity_required} needed</li>`).join('')}
        </ul>
        <h3>Login to Commit:</h3>
        <form id="loginForm">
            <label for="username">Username:</label>
            <input type="text" id="username" required>

            <label for="password">Password:</label>
            <input type="password" id="password" required>

            <button type="submit">Login / Sign Up</button>
        </form>
    `;

    document.getElementById('loginForm').addEventListener('submit', handleLogin);
}

// Handle User Login and Signup
async function handleLogin(e) {
    e.preventDefault();
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    const passwordHash = await hashPassword(password);

    const { data: existingUser } = await supabase
        .from('users')
        .select('*')
        .eq('event_id', currentEvent.id)
        .eq('username', username)
        .single();

    if (existingUser) {
        if (existingUser.password_hash !== passwordHash) {
            alert('Incorrect password.');
            return;
        }
        currentUser = existingUser;
    } else {
        const { data: newUser, error: userError } = await supabase
            .from('users')
            .insert([{ event_id: currentEvent.id, username, password_hash: passwordHash }])
            .single();

        if (userError) {
            alert(`Error creating user: ${userError.message}`);
            return;
        }

        currentUser = newUser;
    }

    renderCommitForm();
}

// Render Commitment Form
function renderCommitForm() {
    const app = document.getElementById('app');
    app.innerHTML += `
        <h3>Commit to Items</h3>
        ${currentEvent.items.map(item => `
            <div>
                ${item.item_name} (${item.quantity_required} needed)
                <input type="number" id="commit-${item.id}" min="0">
                <button onclick="commitItem('${item.id}')">Commit</button>
            </div>
        `).join('')}
    `;
}

// Commit Item
async function commitItem(itemId) {
    const quantity = parseInt(document.getElementById(`commit-${itemId}`).value);
    if (quantity > 0) {
        const { error } = await supabase
            .from('commitments')
            .upsert([{ event_id: currentEvent.id, user_id: currentUser.id, item_id: itemId, quantity }]);

        if (error) {
            alert(`Error committing item: ${error.message}`);
        } else {
            alert('Commitment successful!');
        }
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
