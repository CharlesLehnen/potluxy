// Utility: Construct event-specific email from username and event slug.
function constructEmail(username, slug) {
  return `${username}.${slug}@mailinator.com`;
}

// ----------------------
// 1. Event Creation (for creators)
// ----------------------
async function renderCreateEventForm() {
  const app = document.getElementById("app");
  app.innerHTML = `
    <form id="eventForm" class="form">
      <h2>Create New Event</h2>
      <br><br>
      <label for="eventName">Event Name:</label>
      <input type="text" id="eventName" required>
      <br><br>
      <label for="username">Your Event Username:</label>
      <input type="text" id="username" required>
      <br><br>
      <button type="submit">Create Event</button>
    </form>
  `;
  document.getElementById("eventForm").addEventListener("submit", createEvent);
}

async function createEvent(e) {
  e.preventDefault();
  const eventName = document.getElementById("eventName").value.trim();
  const username = document.getElementById("username").value.trim();
  if (!eventName || !username) {
    alert("Event name and username are required.");
    return;
  }
  const slug = generateSlug(eventName);

  const response = await fetch("https://wkbksxgqltncpluhvhdj.supabase.co/functions/v1/fetchData", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "create_event",
      event_name: eventName,
      slug,
      created_by: username,
    }),
  });

  const { data, error } = await response.json();
  if (error) {
    alert(`Error creating event: ${error.message}`);
    return;
  }

  alert(`Event created successfully! Share this link: ${location.origin}/#/event/${slug}`);
  window.location.hash = `#/event/${slug}`;
  loadEvent(slug);
}

async function loadEvent(slug) {
  const response = await fetch("https://wkbksxgqltncpluhvhdj.supabase.co/functions/v1/fetchData");
  const { data, error } = await response.json();
  
  if (error) {
    console.error("Error fetching events:", error);
    return;
  }

  const eventData = data.find(event => event.slug === slug);
  if (!eventData) {
    alert("Event not found.");
    renderCreateEventForm();
    return;
  }

  currentEvent = eventData;
  renderEventDashboard();
}

async function renderEventDashboard() {
  const app = document.getElementById("app");
  app.innerHTML = `
    <h2>${currentEvent.event_name}</h2>
    <p>${currentEvent.event_description || "No description available."}</p>
    <p>${currentEvent.event_date ? `Date: ${currentEvent.event_date}` : ""}</p>
  `;
}

// ----------------------
// 6. App Initialization with Hash Routing
// ----------------------
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
