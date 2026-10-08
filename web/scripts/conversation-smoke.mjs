import assert from "node:assert/strict";
import { group } from "../src/message-groups.js";
assert.deepEqual(group([]), []);
const msgs=[{uid:"1",from:"Alex",isMe:false},{uid:"2",from:"Alex",isMe:false},{uid:"3",from:"Me",isMe:true},{uid:"4",from:"Jo",isMe:false}];
const g=group(msgs);
assert.deepEqual(g.map(x=>x.messages.map(m=>m.uid)),[["1","2"],["3"],["4"]]);
assert.deepEqual(g.map(x=>x.isMe),[false,true,false]);
console.log("Conversation grouping smoke tests passed.");
