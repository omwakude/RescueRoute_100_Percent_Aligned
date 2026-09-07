class AmbulanceMinHeap {
    constructor(){ this.heap=[]; }
    insert(ambulanceCandidate){ this.heap.push(ambulanceCandidate); this.#up(this.heap.length-1); }
    extractMin(){ if(!this.heap.length) return null; if(this.heap.length===1) return this.heap.pop(); const min=this.heap[0]; this.heap[0]=this.heap.pop(); this.#down(0); return min; }
    isEmpty(){ return this.heap.length===0; }
    #eta(x){ return Number(x.eta_minutes); }
    #up(i){ while(i>0){ const p=Math.floor((i-1)/2); if(this.#eta(this.heap[p])<=this.#eta(this.heap[i])) break; [this.heap[p],this.heap[i]]=[this.heap[i],this.heap[p]]; i=p; } }
    #down(i){ while(true){ let s=i,l=2*i+1,r=2*i+2; if(l<this.heap.length&&this.#eta(this.heap[l])<this.#eta(this.heap[s])) s=l; if(r<this.heap.length&&this.#eta(this.heap[r])<this.#eta(this.heap[s])) s=r; if(s===i) break; [this.heap[i],this.heap[s]]=[this.heap[s],this.heap[i]]; i=s; } }
}
module.exports=AmbulanceMinHeap;
