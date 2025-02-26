// Import Supabase client
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

let supabase;

// Initialize Supabase by fetching credentials from Edge Function
async function initializeSupabase() {
    const response = await fetch("https://YOUR_SUPABASE_PROJECT.supabase.co/functions/v1/fetchData");
    const { projectUrl, anonKey } = await response.json();
    
    return createClient(projectUrl, anonKey);
}

// Utility: Construct event-specific email from username and event slug.
function constructEmail(username, slug) {
    return `${username}.${slug}@mailinator.com`;
}

// Event Creation
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
            <textarea id="eventDescription"></textarea>
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
            <button type="submit">Create Event</button>
        </form>
    `;
    document.getElementById('eventForm').addEventListener('submit', createEvent);
}

async function createEvent(e) {
    e.preventDefault();
    const eventName = document.getElementById('eventName').value.trim();
    const username = document.getElementById('username').value.trim();
    if (!eventName || !username) {
        alert('Event name and username are required.');
        return;
    }
    
    const slug = eventName.toLowerCase().replace(/\s+/g, '-') + '-' + Math.random().toString(36).substring(2, 10);
    const email = constructEmail(username, slug);

    const { data: eventData, error: eventError } = await supabase
        ?.from('events')
        .insert([{ event_name: eventName, slug, created_by: username }])
        .select()
        .single();

    if (eventError) {
        alert(`Error creating event: ${eventError.message}`);
        return;
    }

    alert(`Event created successfully! Share this link: ${location.origin}/#/event/${slug}`);
    window.location.hash = `#/event/${slug}`;
    loadEvent(slug);
}

// Load Event Data
async function loadEvent(slug) {
    const { data: eventData, error: eventError } = await supabase
        ?.from('events')
        .select('*, event_items(*)')
        .eq('slug', slug)
        .single();

    if (eventError || !eventData) {
        alert('Event not found.');
        renderCreateEventForm();
        return;
    }

    document.getElementById('app').innerHTML = `
        <h2>${eventData.event_name}</h2>
        <p>${eventData.event_description || ''}</p>
        <p>Date: ${eventData.event_date || 'Not set'}</p>
        <p>Time: ${eventData.event_time || 'Not set'}</p>
    `;
}

// Setup function to initialize everything
async function setup() {
    supabase = await initializeSupabase();
    let slug = window.location.hash.startsWith("#/event/") ? window.location.hash.split("#/event/")[1] : null;
    slug ? await loadEvent(slug) : renderCreateEventForm();
}

// Event listener to run setup when the page loads
window.addEventListener('DOMContentLoaded', setup);
