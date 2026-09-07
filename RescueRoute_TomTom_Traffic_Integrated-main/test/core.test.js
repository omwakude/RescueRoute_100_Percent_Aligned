const assert = require('assert');
const Graph = require('../src/models/Graph');
const MinHeap = require('../src/models/MinHeap');
const AmbulanceMinHeap = require('../src/models/AmbulanceMinHeap');
const EmergencyPriorityQueue = require('../src/models/EmergencyPriorityQueue');
const HashTable = require('../src/models/HashTable');
const Queue = require('../src/models/Queue');

// Routing MinHeap
const mh = new MinHeap(); mh.insert('slow', 5); mh.insert('fast', 1); assert.equal(mh.extractMin().element, 'fast');
// Separate ambulance ETA heap
const ah = new AmbulanceMinHeap(); ah.insert({ambulance_id:'A',eta_minutes:8}); ah.insert({ambulance_id:'B',eta_minutes:3}); assert.equal(ah.extractMin().ambulance_id,'B');
// Emergency max-priority + FIFO tie handling
const pq = new EmergencyPriorityQueue(); pq.enqueue({emergency_id:'1',priority:8}); pq.enqueue({emergency_id:'2',priority:10}); pq.enqueue({emergency_id:'3',priority:8}); assert.equal(pq.dequeue().emergency_id,'2'); assert.equal(pq.dequeue().emergency_id,'1');
// Hash table lookup
const ht = new HashTable(7); ht.set('AMB-01',{id:'AMB-01'}); assert.equal(ht.get('AMB-01').id,'AMB-01');
// FIFO Queue
const q = new Queue(); q.enqueue('first'); q.enqueue('second'); assert.equal(q.dequeue(),'first'); assert.equal(q.dequeue(),'second');
// Graph + Dijkstra + reconstruction + blocking/reopening + edge-time updates
const g = new Graph(); g.addEdge('A','B',100,1); g.addEdge('B','C',100,1); g.addEdge('A','C',100,5);
let r = g.findFastestRoute('A','C'); assert.deepEqual(r.path,['A','B','C']); assert.equal(r.time,2);
assert.equal(g.blockRoad('B','C'),true); r=g.findFastestRoute('A','C'); assert.deepEqual(r.path,['A','C']); assert.equal(r.time,5);
assert.equal(g.openRoad('B','C'),true); assert.equal(g.setRoadTravelTime('A','B',10),true); r=g.findFastestRoute('A','C'); assert.deepEqual(r.path,['A','C']);
console.log('All RescueRoute DSA core tests passed.');
