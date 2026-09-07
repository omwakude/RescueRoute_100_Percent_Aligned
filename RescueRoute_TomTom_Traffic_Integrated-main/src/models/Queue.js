class Queue {
    constructor(){ this.items=[]; this.front=0; }
    enqueue(item){ this.items.push(item); }
    dequeue(){ if(this.isEmpty()) return null; const item=this.items[this.front++]; if(this.front>50&&this.front*2>this.items.length){ this.items=this.items.slice(this.front); this.front=0; } return item; }
    peek(){ return this.isEmpty()?null:this.items[this.front]; }
    isEmpty(){ return this.front>=this.items.length; }
    size(){ return this.items.length-this.front; }
    toArray(){ return this.items.slice(this.front); }
}
module.exports=Queue;
