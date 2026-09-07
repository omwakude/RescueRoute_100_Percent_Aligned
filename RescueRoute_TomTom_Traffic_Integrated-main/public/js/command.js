const map = L.map('commandMap').setView([18.5295, 73.8560], 13);

L.tileLayer(
    'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    { attribution: '&copy; OpenStreetMap contributors' }
).addTo(map);

const layers = {
    ambulances: L.layerGroup().addTo(map),
    emergencies: L.layerGroup().addTo(map),
    hospitals: L.layerGroup().addTo(map),
    routes: L.layerGroup().addTo(map),
    traffic: L.layerGroup().addTo(map)
};

const activity = [];

function emojiIcon(emoji, size = 30) {
    return L.divIcon({
        className: '',
        html: `<div style="
            font-size:${size}px;
            line-height:1;
            text-shadow:0 1px 3px #fff;
        ">${emoji}</div>`,
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2]
    });
}

function render(data) {
    document.getElementById('statEmergencies').textContent =
        data.emergencies.filter(e => e.status !== 'COMPLETED').length;

    document.getElementById('statAvailable').textContent =
        data.ambulances.filter(a => a.available).length;

    document.getElementById('statDispatched').textContent =
        data.ambulances.filter(a => !a.available).length;

    document.getElementById('statHospitals').textContent =
        data.hospitals.length;

    const trafficBadge = document.getElementById('trafficProvider');
    if (trafficBadge) {
        const provider = data.traffic?.provider || 'SIMULATED';
        const edges = data.traffic?.cached_edges || 0;
        trafficBadge.textContent = `TRAFFIC: ${provider} (${edges} SEGMENTS)`;
        trafficBadge.className = provider === 'TOMTOM'
            ? 'badge bg-success'
            : 'badge bg-warning text-dark';
    }

    layers.ambulances.clearLayers();
    layers.emergencies.clearLayers();
    layers.hospitals.clearLayers();
    layers.routes.clearLayers();
    layers.traffic.clearLayers();

    // Hospitals
    data.hospitals.forEach(h => {
        L.marker([h.lat, h.lng], {
            icon: emojiIcon('🏥', 27)
        })
        .bindPopup(`
            <strong>${h.name}</strong><br>
            Hospital ID: ${h.id}
        `)
        .addTo(layers.hospitals);
    });

    // Ambulances
    data.ambulances.forEach(a => {
        const active = !a.available;

        L.marker([a.lat, a.lng], {
            icon: emojiIcon(active ? '🚑' : '🟢', active ? 30 : 25)
        })
        .bindPopup(`
            <strong>${a.id}</strong><br>
            Status: ${a.status || (a.available ? 'AVAILABLE' : 'BUSY')}<br>
            ${a.assigned_emergency
                ? `Emergency: ${a.assigned_emergency}`
                : 'No active assignment'}
        `)
        .addTo(layers.ambulances);
    });

    // Emergencies + their active routes
    data.emergencies.forEach(e => {
        const icon =
            e.status === 'COMPLETED'
                ? emojiIcon('✅', 25)
                : emojiIcon('🚨', 29);

        L.marker([e.location.lat, e.location.lng], { icon })
            .bindPopup(`
                <strong>${e.emergency_id}</strong><br>
                Type: ${e.type}<br>
                Status: ${e.status}<br>
                Phase: ${e.mission_phase || 'Waiting'}
            `)
            .addTo(layers.emergencies);

        if (e.active_route && e.active_route.length > 1) {
            L.polyline(
                e.active_route.map(p => [p.lat, p.lng]),
                {
                    weight: 5,
                    opacity: .85
                }
            )
            .bindTooltip(
                `${e.emergency_id} • ${e.mission_phase || 'ACTIVE'}`
            )
            .addTo(layers.routes);
        }
    });

    // Traffic incidents
    (data.trafficIncidents || []).forEach(t => {
        // Do not draw NORMAL TomTom segments; only visualize actual traffic.
        if (t.type === 'NORMAL') return;

        if (t.coordinates.length >= 2) {
            const label = t.type === 'ROAD_CLOSURE' || t.type === 'ROAD_BLOCK'
                ? '🚧 ROAD CLOSURE'
                : t.type === 'SEVERE_TRAFFIC'
                    ? '🔴 SEVERE TRAFFIC'
                    : t.type === 'HEAVY_TRAFFIC'
                        ? '🟠 HEAVY TRAFFIC'
                        : '🟡 MODERATE TRAFFIC';

            L.polyline(
                t.coordinates.map(p => [p.lat, p.lng]),
                {
                    weight: t.type === 'ROAD_CLOSURE' ? 9 : 7,
                    dashArray: t.type === 'ROAD_CLOSURE' ? '10 8' : '6 6',
                    opacity: .85
                }
            )
            .bindTooltip(`${label} • ${t.source_api || 'Traffic API'}`)
            .addTo(layers.traffic);
        }
    });

    renderActivity(data);
}

function renderActivity(data) {
    const feed = document.getElementById('activityFeed');

    const items = [];

    data.emergencies
        .slice()
        .reverse()
        .forEach(e => {
            items.push({
                time: e.dispatched_at || e.created_at,
                html: `
                    <strong>🚨 ${e.emergency_id}</strong><br>
                    ${e.type} — <span>${e.status}</span>
                    ${e.selected_ambulance
                        ? `<br>🚑 ${e.selected_ambulance.ambulance_id}`
                        : ''}
                    ${e.selected_hospital
                        ? `<br>🏥 ${e.selected_hospital.name}`
                        : ''}
                `
            });
        });

    (data.trafficIncidents || []).forEach(t => {
        items.push({
            time: new Date().toISOString(),
            html: t.type === 'ROAD_BLOCK'
                ? '🚧 Road block detected'
                : '🚗 Heavy traffic detected'
        });
    });

    items.sort((a, b) =>
        new Date(b.time) - new Date(a.time)
    );

    feed.innerHTML = items.slice(0, 20).map(x => `
        <div class="activity">
            ${x.html}
            <div class="text-secondary mt-1">
                ${new Date(x.time).toLocaleTimeString()}
            </div>
        </div>
    `).join('') || `
        <div class="text-secondary">
            Waiting for system activity...
        </div>
    `;
}

const socket = io();

socket.on('system:update', data => {
    render(data);
});

fetch('/api/live')
    .then(r => r.json())
    .then(render)
    .catch(console.error);
