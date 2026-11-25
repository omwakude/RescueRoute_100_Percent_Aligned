const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const http = require('http');
require('dotenv').config();
const { Server } = require('socket.io');

const Graph = require('./src/models/Graph');
const TomTomTraffic = require('./src/services/tomtomTraffic');
const EmergencyPriorityQueue = require('./src/models/EmergencyPriorityQueue');
const AmbulanceMinHeap = require('./src/models/AmbulanceMinHeap');
const HashTable = require('./src/models/HashTable');
const Queue = require('./src/models/Queue');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// DEBUG MIDDLEWARE
// ============================================================
app.use((req, res, next) => {
    console.log(`\n[HTTP REQUEST] ${req.method} ${req.originalUrl}`);
    if (req.body && Object.keys(req.body).length) console.log(`[HTTP BODY]`, req.body);
    if (req.query && Object.keys(req.query).length) console.log(`[HTTP QUERY]`, req.query);
    next();
});

// ============================================================
// RESCUEROUTE DSA CORE
// ============================================================
console.log(`[INIT] Initializing RescueRoute Core...`);
const cityMap = new Graph();
const mapData = JSON.parse(fs.readFileSync(path.join(__dirname, 'clean_graph_data.json'), 'utf8'));
cityMap.loadMapData(path.join(__dirname, 'clean_graph_data.json'));
console.log(`[INIT] Loaded Graph: ${mapData.nodes.length} nodes, ${mapData.edges.length} edges.`);

const ambulances = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/ambulances.json'), 'utf8'));
const hospitals = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/hospitals.json'), 'utf8'));
console.log(`[INIT] Loaded ${ambulances.length} Ambulances and ${hospitals.length} Hospitals.`);

// Hash Table: O(1)-average lookup by Ambulance ID.
const ambulanceTable = new HashTable(53);
ambulances.forEach(a => {
    ambulanceTable.set(a.id, a);
    console.log(`[INIT] Ambulance hashed: ${a.id} -> [${a.capabilities.join(', ')}]`);
});

// Priority Queue: pending emergencies ordered by medical priority, FIFO for ties.
const pendingEmergencyQueue = new EmergencyPriorityQueue();
// FIFO Queue: operational events are processed/published in registration/dispatch/completion order.
const operationsQueue = new Queue();
const activityLog = [];

const activeEmergencies = new Map();
const emergencyHistory = [];
const historyTable = new HashTable(101);
const missionTimers = new Map();
let nextEmergencyId = 1001;
let trafficIncidents = [];

const PRIORITY = {
    'Critical': 10,
    'Cardiac': 9,
    'Trauma': 8,
    'Neonatal': 8,
    'Serious Injury': 6,
    'Minor Injury': 3
};
const TYPE_CODES = {
    0: 'Minor Injury',
    1: 'Serious Injury',
    2: 'Cardiac',
    3: 'Neonatal',
    4: 'Trauma',
    5: 'Critical'
};
const AMBULANCE_REQUIREMENTS = {
    'Minor Injury': ['GENERAL'],
    'Serious Injury': ['TRAUMA_SUPPORT|ICU_SUPPORT'],
    'Cardiac': ['CARDIAC_SUPPORT'],
    'Neonatal': ['NEONATAL_SUPPORT'],
    'Trauma': ['TRAUMA_SUPPORT'],
    'Critical': ['ICU_SUPPORT']
};

const nodeCoordinates = new Map(mapData.nodes.map(n => [n.id, { lat: n.lat, lng: n.lng }]));
const tomtomTraffic = new TomTomTraffic({
    apiKey: process.env.TOMTOM_API_KEY || 'FR5ml5gpV8BnvxsEQniV9cIM8argro9v',
    zoom: Number(process.env.TOMTOM_TRAFFIC_ZOOM || 12),
    cacheTtlMs: Number(process.env.TOMTOM_TRAFFIC_CACHE_MS || 60000)
});
console.log(`[INIT] Traffic engine configuration: Enabled=${tomtomTraffic.enabled}`);
const TOMTOM_MAX_EDGE_REQUESTS = Number(process.env.TOMTOM_MAX_EDGE_REQUESTS || 250);
const TOMTOM_CONCURRENCY = Number(process.env.TOMTOM_CONCURRENCY || 8);
const relevantTrafficEdges = new Set();

const SPEED_METERS_PER_MINUTE = (30 * 1000) / 60;

