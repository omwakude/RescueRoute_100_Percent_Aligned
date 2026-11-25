const fs = require('fs');
const MinHeap = require('./MinHeap');

class Graph {
    constructor() {
        this.nodes = new Map();
    }

    addLocation(id) {
        if (!this.nodes.has(id)) this.nodes.set(id, []);
    }

    addEdge(source, destination, distance, time, traffic = 0, status = 0) {
        this.addLocation(source);
        this.addLocation(destination);

        this.nodes.get(source).push({
            destination,
            distance,
            time,
            baseTime: time,
            traffic,
            status,
            trafficMultiplier: 1,
            trafficSource: 'BASE',
            manualBlocked: false
        });
    }

    loadMapData(filePath) {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        data.edges.forEach(edge => {
            this.addEdge(
                edge.source,
                edge.destination,
                edge.distance_meters,
                edge.time_mins,
                edge.traffic || 0,
                edge.status || 0
            );
        });
        console.log(`Map loaded: ${this.nodes.size} intersections ready.`);
    }

    getEdge(source, destination) {
        if (!this.nodes.has(source)) return null;
        return this.nodes.get(source).find(e => e.destination === destination) || null;
    }

    updateEdge(source, destination, newTime, newTraffic, newStatus) {
        const edge = this.getEdge(source, destination);
        if (!edge) return;

        if (newTime !== null) edge.time = newTime;
        if (newTraffic !== null) edge.traffic = newTraffic;
        if (newStatus !== null) edge.status = newStatus;
    }

    // TomTom traffic updates should change the edge's effective travel time,
    // while preserving the original graph travel time for future refreshes.
    updateEdgeTraffic(source, destination, {
        multiplier = 1,
        roadClosure = false,
        trafficLevel = 0,
        trafficSource = 'TOMTOM'
    } = {}) {
        const edge = this.getEdge(source, destination);
        if (!edge) return false;

        const safeMultiplier = Number.isFinite(multiplier) && multiplier > 0
            ? Math.min(multiplier, 2.5)
            : 1;
        const closureFactor = roadClosure ? 1.5 : 1;

        edge.trafficMultiplier = safeMultiplier;
        edge.time = edge.baseTime * edge.trafficMultiplier * closureFactor;
        edge.traffic = roadClosure ? Math.max(trafficLevel, 3) : trafficLevel;
        edge.status = edge.manualBlocked ? 1 : 0;
        edge.trafficSource = trafficSource;

        return true;
    }

    resetTraffic() {
        for (const edges of this.nodes.values()) {
            for (const edge of edges) {
                edge.time = edge.baseTime;
                edge.traffic = 0;
                edge.status = edge.manualBlocked ? 1 : 0;
                edge.trafficMultiplier = 1;
                edge.trafficSource = 'BASE';
            }
        }
    }

    blockRoad(source, destination) {
        const edge = this.getEdge(source, destination);
        if (!edge) return false;
        edge.manualBlocked = true;
        edge.status = 1;
        edge.trafficSource = 'MANUAL_BLOCK';
        return true;
    }

    openRoad(source, destination) {
        const edge = this.getEdge(source, destination);
        if (!edge) return false;
        edge.manualBlocked = false;
        edge.status = 0;
        edge.trafficSource = 'MANUAL';
        return true;
    }

    setRoadTravelTime(source, destination, minutes) {
        const edge = this.getEdge(source, destination);
        if (!edge || !Number.isFinite(Number(minutes)) || Number(minutes) <= 0) return false;
        edge.baseTime = Number(minutes);
        edge.time = edge.baseTime * (edge.trafficMultiplier || 1);
        return true;
    }

    getRoadCondition(source, destination) {
        const edge = this.getEdge(source, destination);
        if (!edge) return null;
        return { source, destination, ...edge };
    }

    findFastestRoute(startNode, endNode) {
        const times = {};
        const backtrace = {};
        const pq = new MinHeap();

        times[startNode] = 0;
        this.nodes.forEach((_, key) => {
            if (key !== startNode) times[key] = Infinity;
        });

        pq.insert(startNode, 0);

        while (!pq.isEmpty()) {
            const current = pq.extractMin();
            const currentNode = current.element;
            const currentTime = current.priority;

            // Ignore stale heap entries.
            if (currentTime > times[currentNode]) continue;
            if (currentNode === endNode) break;

            const neighbors = this.nodes.get(currentNode) || [];

            for (const neighbor of neighbors) {
                if (neighbor.status === 1) continue;

                // Dijkstra uses the traffic-adjusted edge time.
                const time = times[currentNode] + neighbor.time;

                if (time < times[neighbor.destination]) {
                    times[neighbor.destination] = time;
                    backtrace[neighbor.destination] = currentNode;
                    pq.insert(neighbor.destination, time);
                }
            }
        }

        return {
            time: times[endNode],
            path: times[endNode] === Infinity
                ? []
                : this.buildPath(backtrace, endNode)
        };
    }

    auditRouteBaseTime(path = []) {
        if (!Array.isArray(path) || path.length < 2) {
            return {
                hops: 0,
                distanceMeters: 0,
                baseTimeMins: 0,
                currentTimeMins: 0,
                flooredHops: 0,
                impliedSpeedKmph: 0
            };
        }

        let distanceMeters = 0;
        let baseTimeMins = 0;
        let currentTimeMins = 0;
        let flooredHops = 0;

        for (let i = 0; i < path.length - 1; i++) {
            const edge = this.getEdge(path[i], path[i + 1]);
            if (!edge) continue;
            distanceMeters += Number(edge.distance || 0);
            baseTimeMins += Number(edge.baseTime || 0);
            currentTimeMins += Number(edge.time || 0);
            if (Number(edge.baseTime) === 0.02) flooredHops++;
        }

        const impliedSpeedKmph = baseTimeMins > 0
            ? ((distanceMeters / 1000) / (baseTimeMins / 60))
            : 0;

        return {
            hops: path.length - 1,
            distanceMeters: Math.round(distanceMeters),
            baseTimeMins: Number(baseTimeMins.toFixed(2)),
            currentTimeMins: Number(currentTimeMins.toFixed(2)),
            flooredHops,
            impliedSpeedKmph: Number(impliedSpeedKmph.toFixed(2))
        };
    }

    buildPath(backtrace, target) {
        if (target === undefined || target === null) return [];

        const path = [target];

        while (backtrace[target]) {
            path.unshift(backtrace[target]);
            target = backtrace[target];
        }

        return path;
    }
}

module.exports = Graph;