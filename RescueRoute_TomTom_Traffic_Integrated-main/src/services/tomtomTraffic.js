const axios = require('axios');

class TomTomTraffic {
    constructor({ apiKey, zoom = 12, cacheTtlMs = 60000 } = {}) {
        this.apiKey = apiKey;
        this.zoom = zoom;
        this.cacheTtlMs = cacheTtlMs;
        this.cache = new Map();
    }

    get enabled() {
        return Boolean(this.apiKey);
    }

    cacheKey(lat, lng) {
        // Avoid requesting the same physical road segment repeatedly.
        return `${Number(lat).toFixed(5)},${Number(lng).toFixed(5)}`;
    }

    async getFlow(lat, lng, { force = false } = {}) {
        if (!this.enabled) {
            throw new Error('TOMTOM_API_KEY is not configured.');
        }

        const key = this.cacheKey(lat, lng);
        const cached = this.cache.get(key);

        if (!force && cached && Date.now() - cached.timestamp < this.cacheTtlMs) {
            return { ...cached.data, cached: true };
        }

        const url = `https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/${this.zoom}/json`;

        const response = await axios.get(url, {
            params: {
                key: this.apiKey,
                point: `${lat},${lng}`,
                unit: 'kmph'
            },
            timeout: 8000
        });

        const flow = response.data?.flowSegmentData;
        if (!flow) throw new Error('TomTom returned no flowSegmentData.');

        const currentTravelTime = Number(flow.currentTravelTime);
        const freeFlowTravelTime = Number(flow.freeFlowTravelTime);
        const currentSpeed = Number(flow.currentSpeed);
        const freeFlowSpeed = Number(flow.freeFlowSpeed);
        const ratio = freeFlowTravelTime > 0
            ? currentTravelTime / freeFlowTravelTime
            : (currentSpeed > 0 && freeFlowSpeed > 0
                ? freeFlowSpeed / currentSpeed
                : 1);

        const data = {
            currentSpeed,
            freeFlowSpeed,
            currentTravelTime,
            freeFlowTravelTime,
            multiplier: Math.max(1, Number.isFinite(ratio) ? ratio : 1),
            confidence: Number(flow.confidence ?? 0),
            roadClosure: Boolean(flow.roadClosure),
            coordinates: (flow.coordinates?.coordinate || []).map(p => ({
                lat: Number(p.latitude),
                lng: Number(p.longitude)
            }))
        };

        this.cache.set(key, {
            timestamp: Date.now(),
            data
        });

        return { ...data, cached: false };
    }

    clearExpiredCache() {
        const now = Date.now();
        for (const [key, value] of this.cache.entries()) {
            if (now - value.timestamp >= this.cacheTtlMs) {
                this.cache.delete(key);
            }
        }
    }
}

module.exports = TomTomTraffic;
