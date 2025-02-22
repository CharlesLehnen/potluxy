// Import the Supabase client and config
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

// Initialize Supabase client
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let items = [];
let currentEvent = null;
let currentUser = null;

// Render the form to create a new event
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

    // Attach event listeners
    document.getElementById('addItemButton').addEventListener('click', addItem);
    document.getElementById('eventForm').addEventListener('submit', createEvent);
}

// Add an item to the list before creating the event
function addItem() {
    const itemName = document.getElementById('itemName').value;
    const itemQuantity = document.getElementById('itemQuantity').value;
    
    if (itemName && itemQuantity) {
        items.push({ name: itemName, quantity: parseInt(itemQuantity) });
        updateItemList();
        document.getElementById('itemName').value = '';
        document.getElementById('itemQuantity').value = '';
    }
}

// Update the item list display
function updateItemList() {
    const itemList = document.getElementById('itemList');
    itemList.innerHTML = '';
    items.forEach((item, index) => {
        const itemElement = document.createElement('div');
        itemElement.className = 'item';
        itemElement.innerHTML = `
            <span>${item.name} (${item.quantity})</span>
            <button class="removeItemButton" data-index="${index}">✖</button>
        `;
        itemList.appendChild(itemElement);
    });

    // Attach event listeners for remove buttons
    document.querySelectorAll('.removeItemButton').forEach(button => {
        button.addEventListener('click', () => removeItem(button.dataset.index));
    });
}

// Remove an item from the list
function removeItem(index) {
    items.splice(index, 1);
    updateItemList();
}

// Create an event and insert into Supabase
async function createEvent(e) {
    e.preventDefault();
    const eventName = document.getElementById('eventName').value;

    if (eventName && items.length > 0) {
        const { data: eventData, error: eventError } = await supabase
            .from('events')
            .insert({ event_name: eventName })
            .single();

        if (eventError) {
            alert("Error creating event: " + eventError.message);
            return;
        }

        const eventId = eventData.id;

        // Insert items into the event_items table
        for (let item of items) {
            const { error: itemError } = await supabase
                .from('event_items')
                .insert({
                    event_id: eventId,
                    item_name: item.name,
                    quantity_required: item.quantity
                });

            if (itemError) {
                alert("Error adding item: " + itemError.message);
                return;
            }
        }

        alert(`Event created! Share this link with your friends:\n${location.origin}/event/${eventId}`);
        window.history.pushState({}, '', `/event/${eventId}`);
        loadEvent(eventId);
    } else {
        alert('Please enter an event name and add at least one item.');
    }
}

// Load event details from Supabase
async function loadEvent(eventId) {
    const { data: eventData, error: eventError } = await supabase
        .from('events')
        .select('*')
        .eq('id', eventId)
        .single();

    if (eventError || !eventData) {
        alert('Event not found');
        renderCreateEventForm();
        return;
    }

    const { data: itemsData, error: itemsError } = await supabase
        .from('event_items')
        .select('*')
        .eq('event_id', eventId);

    if (itemsError) {
        alert('Error fetching event items: ' + itemsError.message);
        return;
    }

    currentEvent = { id: eventId, name: eventData.event_name, items: itemsData };
    renderEventDetails();
}

// Render event details, user login, and commitments
async function renderEventDetails() {
    const { data: commitmentsData, error: commitmentsError } = await supabase
        .from('commitments')
        .select('*, event_items(item_name), users(username)')
        .eq('event_id', currentEvent.id);

    let commitmentHTML = '<h3>Current Commitments</h3>';
    if (!commitmentsData || commitmentsData.length === 0) {
        commitmentHTML += '<p>No commitments yet.</p>';
    } else {
        const grouped = {};
        commitmentsData.forEach(commit => {
            const user = commit.users?.username || 'Unknown';
            if (!grouped[user]) grouped[user] = [];
            grouped[user].push({ item: commit.event_items?.item_name, quantity: commit.quantity });
        });

        for (let user in grouped) {
            commitmentHTML += `<div class="commitment"><strong>${user}</strong> is bringing:<br>`;
            grouped[user].forEach(commit => {
                commitmentHTML += `- ${commit.quantity} ${commit.item}<br>`;
            });
            commitmentHTML += '</div>';
        }
    }

    const app = document.getElementById('app');
    app.innerHTML = `
        <div id="eventDetails">
            <h2>${currentEvent.name}</h2>
            <div id="commitmentSummary">${commitmentHTML}</div>
            <form id="loginForm">
                <h3>Login or Sign Up</h3>
                <label for="username">Your Name:</label>
                <input type="text" id="username" required>
                <label for="password">Password (optional):</label>
                <input type="password" id="password">
                <button type="submit">Login / Sign Up</button>
            </form>
            <div id="errorMessage" class="error"></div>
            <div id="commitFormContainer" style="display: none;">
                <form id="commitForm">
                    <h3>Commit to Bringing Items</h3>
                    <div id="commitList"></div>
                    <button type="submit">Commit to Bring Items</button>
                </form>
            </div>
        </div>
    `;

    document.getElementById('loginForm').addEventListener('submit', handleLogin);
}

