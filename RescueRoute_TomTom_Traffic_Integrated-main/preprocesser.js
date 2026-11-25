const fs = require('fs');

// Haversine formula to calculate meters between two GPS coordinates
function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000; // Earth radius in meters
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

// Read the downloaded GeoJSON file
const rawData = fs.readFileSync('export.geojson', 'utf8');
const geojson = JSON.parse(rawData);

const nodesMap = new Map();
const edges = [];
let nodeIdCounter = 1;

// Assume an average ambulance city speed of 30 km/h (500 meters per minute)
const speedMetersPerMinute = (30 * 1000) / 60;

geojson.features.forEach(feature => {
    // Process only road geometries (LineStrings)
    if (feature.geometry && feature.geometry.type === 'LineString') {
        const coords = feature.geometry.coordinates; // Array of [lng, lat]

        for (let i = 0; i < coords.length - 1; i++) {
            const lon1 = coords[i][0];
            const lat1 = coords[i][1];
            const lon2 = coords[i + 1][0];
            const lat2 = coords[i + 1][1];

            // Create unique keys for each intersection dot
            const node1Key = `${lat1.toFixed(5)},${lon1.toFixed(5)}`;
            const node2Key = `${lat2.toFixed(5)},${lon2.toFixed(5)}`;

            if (!nodesMap.has(node1Key)) nodesMap.set(node1Key, `node_${nodeIdCounter++}`);
            if (!nodesMap.has(node2Key)) nodesMap.set(node2Key, `node_${nodeIdCounter++}`);

            const sourceId = nodesMap.get(node1Key);
            const destId = nodesMap.get(node2Key);

            const distanceMeters = getDistance(lat1, lon1, lat2, lon2);
            // Fractional minutes at 30 km/h (500 m/min), floored at 0.02 min (1.2s)
            const rawTimeMins = distanceMeters / speedMetersPerMinute;
            const timeMins = Number(Math.max(0.02, rawTimeMins).toFixed(4));

            // Add forward edge
            edges.push({
                source: sourceId,
                destination: destId,
                distance_meters: Math.round(distanceMeters),
                time_mins: timeMins,
                traffic: 0,
                status: 0
            });

            // Check if road is one-way
            const isOneway = feature.properties && (feature.properties.oneway === 'yes' || feature.properties.oneway === 'true');

            // If two-way, add the reverse edge as well
            if (!isOneway) {
                edges.push({
                    source: destId,
                    destination: sourceId,
                    distance_meters: Math.round(distanceMeters),
                    time_mins: timeMins,
                    traffic: 0,
                    status: 0
                });
            }
        }
    }
});

// Format nodes for output
const nodesArray = [];
nodesMap.forEach((id, key) => {
    const [lat, lng] = key.split(',').map(Number);
    nodesArray.push({ id, lat, lng });
});

const cleanGraphData = {
    nodes: nodesArray,
    edges: edges
};

// Save to the final clean JSON file your backend reads
fs.writeFileSync('clean_graph_data.json', JSON.stringify(cleanGraphData, null, 2));
console.log(`Success! Extracted ${nodesArray.length} intersections and ${edges.length} road segments into clean_graph_data.json`);