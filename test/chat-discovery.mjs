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
console.log("Virtualized chat list discovery smoke tests passed.");