// Handle user login and sign-up
async function handleLogin(e) {
    e.preventDefault();
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;

    const { data: usersData, error: usersError } = await supabase
        .from('users')
        .select('*')
        .eq('event_id', currentEvent.id)
        .eq('username', username)
        .single();

    if (usersData) {
        if (usersData.password && usersData.password !== password) {
            document.getElementById('errorMessage').textContent = 'Incorrect password. Please try again.';
            return;
        }
        currentUser = usersData;
    } else {
        const { data: newUser, error: newUserError } = await supabase
            .from('users')
            .insert({ event_id: currentEvent.id, username, password })
            .single();

        if (newUserError) {
            alert('Error creating user: ' + newUserError.message);
            return;
        }
        currentUser = newUser;
    }

    document.getElementById('loginForm').style.display = 'none';
    document.getElementById('errorMessage').textContent = '';
    document.getElementById('commitFormContainer').style.display = 'block';
    renderCommitForm();
}

// Render the commitment form for users
async function renderCommitForm() {
    const commitList = document.getElementById('commitList');
    commitList.innerHTML = '';

    const { data: userCommits } = await supabase
        .from('commitments')
        .select('*')
        .eq('event_id', currentEvent.id)
        .eq('user_id', currentUser.id);

    const userCommitMap = {};
    if (userCommits) {
        userCommits.forEach(commit => {
            userCommitMap[commit.item_id] = commit.quantity;
        });
    }

    for (let item of currentEvent.items) {
        const { data: itemCommits } = await supabase
            .from('commitments')
            .select('quantity')
            .eq('event_id', currentEvent.id)
            .eq('item_id', item.id);

        const totalCommitted = itemCommits?.reduce((sum, commit) => sum + commit.quantity, 0) || 0;
        const currentCommitment = userCommitMap[item.id] || 0;
        const remainingNeeded = item.quantity_required - (totalCommitted - currentCommitment);

        const itemElement = document.createElement('div');
        itemElement.className = 'item';
        itemElement.innerHTML = `
            <span>${item.item_name} (${remainingNeeded} needed)</span>
            <input type="number" id="commit-${item.id}" min="0" max="${remainingNeeded}" value="${currentCommitment}">
        `;
        commitList.appendChild(itemElement);
    }

    document.getElementById('commitForm').addEventListener('submit', commitItems);
}

// Handle item commitments by users
async function commitItems(e) {
    e.preventDefault();

    await supabase
        .from('commitments')
        .delete()
        .eq('event_id', currentEvent.id)
        .eq('user_id', currentUser.id);

    for (let item of currentEvent.items) {
        const quantity = parseInt(document.getElementById(`commit-${item.id}`).value) || 0;
        if (quantity > 0) {
            const { error: insertError } = await supabase
                .from('commitments')
                .insert({
                    event_id: currentEvent.id,
                    user_id: currentUser.id,
                    item_id: item.id,
                    quantity
                });

            if (insertError) {
                alert('Error inserting commitment: ' + insertError.message);
                return;
            }
        }
    }

    alert('Thank you for your commitment!');
    renderEventDetails();
}

// Initial render based on the URL
function initApp() {
    const path = window.location.pathname;
    if (path.startsWith('/event/')) {
        const eventId = path.split('/')[2];
        loadEvent(eventId);
    } else {
        renderCreateEventForm();
    }
}

// Handle browser navigation
window.onpopstate = initApp;

// Initialize the app
window.addEventListener('DOMContentLoaded', initApp);
