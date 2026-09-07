class EmergencyPriorityQueue {
    constructor() { this.heap = []; this.sequence = 0; }
    enqueue(emergency) {
        const item = { emergency, priority: emergency.priority, sequence: this.sequence++ };
        this.heap.push(item); this.#up(this.heap.length - 1); return item;
    }
    peek() { return this.heap[0]?.emergency || null; }
    dequeue() {
        if (!this.heap.length) return null;
        const top = this.heap[0]; const last = this.heap.pop();
        if (this.heap.length) { this.heap[0] = last; this.#down(0); }
        return top.emergency;
    }
    removeById(id) {
        const i = this.heap.findIndex(x => String(x.emergency.emergency_id) === String(id));
        if (i < 0) return false;
        const last = this.heap.pop();
        if (i < this.heap.length) { this.heap[i] = last; this.#up(i); this.#down(i); }
        return true;
    }
    toSortedArray() {
        return [...this.heap].sort((a,b) => b.priority-a.priority || a.sequence-b.sequence).map(x => x.emergency);
    }
    isEmpty() { return this.heap.length === 0; }
    #better(a,b) { return a.priority > b.priority || (a.priority === b.priority && a.sequence < b.sequence); }
    #up(i) { while(i>0){ const p=Math.floor((i-1)/2); if(this.#better(this.heap[p],this.heap[i])) break; [this.heap[p],this.heap[i]]=[this.heap[i],this.heap[p]]; i=p; } }
    #down(i) { while(true){ let b=i,l=2*i+1,r=2*i+2; if(l<this.heap.length&&this.#better(this.heap[l],this.heap[b])) b=l; if(r<this.heap.length&&this.#better(this.heap[r],this.heap[b])) b=r; if(b===i) break; [this.heap[i],this.heap[b]]=[this.heap[b],this.heap[i]]; i=b; } }
}
module.exports = EmergencyPriorityQueue;