function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000, dLat = (lat2-lat1)*Math.PI/180, dLon=(lon2-lon1)*Math.PI/180;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
    return R * (2*Math.atan2(Math.sqrt(a), Math.sqrt(1-a)));
}
function getNearestNodeWithDistance(lat, lng) {
    let id = null, min = Infinity;
    for (const n of mapData.nodes) {
        const d = getDistance(lat, lng, n.lat, n.lng);
        if (d < min) { min = d; id = n.id; }
    }
    console.log(`[GEOMETRY] Nearest node to (${lat}, ${lng}) is ${id} (Distance: ${Math.round(min)}m)`);
    return { id, distanceMeters: min };
}
function getNearestNode(lat, lng) {
    return getNearestNodeWithDistance(lat, lng).id;
}
function routeToCoordinates(route){ return (route||[]).map(id=>nodeCoordinates.get(id)).filter(Boolean); }
function getRouteDistance(route){
    let d=0; for(let i=0;i<(route||[]).length-1;i++){ const e=cityMap.getEdge(route[i],route[i+1]); if(e)d+=e.distance||0; } return d;
}
function calculateRoute(start,end){
    console.log(`[DIJKSTRA] Calculating optimal route: ${start} -> ${end}`);
    const r=cityMap.findFastestRoute(start,end); if(!r || r.time===Infinity) { console.warn(`[DIJKSTRA] Route calculation failed or path blocked: ${start} -> ${end}`); return null; }
    console.log(`[DIJKSTRA] Success: ${r.path.length} hops, Time: ${r.time.toFixed(2)}m, Distance: ${(getRouteDistance(r.path)/1000).toFixed(2)}km`);
    return { time:Number(r.time.toFixed(2)), distance_km:Number((getRouteDistance(r.path)/1000).toFixed(2)), path:r.path, coordinates:routeToCoordinates(r.path) };
}
function hasCapability(list, requirement){
    if(!requirement) return true;
    if(requirement.includes('|')) return requirement.split('|').some(x=>list.includes(x));
    return list.includes(requirement);
}
function ambulanceSuitable(a,type){ 
    const isSuitable = (AMBULANCE_REQUIREMENTS[type]||['GENERAL']).every(r=>hasCapability(a.capabilities||[],r));
    console.log(`[SUITABILITY] Ambulance ${a.id} vs ${type} -> Suitable: ${isSuitable}`);
    return isSuitable;
}
function hospitalSuitable(h,type){
    const c=h.capabilities||[];
    if(!c.includes('EMERGENCY_DEPARTMENT')) return false;
    let isSuitable = true;
    if(type==='Cardiac') isSuitable = c.includes('CARDIAC_UNIT') && c.includes('ICU');
    else if(type==='Trauma') isSuitable = c.includes('TRAUMA_UNIT');
    else if(type==='Neonatal') isSuitable = c.includes('NEONATAL_UNIT');
    else if(type==='Critical') isSuitable = c.includes('ICU');
    else if(type==='Serious Injury') isSuitable = c.includes('TRAUMA_UNIT') || c.includes('ICU');
    console.log(`[SUITABILITY] Hospital ${h.id} (${h.name}) vs ${type} -> Suitable: ${isSuitable}`);
    return isSuitable;
}
function enqueueOperation(kind,message,emergencyId=null){
    console.log(`[OPERATIONS QUEUE] Enqueuing: [${kind}] ${message}`);
    operationsQueue.enqueue({ kind,message,emergency_id:emergencyId,time:new Date().toISOString() });
    while(!operationsQueue.isEmpty()) activityLog.push(operationsQueue.dequeue());
    if(activityLog.length>100) activityLog.splice(0,activityLog.length-100);
}
function publicEmergency(e){ return e; }
function publicState(){
    return {
        timestamp:new Date().toISOString(),
        emergencies:Array.from(activeEmergencies.values()).map(publicEmergency),
        pending_by_priority:pendingEmergencyQueue.toSortedArray().map(e=>({emergency_id:e.emergency_id,type:e.type,priority:e.priority})),
        ambulances:ambulanceTable.values(), hospitals, trafficIncidents,
        history_count:emergencyHistory.length, activityLog:activityLog.slice(-30),
        traffic:{provider:tomtomTraffic.enabled?'TOMTOM':'SIMULATED',enabled:tomtomTraffic.enabled,cached_edges:relevantTrafficEdges.size},
        dsa:{priority_queue:'EmergencyPriorityQueue',dijkstra_heap:'MinHeap',ambulance_heap:'AmbulanceMinHeap',ambulance_lookup:'HashTable',fifo_queue:'Queue',graph:'Adjacency List'}
    };
}
function broadcastState(){ console.log(`[SOCKET.IO] Broadcasting system state to clients.`); io.emit('system:update', publicState()); }

