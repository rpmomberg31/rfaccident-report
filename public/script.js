// public/script.js

const socket = io();
const map = L.map('map').setView([-25.7479, 28.2293], 12); // Adjusted zoom for better initial view of Pretoria

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
}).addTo(map);

const markers = {}; // Stores Leaflet markers by incident _id
const incidentList = document.getElementById('incident-list');
const noIncidentsMessage = document.getElementById('no-incidents-message');
const alertSound = document.getElementById('alertSound');

// Store a set of incident IDs currently displayed to avoid re-adding
const displayedIncidentIds = new Set();

function updateNoIncidentsMessage() {
    if (Object.keys(markers).length === 0) {
        noIncidentsMessage.style.display = 'block';
    } else {
        noIncidentsMessage.style.display = 'none';
    }
}

function addIncidentToMapAndList(incident, isNewFromPolling = false) {
    // If the incident is already displayed, do nothing (prevents duplicates from polling/socket)
    if (displayedIncidentIds.has(incident._id)) {
        // Just update status if it's already there
        updateIncidentStatusInList(incident);
        return;
    }

    // Add marker to map
    const marker = L.marker([incident.latitude, incident.longitude]).addTo(map)
        .bindPopup(`<b>Incident ID: ${incident._id.substring(0, 8)}...</b><br>Reporter: ${incident.reporter_name}<br>Status: ${incident.status}<br>Lat: ${incident.latitude}<br>Lon: ${incident.longitude}`);
    markers[incident._id] = marker;

    // Add incident to list
    const listItem = document.createElement('li');
    listItem.id = `incident-${incident._id}`; // Use MongoDB _id for unique ID
    listItem.innerHTML = `
        <div class="incident-info">
            <strong>Incident ID: ${incident._id.substring(0, 8)}...</strong><br>
            <span>Reporter: ${incident.reporter_name}</span><br>
            <span>Status: <span id="status-${incident._id}" data-status="${incident.status.toLowerCase()}">${incident.status}</span></span><br>
            <span>Time: ${new Date(incident.timestamp).toLocaleString()}</span>
        </div>
        <div class="incident-actions">
            <button onclick="deleteIncident('${incident._id}')">Delete Incident</button>
        </div>
    `;
    incidentList.prepend(listItem); // Add to the top of the list

    // Add to our set of displayed IDs
    displayedIncidentIds.add(incident._id);

    // Play alert sound only if it's genuinely a new incident detected by polling or Socket.IO
    if (alertSound) {
        // Add a small delay for better sound experience after page load
        setTimeout(() => {
            alertSound.play().catch(e => console.error("Error playing sound:", e));
        }, isNewFromPolling ? 0 : 500); // Immediate if polling, slight delay for socket.io initial load
    }
    updateNoIncidentsMessage();
}

function removeIncidentFromMapAndList(incidentId) { // incidentId is the MongoDB _id string
    // Remove marker
    if (markers[incidentId]) {
        map.removeLayer(markers[incidentId]);
        delete markers[incidentId];
    }

    // Remove from list
    const listItem = document.getElementById(`incident-${incidentId}`);
    if (listItem) {
        listItem.remove();
    }
    displayedIncidentIds.delete(incidentId); // Remove from our set
    updateNoIncidentsMessage();
}

function updateIncidentStatusInList(incident) { // incident is the full updated object
    const statusSpan = document.getElementById(`status-${incident._id}`);
    if (statusSpan) {
        statusSpan.textContent = incident.status;
        statusSpan.dataset.status = incident.status.toLowerCase(); // Update data-status attribute for CSS
    }
    // Update marker popup content as well
    if (markers[incident._id]) {
        markers[incident._id].setPopupContent(`<b>Incident ID: ${incident._id.substring(0, 8)}...</b><br>Reporter: ${incident.reporter_name}<br>Status: ${incident.status}<br>Lat: ${incident.latitude}<br>Lon: ${incident.longitude}`);
    }
}

