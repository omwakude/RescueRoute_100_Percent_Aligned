class HashTable {
    constructor(size=101){ this.size=size; this.buckets=Array.from({length:size},()=>[]); }
    #hash(key){ let h=0; for(const ch of String(key)) h=(h*31+ch.charCodeAt(0))%this.size; return h; }
    set(key,value){ const b=this.buckets[this.#hash(key)]; const x=b.find(p=>p.key===String(key)); if(x)x.value=value; else b.push({key:String(key),value}); }
    get(key){ return this.buckets[this.#hash(key)].find(p=>p.key===String(key))?.value || null; }
    has(key){ return this.get(key)!==null; }
    values(){ return this.buckets.flat().map(p=>p.value); }
}
module.exports=HashTable;