// ============================================================
// TOMTOM -> DYNAMIC GRAPH EDGE WEIGHTS -> DIJKSTRA
// ============================================================
function edgeKey(a,b){return `${a}->${b}`;}
function routeEdgeKeys(route){ const x=[]; for(let i=0;i<route.length-1;i++)x.push(edgeKey(route[i],route[i+1])); return x; }
function trafficLevelFromRatio(r){return r>=2?3:r>=1.35?2:r>=1.10?1:0;}
async function updateTomTomEdge(source,destination,force=false){
    const a=nodeCoordinates.get(source),b=nodeCoordinates.get(destination); if(!a||!b)return null;
    try{
        console.log(`[TRAFFIC] Fetching TomTom flow for edge ${source}->${destination} (Force: ${force})`);
        const flow=await tomtomTraffic.getFlow((a.lat+b.lat)/2,(a.lng+b.lng)/2,{force});
        cityMap.updateEdgeTraffic(source,destination,{multiplier:flow.multiplier,roadClosure:flow.roadClosure,trafficLevel:trafficLevelFromRatio(flow.multiplier),trafficSource:'TOMTOM'});
        console.log(`[TRAFFIC] Edge ${source}->${destination} updated! Multiplier: ${flow.multiplier.toFixed(2)}, Closed: ${flow.roadClosure}`);
        return {id:`TT-${source}-${destination}`,type:flow.roadClosure?'ROAD_CLOSURE':flow.multiplier>=2?'SEVERE_TRAFFIC':flow.multiplier>=1.35?'HEAVY_TRAFFIC':flow.multiplier>=1.10?'MODERATE_TRAFFIC':'NORMAL',source,destination,multiplier:Number(flow.multiplier.toFixed(2)),coordinates:flow.coordinates.length>=2?flow.coordinates:[a,b],source_api:'TomTom'};
    }catch(err){ console.warn(`[TRAFFIC ERROR] TomTom ${source}->${destination}: ${err.message}`); return null; }
}
async function refreshTomTomEdges(keys,force=false){
    if(!tomtomTraffic.enabled || !keys.length)return [];
    console.log(`[TRAFFIC MANAGER] Refreshing ${keys.length} specific edges from TomTom...`);
    const unique=[...new Set(keys)].slice(0,TOMTOM_MAX_EDGE_REQUESTS); const out=[]; let cursor=0;
    async function worker(){ while(cursor<unique.length){ const key=unique[cursor++],[s,d]=key.split('->'); const x=await updateTomTomEdge(s,d,force); relevantTrafficEdges.add(key); if(x)out.push(x); } }
    await Promise.all(Array.from({length:Math.min(TOMTOM_CONCURRENCY,unique.length)},worker)); 
    console.log(`[TRAFFIC MANAGER] Finished refreshing ${out.length} edges.`);
    return out;
}
function trafficSnapshot(){
    const out=[];
    for(const key of relevantTrafficEdges){ const [s,d]=key.split('->'), e=cityMap.getEdge(s,d),a=nodeCoordinates.get(s),b=nodeCoordinates.get(d); if(!e||!a||!b)continue;
        if(e.trafficSource==='TOMTOM') out.push({id:`TT-${key}`,type:e.status?'ROAD_CLOSURE':e.traffic>=3?'SEVERE_TRAFFIC':e.traffic===2?'HEAVY_TRAFFIC':e.traffic===1?'MODERATE_TRAFFIC':'NORMAL',source:s,destination:d,multiplier:e.trafficMultiplier,coordinates:[a,b],source_api:'TomTom'});
    }
    // Always include manually blocked roads.
    for(const [s,edges] of cityMap.nodes){ for(const e of edges){ if(e.manualBlocked){ const a=nodeCoordinates.get(s),b=nodeCoordinates.get(e.destination); if(a&&b)out.push({id:`MAN-${s}-${e.destination}`,type:'ROAD_BLOCK',source:s,destination:e.destination,coordinates:[a,b],source_api:'MANUAL'}); } } }
    console.log(`[TRAFFIC SNAPSHOT] Generated snapshot with ${out.length} active incidents/adjustments.`);
    return out;
}
function resetSimulatedTraffic(){
    console.log(`[SIMULATOR] Generating random simulated traffic constraints...`);
    cityMap.resetTraffic(); trafficIncidents=[];
    const picks=new Set(); while(picks.size<Math.min(3,mapData.edges.length))picks.add(Math.floor(Math.random()*mapData.edges.length));
    for(const i of picks){ const e=mapData.edges[i], blocked=Math.random()>.85; const edge=cityMap.getEdge(e.source,e.destination); if(!edge||edge.manualBlocked)continue; edge.traffic=blocked?0:2; edge.status=blocked?1:0; edge.time=blocked?edge.baseTime:edge.baseTime*1.7; edge.trafficMultiplier=blocked?1:1.7; edge.trafficSource='SIMULATOR'; trafficIncidents.push({id:`SIM-${i}`,type:blocked?'ROAD_BLOCK':'HEAVY_TRAFFIC',source:e.source,destination:e.destination,coordinates:[nodeCoordinates.get(e.source),nodeCoordinates.get(e.destination)].filter(Boolean),source_api:'SIMULATOR'}); console.log(`[SIMULATOR] Applied ${blocked?'ROAD_BLOCK':'HEAVY_TRAFFIC'} to ${e.source}->${e.destination}`); }
    trafficIncidents.push(...trafficSnapshot().filter(x=>x.source_api==='MANUAL')); broadcastState();
}
async function refreshRelevantTomTomTraffic(force=false){ console.log(`[TRAFFIC CRON] Triggering periodic traffic refresh...`); if(!tomtomTraffic.enabled){resetSimulatedTraffic();return;} await refreshTomTomEdges([...relevantTrafficEdges],force); trafficIncidents=trafficSnapshot(); broadcastState(); }
setInterval(()=>refreshRelevantTomTomTraffic(false).catch(console.error),Number(process.env.TRAFFIC_REFRESH_MS||60000));