async function deleteIncident(incidentId) { // incidentId is the MongoDB _id string
    if (confirm(`Are you sure you want to delete Incident ID: ${incidentId}?`)) {
        try {
            const response = await fetch(`/incidents/${incidentId}`, {
                method: 'DELETE'
            });

            if (response.ok) {
                console.log(`Incident ${incidentId} requested for deletion.`);
                // Server will emit 'incident_deleted' for all clients
                // The socket.on('incident_deleted') handler will handle the UI update
            } else {
                const errorData = await response.json();
                alert(`Error deleting incident: ${errorData.message}`);
            }
        } catch (error) {
            console.error('Error during fetch delete:', error);
            alert('Failed to connect to server to delete incident.');
        }
    }
}

// --- Polling for New Incidents (Every 1 Second) ---
// This is a fallback/redundancy mechanism as Socket.IO provides real-time updates.
let lastPollIncidents = []; // To keep track of incidents from the previous poll

async function fetchNewIncidents() {
    try {
        const response = await fetch('/incidents');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const currentIncidents = await response.json();

        // Convert current incidents to a Set for quick lookup of IDs that *were* there
        const currentIncidentIds = new Set(currentIncidents.map(inc => inc._id));

        // Find new incidents (present in currentIncidents but not currently displayed)
        const newIncidents = currentIncidents.filter(inc => !displayedIncidentIds.has(inc._id));

        newIncidents.forEach(incident => {
            console.log('New incident detected via polling:', incident);
            addIncidentToMapAndList(incident, true); // Pass true to trigger sound for polling
        });

        // Find incidents that were deleted (present in lastPollIncidents but not in currentIncidents)
        const deletedIncidentsInPoll = lastPollIncidents.filter(inc => !currentIncidentIds.has(inc._id));
        deletedIncidentsInPoll.forEach(incident => {
            console.log('Incident detected as deleted via polling (fallback):', incident._id);
            removeIncidentFromMapAndList(incident._id);
        });

        lastPollIncidents = currentIncidents; // Update for the next poll

    } catch (error) {
        console.error('Error fetching incidents via polling:', error);
    }
}

// Set up the polling interval
setInterval(fetchNewIncidents, 1000); // Check every 1000 milliseconds (1 second)


// --- Socket.IO Listeners (Still active for real-time, instantaneous updates) ---

socket.on('connect', () => {
    console.log('Socket.IO connected to server!');
    // On connect, request initial incidents again.
    // The `addIncidentToMapAndList` already checks for `displayedIncidentIds`.
    // fetchNewIncidents() on initial load also helps sync.
});

socket.on('initial_incidents', (initialIncidents) => {
    console.log('Received initial incidents (from Socket.IO on connect):', initialIncidents);
    initialIncidents.forEach(incident => addIncidentToMapAndList(incident));
    // Sync polling's state after initial Socket.IO load to prevent duplicates
    lastPollIncidents = initialIncidents; 
});

socket.on('new_incident', (incident) => {
    console.log('New incident received via Socket.IO:', incident);
    addIncidentToMapAndList(incident); // Socket.IO handles the alert sound here
});

socket.on('incident_deleted', (incidentId) => { // incidentId is the MongoDB _id string
    console.log('Incident deleted via Socket.IO:', incidentId);
    removeIncidentFromMapAndList(incidentId);
});

socket.on('incident_updated', (incident) => { // incident is the full updated object
    console.log('Incident updated via Socket.IO:', incident);
    updateIncidentStatusInList(incident);
});

socket.on('disconnect', () => {
    console.log('Socket.IO disconnected from server.');
});
socket.on('connect_error', (error) => {
    console.error('Socket.IO connection error:', error.message);
});

// Initial load of incidents on page load (before polling interval kicks in)
// This initial fetch ensures data is shown immediately if available.
// It also sets up `lastPollIncidents` for the first comparison.
fetchNewIncidents();
updateNoIncidentsMessage(); // Initial check on page load