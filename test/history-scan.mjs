import assert from "node:assert/strict";
import { collectHistory, mergeHistorySnapshots } from "../server/history-scan.js";

const msg = (text, kind = "text") => ({ kind, text, from: "Friend", time: "12:00" });
const pages = [
  [msg("new video", "media"), msg("latest message")],
  [msg("middle"), msg("new video", "media"), msg("latest message")],
  [msg("old status", "status"), msg("middle"), msg("new video", "media")],
];
let position = 0;
let restores = 0;
const out = await collectHistory({
  firstItems: pages[0],
  read: async () => pages[position],
  capture: async () => new Map(),
  scrollOlder: async () => { position++; return { moved: true, atTop: position === pages.length - 1 }; },
  restore: async () => { restores++; },
  pause: async () => {},
});
assert.deepEqual(out.items.map(x => x.text), ["old status", "middle", "new video", "latest message"]);
assert.equal(out.reachedTop, true);
assert.equal(out.truncated, false);
assert.equal(out.pages, 3);
assert.equal(restores, 1);
assert.equal(mergeHistorySnapshots([[msg("same"),msg("same")], [msg("same"),msg("same")]]).length, 2,
  "identical repeated notices within the same viewport must survive");
const noScroll = await collectHistory({
  firstItems: [msg("already visible")],
  scrollOlder: async () => ({ moved:false, atTop:false }),
  restore: async () => {},
});
assert.equal(noScroll.truncated,true);
assert.deepEqual(noScroll.items.map(x => x.text),["already visible"]);
let restoredAfterError = false;
await assert.rejects(() => collectHistory({
  firstItems: [msg("some text")],
  scrollOlder: async () => { throw Error("scroll failed"); },
  restore: async () => { restoredAfterError = true; },
}),/scroll failed/);
assert.equal(restoredAfterError,true);
console.log("History merge passed: older-first chronological order, retained duplicates, bounded fallback and restoration.");