async function buildCandidates(type, emergencyNode){
    console.log(`[CANDIDATE BUILDER] Initializing candidate search for ${type} at node ${emergencyNode}`);
    // Pre-route corridors using Dijkstra before traffic refresh.
    const prelimAmb=[],prelimHosp=[];
    for(const a of ambulanceTable.values()) if(a.available && ambulanceSuitable(a,type)){ const r=calculateRoute(getNearestNode(a.lat,a.lng),emergencyNode); if(r)prelimAmb.push(r); }
    for(const h of hospitals) if(hospitalSuitable(h,type)){ const r=calculateRoute(emergencyNode,getNearestNode(h.lat,h.lng)); if(r)prelimHosp.push(r); }
    const keys=[...prelimAmb.flatMap(r=>routeEdgeKeys(r.path)),...prelimHosp.flatMap(r=>routeEdgeKeys(r.path))];
    console.log(`[CANDIDATE BUILDER] Pre-routing identified ${keys.length} relevant edges for traffic checking.`);
    if(tomtomTraffic.enabled){ await refreshTomTomEdges(keys,false); trafficIncidents=trafficSnapshot(); }

    // Distinct Ambulance Min Heap: filter availability+suitability FIRST, ETA second.
    console.log(`[HEAP OPERATIONS] Building Ambulance Min Heap...`);
    const heap=new AmbulanceMinHeap();
    for(const a of ambulanceTable.values()){
        if(!a.available || !ambulanceSuitable(a,type)) continue;
        const nearest = getNearestNodeWithDistance(a.lat, a.lng);
        const r = calculateRoute(nearest.id, emergencyNode);
        if (!r) continue;

        const snapMins = nearest.distanceMeters / SPEED_METERS_PER_MINUTE;
        const adjustedEta = Number((r.time + snapMins).toFixed(2));
        const adjustedDistanceKm = Number((r.distance_km + nearest.distanceMeters / 1000).toFixed(2));

        const step1Audit = cityMap.auditRouteBaseTime(r.path);
        console.log(
            `[STEP1 AUDIT] Amb ${a.id} -> Node ${emergencyNode}: ` +
            `hops=${step1Audit.hops}, dist=${step1Audit.distanceMeters}m (+${Math.round(nearest.distanceMeters)}m snap), ` +
            `baseTime=${step1Audit.baseTimeMins}m, finalEta=${adjustedEta}m, ` +
            `flooredHops=${step1Audit.flooredHops}, baseSpeed=${step1Audit.impliedSpeedKmph}km/h`
        );

        console.log(`[HEAP OPERATIONS] Inserting Ambulance ${a.id} into Min Heap (ETA: ${adjustedEta} mins)`);
        heap.insert({ambulance_id:a.id,type:a.type,capabilities:a.capabilities,location:{lat:a.lat,lng:a.lng},eta_minutes:adjustedEta,distance_km:adjustedDistanceKm,route:r.path,route_coordinates:r.coordinates,status:a.status||'AVAILABLE',selection_structure:'AmbulanceMinHeap',routing_algorithm:'Dijkstra + routing MinHeap'});
    }
    const eligible=[]; while(!heap.isEmpty()) { const min = heap.extractMin(); console.log(`[HEAP OPERATIONS] Extracted Ambulance from Min Heap: ${min.ambulance_id} (ETA: ${min.eta_minutes})`); eligible.push(min); }

    console.log(`[CANDIDATE BUILDER] Evaluating target hospitals...`);
    const evaluatedHospitals=[];
    for(const h of hospitals){
        const suitable=hospitalSuitable(h,type); let route=null; if(suitable)route=calculateRoute(emergencyNode,getNearestNode(h.lat,h.lng));
        if(route){
            const hospAudit = cityMap.auditRouteBaseTime(route.path);
            console.log(
                `[STEP1 AUDIT] Node ${emergencyNode} -> Hosp ${h.name}: ` +
                `hops=${hospAudit.hops}, dist=${hospAudit.distanceMeters}m, ` +
                `baseTime=${hospAudit.baseTimeMins}m, finalTime=${route.time}m, ` +
                `flooredHops=${hospAudit.flooredHops}, baseSpeed=${hospAudit.impliedSpeedKmph}km/h`
            );
        }
        evaluatedHospitals.push({hospital_id:h.id,name:h.name,capabilities:h.capabilities,suitable,reason:suitable?(route?'Medically suitable':'No available graph route'):'Missing required medical capability',travel_time_minutes:route?.time??null,distance_km:route?.distance_km??null,route:route?.path??[],route_coordinates:route?.coordinates??[]});
        console.log(`[CANDIDATE BUILDER] Hospital ${h.name}: Suitable=${suitable}, Route Found=${!!route}`);
    }
    const suitableHospitals=evaluatedHospitals.filter(h=>h.suitable&&h.travel_time_minutes!==null).sort((a,b)=>a.travel_time_minutes-b.travel_time_minutes);
    console.log(`[CANDIDATE BUILDER] Finished. Found ${eligible.length} eligible ambulances and ${suitableHospitals.length} suitable hospitals.`);
    return { eligible, evaluatedHospitals, suitableHospitals, recommendedHospital:suitableHospitals[0]||null };
}

