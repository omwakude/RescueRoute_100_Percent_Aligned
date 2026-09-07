// Initialize Map using Esri Satellite tiles
const map = L.map('map').setView([18.5204, 73.8567], 12);

L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community'
}).addTo(map);

const hospIcon = L.divIcon({ html: '🏥', className: 'fs-4', iconSize: [30, 30] });
const ambIcon = L.divIcon({ html: '🚑', className: 'fs-4', iconSize: [30, 30] });
const patientIcon = L.divIcon({ html: '⚠️', className: 'fs-3', iconSize: [30, 30] });

let ambulanceMarkers = {}; 
let routePolyline;
let patientMarker;

function logMessage(msg) {
    const logs = document.getElementById('logs');
    logs.innerHTML += `> ${msg}<br>`;
    logs.scrollTop = logs.scrollHeight;
}

async function loadFleet() {
    const res = await fetch('/api/fleet');
    const data = await res.json();

    data.hospitals.forEach(h => {
        L.marker([h.lat, h.lng], { icon: hospIcon })
         .bindPopup(`<b>${h.name}</b><br>Capabilities: ${h.capabilities.join(', ')}`)
         .addTo(map);
    });

    data.ambulances.forEach(a => {
        const marker = L.marker([a.lat, a.lng], { icon: ambIcon })
                        .bindPopup(`<b>${a.id}</b><br>Type: ${a.type}`)
                        .addTo(map);
        ambulanceMarkers[a.id] = marker;
    });
}
loadFleet();

document.getElementById('dispatchBtn').addEventListener('click', async (e) => {
    // Frontend Race Condition Fix: Lock UI state immediately
    const btn = e.target;
    btn.disabled = true;
    btn.innerText = "⏳ CALCULATING A* PATH...";

    const type = document.getElementById('emergencyType').value;
    const patientLat = 18.4800 + (Math.random() * 0.1000);
    const patientLng = 73.8000 + (Math.random() * 0.1200);

    if (patientMarker) map.removeLayer(patientMarker);
    if (routePolyline) map.removeLayer(routePolyline);

    patientMarker = L.marker([patientLat, patientLng], { icon: patientIcon })
                    .bindPopup("🚨 Emergency Here!").addTo(map).openPopup();
    
    logMessage(`Emergency (${type}) reported at [${patientLat.toFixed(3)}, ${patientLng.toFixed(3)}]`);
    logMessage(`Running A* Algorithm to determine best unit...`);

    try {
        const response = await fetch('/api/dispatch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ patientLat, patientLng, type })
        });
        
        const optimal = await response.json();
        
        if(optimal.error) {
            logMessage(`ERROR: ${optimal.error}`);
            btn.disabled = false;
            btn.innerText = "🚨 SIMULATE & DISPATCH";
            return;
        }

        logMessage(`Dispatching ${optimal.ambulanceId} to ${optimal.hospital}`);
        logMessage(`Arrival at patient: ${optimal.ambToPatientEta} mins`);
        logMessage(`Arrival at hospital: ${optimal.patientToHospEta} mins`);
        logMessage(`Generating Polyline via TomTom...`);

        const latlngs = optimal.routePoints.map(p => [p.latitude, p.longitude]);
        routePolyline = L.polyline(latlngs, { color: '#0d6efd', weight: 6, dashArray: '10, 10' }).addTo(map);
        map.fitBounds(routePolyline.getBounds());

        const activeMarker = ambulanceMarkers[optimal.ambulanceId];
        let i = 0;
        
        function animate() {
            if (i < latlngs.length) {
                activeMarker.setLatLng(latlngs[i]);
                i++;
                setTimeout(animate, 30); 
            } else {
                logMessage(`${optimal.ambulanceId} arrived at ${optimal.hospital}. Returning to pool in 15s.`);
                activeMarker.bindPopup("Status: At Hospital").openPopup();
            }
        }
        animate();

    } catch (error) {
        logMessage("System Error: Check Server limits");
    } finally {
        // Unlock UI
        btn.disabled = false;
        btn.innerText = "🚨 SIMULATE & DISPATCH";
    }
});