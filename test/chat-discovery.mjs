import assert from "node:assert/strict";
import { discoverChats } from "../server/chat-discovery.js";
const rows=Array.from({length:53},(_,i)=>({id:String(i),name:"Chat "+i}));
let top=400;
const getPosition=async()=>({scrollTop:top,clientHeight:110,scrollHeight:540});
const scrollTo=async n=>{top=Math.max(0,Math.min(430,n));};
const readVisible=async()=>rows.slice(Math.floor(top/10),Math.floor(top/10)+12);
const all=await discoverChats({readVisible,getPosition,scrollTo,pause:async()=>{},fullScan:true});
assert.equal(all.length,53);
assert.equal(all[0].id,"0");
assert.equal(all[52].id,"52");
assert.equal(top,400);
const quick=await discoverChats({readVisible,getPosition,scrollTo});
assert.ok(quick.length<all.length);
let threw=false;
try {await discoverChats({readVisible:async()=>{throw Error("DOM changed");},getPosition,scrollTo,pause:async()=>{},fullScan:true});}
catch {threw=true;}
assert.equal(threw,true);
assert.equal(top,400);
// A synchronous adapter can return null rather than a Promise. Its successful
// restoration must not raise "Cannot read properties of null (reading 'catch')".
top = 400;
const syncScrollTo = n => { top = Math.max(0, Math.min(430, n)); return null; };
const synchronous = await discoverChats({ readVisible, getPosition, scrollTo: syncScrollTo,
  pause: async () => {}, fullScan: true });
assert.equal(synchronous.length, 53);
assert.equal(top, 400);
// Restoration is best effort even if the adapter itself throws.
top = 400;
let restoreCalls = 0;
const restoreThrows = n => {
  restoreCalls++;
  if (restoreCalls > 1 && n === 400) throw new Error("restoration failed");
  top = Math.max(0, Math.min(430, n));
  return null;
};
await discoverChats({readVisible, getPosition, scrollTo: restoreThrows,
  pause: async () => {}, fullScan: true});
console.log("Virtualized chat list discovery smoke tests passed.");