// ============================================================
// EMERGENCY REGISTRATION
// 0 Minor, 1 Serious, 2 Cardiac, 3 Neonatal, 4 Trauma, 5 Critical
// ============================================================
app.post('/api/emergency', async (req,res)=>{
    console.log(`[EMERGENCY REGISTRATION] Incoming POST /api/emergency data:`, req.body);
    try{
        const {patient_name,patient_age,patient_sex,emergency_type,location_coordinates,destination_hospital}=req.body;
        const type=TYPE_CODES[Number(emergency_type)] || (Object.values(TYPE_CODES).includes(emergency_type)?emergency_type:null);
        const age=Number(patient_age),lat=Number(location_coordinates?.lat),lng=Number(location_coordinates?.lng);
        if(!patient_name || !Number.isFinite(age)||age<0||!['Male','Female','Other'].includes(patient_sex)||!type||!Number.isFinite(lat)||!Number.isFinite(lng)) { console.warn(`[EMERGENCY REGISTRATION] Validation Failed. Payload invalid.`); return res.status(400).json({error:'Patient name, valid age/sex, emergency type (0-5), and coordinates are required.'}); }
        const emergencyNode=getNearestNode(lat,lng); if(!emergencyNode){ console.warn(`[EMERGENCY REGISTRATION] Validation Failed. Coordinates outside graph domain.`); return res.status(400).json({error:'Location is outside the loaded graph.'}); }
        const {eligible,evaluatedHospitals,suitableHospitals,recommendedHospital}=await buildCandidates(type,emergencyNode);
        if(!eligible.length){ console.warn(`[EMERGENCY REGISTRATION] Rejected: No available/suitable ambulance.`); return res.status(503).json({error:'No available medically suitable ambulance can currently reach the patient.'}); }
        if(!suitableHospitals.length){ console.warn(`[EMERGENCY REGISTRATION] Rejected: No suitable/reachable hospital.`); return res.status(503).json({error:'No medically suitable hospital is reachable.'}); }
        const id=String(nextEmergencyId++);
        console.log(`[EMERGENCY REGISTRATION] Assigning ID: ${id} to ${type} emergency.`);
        const requested = destination_hospital && destination_hospital !== 'AUTO' ? hospitals.find(h=>String(h.id)===String(destination_hospital)) : null;
        const requestedEval=requested?evaluatedHospitals.find(h=>h.hospital_id===requested.id):null;
        const e={
            emergency_id:id, patient:{name:String(patient_name).trim(),age,sex:patient_sex}, type, type_code:Number(Object.keys(TYPE_CODES).find(k=>TYPE_CODES[k]===type)), priority:PRIORITY[type],
            location:{lat,lng}, emergency_node:emergencyNode, requested_hospital_id:destination_hospital||'AUTO',
            requested_hospital_valid:requestedEval?Boolean(requestedEval.suitable&&requestedEval.travel_time_minutes!==null):destination_hospital==='AUTO'||!destination_hospital,
            status:'WAITING_FOR_ADMIN', created_at:new Date().toISOString(), eligible_ambulances:eligible, hospital_evaluations:evaluatedHospitals,
            suitable_hospitals:suitableHospitals, reachable_hospitals:suitableHospitals, recommended_hospital:recommendedHospital,
            selected_ambulance:null,selected_hospital:null,active_route:null,mission_phase:null,
            routing:{algorithm:'Dijkstra',routing_heap:'MinHeap',ambulance_selection:'AmbulanceMinHeap',traffic_provider:tomtomTraffic.enabled?'TomTom Traffic Flow API':'SIMULATED TRAFFIC'}
        };
        activeEmergencies.set(id,e); 
        console.log(`[PRIORITY QUEUE] Inserting Emergency ${id} (Priority: ${e.priority})`);
        pendingEmergencyQueue.enqueue(e); 
        enqueueOperation('REGISTERED',`Emergency ${id} registered (${type}, priority ${e.priority})`,id); broadcastState();
        res.status(201).json({success:true,message:'Emergency registered and inserted into Priority Queue.',emergency:e,queue_position:pendingEmergencyQueue.toSortedArray().findIndex(x=>x.emergency_id===id)+1});
        console.log(`[EMERGENCY REGISTRATION] Complete. Waiting for admin dispatch.`);
    }catch(err){ console.error(`[EMERGENCY REGISTRATION FATAL ERROR]`, err); res.status(500).json({error:err.message}); }
});

