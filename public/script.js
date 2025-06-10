const socket = io();
const map = L.map('map').setView([-25.7479, 28.2293], 13); // Centered on Pretoria, South Africa

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
}).addTo(map);

const markers = {}; // Stores Leaflet markers by incident _id
const incidentList = document.getElementById('incident-list');
const noIncidentsMessage = document.getElementById('no-incidents-message');
const alertSound = document.getElementById('alertSound');

function updateNoIncidentsMessage() {
    if (Object.keys(markers).length === 0) {
        noIncidentsMessage.style.display = 'block';
    } else {
        noIncidentsMessage.style.display = 'none';
    }
}

function addIncidentToMapAndList(incident) {
    // Check if incident already exists (e.g., on initial load if already processed)
    if (markers[incident._id]) {
        return; // Skip if already present
    }

    // Add marker to map
    const marker = L.marker([incident.latitude, incident.longitude]).addTo(map)
        .bindPopup(`<b>Incident #${incident._id.substring(0, 8)}...</b><br>Reporter: ${incident.reporter_name}<br>Status: ${incident.status}<br>Lat: ${incident.latitude}<br>Lon: ${incident.longitude}`);
    markers[incident._id] = marker;

    // Add incident to list
    const listItem = document.createElement('li');
    listItem.id = `incident-${incident._id}`; // Use MongoDB _id
    listItem.innerHTML = `
        <div class="incident-info">
            <strong>Incident ID: ${incident._id}</strong><br>
            Reporter: ${incident.reporter_name}<br>
            Status: <span id="status-${incident._id}">${incident.status}</span><br>
            Time: ${new Date(incident.timestamp).toLocaleString()}
        </div>
        <div class="incident-actions">
            <button onclick="deleteIncident('${incident._id}')">Delete Incident</button>
        </div>
    `;
    incidentList.prepend(listItem); // Add to the top of the list
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
    updateNoIncidentsMessage();
}

function updateIncidentStatusInList(incident) { // incident is the full updated object
    const statusSpan = document.getElementById(`status-${incident._id}`);
    if (statusSpan) {
        statusSpan.textContent = incident.status;
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

// --- Socket.IO Listeners ---

socket.on('initial_incidents', (initialIncidents) => {
    console.log('Received initial incidents:', initialIncidents);
    // Clear existing incidents before adding initial ones to prevent duplicates on reconnect
    Object.keys(markers).forEach(id => removeIncidentFromMapAndList(id));
    initialIncidents.forEach(incident => addIncidentToMapAndList(incident));
});

socket.on('new_incident', (incident) => {
    console.log('New incident received:', incident);
    addIncidentToMapAndList(incident);
    // Play alert sound
    if (alertSound) {
        alertSound.play().catch(e => console.error("Error playing sound:", e));
    }
});

socket.on('incident_deleted', (incidentId) => { // incidentId is the MongoDB _id string
    console.log('Incident deleted:', incidentId);
    removeIncidentFromMapAndList(incidentId);
});

socket.on('incident_updated', (incident) => { // incident is the full updated object
    console.log('Incident updated:', incident);
    updateIncidentStatusInList(incident);
});

updateNoIncidentsMessage(); // Initial check on page load