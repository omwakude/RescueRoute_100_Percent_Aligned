# RescueRoute — Emergency Ambulance Resource Allocation + Traffic-Aware Dijkstra

RescueRoute combines a demonstrable DSA backend with a realistic Pune emergency-response web interface.

## Run
1. `npm install`
2. Copy `.env.example` to `.env` and optionally add a TomTom Traffic API key.
3. `npm start`
4. Open:
   - `http://localhost:3000/` Emergency registration
   - `http://localhost:3000/admin` Priority dispatch + road controls + history
   - `http://localhost:3000/command` Live Leaflet command map

If TomTom is unavailable or no API key is configured, simulated traffic updates graph edge weights so the DSA demo remains usable.

## Emergency Types and Priority
| Code | Type | Priority |
|---|---|---:|
| 0 | Minor Injury | 3 |
| 1 | Serious Injury | 6 |
| 2 | Cardiac | 9 |
| 3 | Neonatal | 8 |
| 4 | Trauma | 8 |
| 5 | Critical | 10 |

Emergency IDs are generated automatically starting at `1001`.

## DSA Structures Actually Used
- `EmergencyPriorityQueue.js`: max-priority queue for pending emergencies; same-priority cases are FIFO.
- `MinHeap.js`: routing heap used inside Dijkstra only.
- `AmbulanceMinHeap.js`: separate min heap containing only medically suitable + available ambulance candidates, keyed by traffic-aware ETA.
- `HashTable.js`: ambulance lookup by Ambulance ID and emergency-history lookup by Emergency ID.
- `Queue.js`: FIFO operational-event pipeline for registration, dispatch, road changes, completion/cancellation.
- `Graph.js`: adjacency-list road graph, dynamic weights, road blocking/reopening, Dijkstra, route reconstruction.

## Allocation Flow
`Priority Queue -> suitability filter -> availability filter -> Dijkstra ETA -> Ambulance Min Heap -> extract minimum ETA -> dispatch`

The dispatcher cannot override the min-ETA ambulance. Hospital recommendation is different: all medically suitable hospitals are evaluated using traffic-aware Dijkstra, the fastest is recommended, but Admin may manually choose another medically suitable hospital.

## Medical Suitability
Ambulances expose capabilities such as `CARDIAC_SUPPORT`, `TRAUMA_SUPPORT`, `NEONATAL_SUPPORT`, and `ICU_SUPPORT`.

Hospitals always require `EMERGENCY_DEPARTMENT`, then:
- Cardiac: `CARDIAC_UNIT + ICU`
- Trauma: `TRAUMA_UNIT`
- Neonatal: `NEONATAL_UNIT`
- Critical: `ICU`
- Serious Injury: `TRAUMA_UNIT OR ICU`
- Minor Injury: `EMERGENCY_DEPARTMENT`

Hospital capabilities in this repository are **demo system data for the project**, not claims about real-world current clinical services.

## Traffic + Routing
TomTom never replaces the DSA algorithm. The flow is:
`Road Graph -> TomTom/simulator -> update edge travel times/closures -> Dijkstra -> route reconstruction`

Candidate corridors are found first, TomTom traffic is requested only for relevant graph edges, those edge weights are updated, and Dijkstra is run again.

## Road APIs
- `POST /api/roads/block` `{source,destination}`
- `POST /api/roads/open` `{source,destination}`
- `GET /api/roads/condition?source=...&destination=...`
- `POST /api/roads/travel-time` `{source,destination,minutes}`
- `POST /api/traffic/update`
- `GET /api/roads?limit=100`

Blocked edges are skipped by Dijkstra. Reopened edges become routable again.

## Emergency / History APIs
- `POST /api/emergency`
- `GET /api/emergency/next`
- `GET /api/emergencies`
- `POST /api/emergency/:id/dispatch`
- `POST /api/emergency/:id/cancel`
- `GET /api/history`
- `GET /api/history/:id`
- `GET /api/ambulances/:id`
- `GET /api/live`

Completed/cancelled cases are archived with Emergency ID, ambulance, emergency type, priority, location, hospital, route, travel time, and final status.