app.get('/api/emergencies',(req,res)=>res.json(pendingEmergencyQueue.toSortedArray().concat(Array.from(activeEmergencies.values()).filter(e=>e.status!=='WAITING_FOR_ADMIN'))));
app.get('/api/emergency/next',(req,res)=>res.json({next:pendingEmergencyQueue.peek()}));

app.post('/api/emergency/:id/dispatch',(req,res)=>{
    console.log(`[DISPATCH ADMIN] Dispatching Emergency ${req.params.id}`);
    const e=activeEmergencies.get(String(req.params.id)); if(!e) { console.warn(`[DISPATCH ADMIN] Emergency ${req.params.id} not found!`); return res.status(404).json({error:'Emergency not found.'}); }
    if(e.status!=='WAITING_FOR_ADMIN') { console.warn(`[DISPATCH ADMIN] Emergency ${req.params.id} has invalid status for dispatch: ${e.status}`); return res.status(409).json({error:`Emergency is already ${e.status}.`}); }
    const highest=pendingEmergencyQueue.peek(); if(highest && highest.emergency_id!==e.emergency_id){ console.warn(`[DISPATCH ADMIN] Priority violation. Trying to dispatch ${e.emergency_id} but ${highest.emergency_id} is higher priority.`); return res.status(409).json({error:`Priority Queue rule: emergency ${highest.emergency_id} (${highest.type}, priority ${highest.priority}) must be processed first.`}); }
    const {hospital_id}=req.body;
    const candidate=e.eligible_ambulances[0];
    const ambulance_id=candidate?.ambulance_id;
    if(!candidate){ console.warn(`[DISPATCH ADMIN] No ambulance candidate available at dispatch time.`); return res.status(409).json({error:'No ambulance candidate is available.'}); }
    const hospital=e.suitable_hospitals.find(h=>String(h.hospital_id)===String(hospital_id)); if(!hospital){ console.warn(`[DISPATCH ADMIN] Target hospital ${hospital_id} is invalid or not reachable.`); return res.status(400).json({error:'Hospital is not medically suitable/reachable for this emergency.'}); }
    const ambulance=ambulanceTable.get(ambulance_id); if(!ambulance||!ambulance.available){ console.warn(`[DISPATCH ADMIN] Targeted ambulance ${ambulance_id} is no longer available.`); return res.status(409).json({error:'Ambulance is no longer available.'}); }
    console.log(`[DISPATCH ADMIN] Assigning Ambulance ${ambulance.id} to Emergency ${e.emergency_id}. Target Hospital: ${hospital.name}`);
    ambulance.available=false; ambulance.status='EN_ROUTE_TO_SCENE'; ambulance.assigned_emergency=e.emergency_id;
    e.selected_ambulance=candidate; e.selected_hospital=hospital; e.status='DISPATCHED';e.mission_phase='EN_ROUTE_TO_SCENE';e.dispatched_at=new Date().toISOString();e.active_route=candidate.route_coordinates;
    pendingEmergencyQueue.removeById(e.emergency_id); 
    console.log(`[PRIORITY QUEUE] Removed Emergency ${e.emergency_id} from queue.`);
    enqueueOperation('DISPATCHED',`${ambulance.id} dispatched to emergency ${e.emergency_id}`,e.emergency_id);
    startMissionSimulation(e,ambulance,candidate.route_coordinates,hospital.route_coordinates); broadcastState();
    res.json({success:true,message:'Highest-priority emergency dispatched.',dispatch_plan:{emergency_id:e.emergency_id,ambulance:candidate,hospital,status:e.status,recommendation:hospital.hospital_id===e.recommended_hospital?.hospital_id?'Recommended hospital selected':'Manual suitable hospital selected'}});
});

app.post('/api/emergency/:id/cancel',(req,res)=>{
    console.log(`[CANCEL ADMIN] Processing cancellation for Emergency ${req.params.id}`);
    const e=activeEmergencies.get(String(req.params.id)); if(!e) return res.status(404).json({error:'Emergency not found.'});
    if(['COMPLETED','CANCELLED'].includes(e.status)) return res.status(409).json({error:`Emergency already ${e.status}.`});
    pendingEmergencyQueue.removeById(e.emergency_id);
    console.log(`[PRIORITY QUEUE] Removed Emergency ${e.emergency_id} from queue (Cancellation)`);
    if(e.selected_ambulance){ const a=ambulanceTable.get(e.selected_ambulance.ambulance_id); if(a){ console.log(`[CANCEL ADMIN] Halting simulation and freeing ambulance ${a.id}`); const t=missionTimers.get(a.id); if(t)clearInterval(t); missionTimers.delete(a.id);a.available=true;a.status='AVAILABLE';a.assigned_emergency=null;} }
    e.status='CANCELLED';e.final_status='CANCELLED';e.completed_at=new Date().toISOString(); archiveEmergency(e); enqueueOperation('CANCELLED',`Emergency ${e.emergency_id} cancelled`,e.emergency_id); broadcastState(); res.json({success:true});
});

function startMissionSimulation(e,a,pickupRoute,hospitalRoute){
    console.log(`[SIMULATION] Starting mission simulation for Ambulance ${a.id} on Emergency ${e.emergency_id}`);
    if(missionTimers.has(a.id))clearInterval(missionTimers.get(a.id)); let phase='pickup',i=0;
    const timer=setInterval(()=>{
        const route=phase==='pickup'?pickupRoute:hospitalRoute;
        if(!route||!route.length){ console.log(`[SIMULATION] Route missing/empty. Terminating mission early.`); finishMission(e,a);return;}
        if(i<route.length){ const p=route[i++];a.lat=p.lat;a.lng=p.lng;a.status=phase==='pickup'?'EN_ROUTE_TO_SCENE':'EN_ROUTE_TO_HOSPITAL';e.mission_phase=a.status;e.active_route=route.slice(i); if(i % 10 === 0) { console.log(`[SIMULATION TICK] Ambulance ${a.id} @ node index ${i}/${route.length} (${phase} phase).`); } broadcastState();return; }
        if(phase==='pickup'){ console.log(`[SIMULATION] Ambulance ${a.id} arrived at pickup scene.`); phase='hospital';i=0;a.status='AT_SCENE';e.mission_phase='AT_SCENE';broadcastState();return;}
        console.log(`[SIMULATION] Ambulance ${a.id} arrived at destination hospital.`);
        finishMission(e,a);
    },120);
    missionTimers.set(a.id,timer);
}
function finishMission(e,a){
    console.log(`[SIMULATION COMPLETION] Finalizing mission ${e.emergency_id}. Freeing Ambulance ${a.id}.`);
    const t=missionTimers.get(a.id);if(t)clearInterval(t);missionTimers.delete(a.id);
    if(e.selected_hospital){a.lat=e.selected_hospital.location?.lat??hospitals.find(h=>h.id===e.selected_hospital.hospital_id)?.lat??a.lat;a.lng=e.selected_hospital.location?.lng??hospitals.find(h=>h.id===e.selected_hospital.hospital_id)?.lng??a.lng;}
    a.status='AVAILABLE';a.available=true;a.assigned_emergency=null;e.status='COMPLETED';e.final_status='COMPLETED';e.mission_phase='COMPLETED';e.active_route=null;e.completed_at=new Date().toISOString();archiveEmergency(e);enqueueOperation('COMPLETED',`Emergency ${e.emergency_id} completed and archived`,e.emergency_id);broadcastState();
}
function archiveEmergency(e){
    if(historyTable.has(e.emergency_id))return;
    console.log(`[ARCHIVE] Saving Emergency ${e.emergency_id} to history hash table.`);
    const h={ emergency_id:e.emergency_id,ambulance_id:e.selected_ambulance?.ambulance_id||null,emergency_type:e.type,priority:e.priority,patient_location:e.location,hospital:e.selected_hospital?{id:e.selected_hospital.hospital_id,name:e.selected_hospital.name}:null,route:e.selected_hospital?.route||[],travel_time:e.selected_hospital?.travel_time_minutes??null,final_status:e.final_status||e.status,created_at:e.created_at,completed_at:e.completed_at };
    emergencyHistory.push(h);historyTable.set(h.emergency_id,h);
}

// ============================================================
// HISTORY
// ============================================================
app.get('/api/history',(req,res)=>{ res.json(emergencyHistory); });
app.get('/api/history/:id',(req,res)=>{ console.log(`[HISTORY DB] Lookup ID: ${req.params.id}`); const h=historyTable.get(String(req.params.id));if(!h)return res.status(404).json({error:'History record not found.'});res.json(h);});

// ============================================================
// ROAD / TRAFFIC ADMINISTRATION
// ============================================================
app.post('/api/roads/block',(req,res)=>{const {source,destination}=req.body; console.log(`[ROAD ADMIN] Blocking road ${source} -> ${destination}`); if(!cityMap.blockRoad(source,destination))return res.status(404).json({error:'Road edge not found.'});trafficIncidents=trafficSnapshot();enqueueOperation('ROAD_BLOCK',`Road ${source} -> ${destination} blocked`);broadcastState();res.json({success:true,road:cityMap.getRoadCondition(source,destination)});});
app.post('/api/roads/open',(req,res)=>{const {source,destination}=req.body; console.log(`[ROAD ADMIN] Re-opening road ${source} -> ${destination}`); if(!cityMap.openRoad(source,destination))return res.status(404).json({error:'Road edge not found.'});trafficIncidents=trafficSnapshot();enqueueOperation('ROAD_OPEN',`Road ${source} -> ${destination} reopened`);broadcastState();res.json({success:true,road:cityMap.getRoadCondition(source,destination)});});
app.post('/api/roads/travel-time',(req,res)=>{const {source,destination,minutes}=req.body; console.log(`[ROAD ADMIN] Adjusting travel time for ${source} -> ${destination} to ${minutes} mins`); if(!cityMap.setRoadTravelTime(source,destination,Number(minutes)))return res.status(400).json({error:'Road not found or invalid minutes.'});enqueueOperation('ROAD_TIME',`Road ${source} -> ${destination} base travel time set to ${minutes} min`);broadcastState();res.json({success:true,road:cityMap.getRoadCondition(source,destination)});});
app.get('/api/roads/condition',(req,res)=>{const r=cityMap.getRoadCondition(req.query.source,req.query.destination);if(!r)return res.status(404).json({error:'Road edge not found.'});res.json(r);});
app.get('/api/roads',(req,res)=>{ console.log(`[ROAD ADMIN] Exporting road network state...`); const limit=Math.min(Number(req.query.limit)||100,500);const rows=[];for(const [s,edges] of cityMap.nodes){for(const e of edges){rows.push({source:s,destination:e.destination,time:Number(e.time.toFixed(3)),baseTime:e.baseTime,status:e.status?'BLOCKED':'OPEN',traffic:e.traffic,trafficMultiplier:e.trafficMultiplier,trafficSource:e.trafficSource});if(rows.length>=limit)return res.json(rows);}}res.json(rows);});
app.post('/api/traffic/update',async(req,res)=>{ console.log(`[TRAFFIC ADMIN] Manual traffic API refresh requested...`); try{await refreshRelevantTomTomTraffic(true);enqueueOperation('TRAFFIC_UPDATE','Traffic edge weights refreshed');res.json({success:true,provider:tomtomTraffic.enabled?'TomTom':'Simulator',incidents:trafficIncidents.length});}catch(err){ console.error(`[TRAFFIC ADMIN ERROR]`, err); res.status(500).json({error:err.message});}});
app.get('/api/traffic/status',(req,res)=>res.json({provider:tomtomTraffic.enabled?'TomTom':'Simulator',enabled:tomtomTraffic.enabled,cached_edges:relevantTrafficEdges.size,incidents:trafficIncidents,refresh_interval_ms:Number(process.env.TRAFFIC_REFRESH_MS||60000)}));

app.get('/api/ambulances',(req,res)=>res.json(ambulanceTable.values()));
app.get('/api/ambulances/:id',(req,res)=>{ console.log(`[DB LOOKUP] Ambulance Lookup ID: ${req.params.id}`); const a=ambulanceTable.get(req.params.id);if(!a)return res.status(404).json({error:'Ambulance not found.'});res.json(a);});
app.get('/api/hospitals',(req,res)=>res.json(hospitals));
app.get('/api/live',(req,res)=>res.json(publicState()));

app.get('/',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.get('/admin',(req,res)=>res.sendFile(path.join(__dirname,'public','admin.html')));
app.get('/command',(req,res)=>res.sendFile(path.join(__dirname,'public','command.html')));

const PORT=Number(process.env.PORT||3000);
server.listen(PORT,()=>console.log(`\n🚑 RescueRoute running on http://localhost:${PORT}\nTraffic: ${tomtomTraffic.enabled?'TomTom':'Simulated fallback'}\nDSA: PriorityQueue + AmbulanceMinHeap + HashTable + Queue + Graph + Dijkstra`));