import assert from "node:assert/strict";
import SnapBot from "../snapbot.js";

// Fake the Puppeteer page to regression-test the exact remote chat-click path,
// without sending anything to Snapchat or running a browser in CI.
const bot = new SnapBot();
let root = false, visible = null, titleClicks = 0, rowClicks = 0, waits = 0, allowRow = true;
const title = {
  click: async () => { titleClicks++; },
  evaluateHandle: async () => ({ asElement: () => ({ click: async () => { rowClicks++; if (allowRow) { root=true; visible="c1"; } } }) }),
};
bot.page = {
  $: async selector => selector.includes("title-c1") ? title : selector.includes("cv-c1") && root ? {} : null,
  evaluate: async () => 0,
  waitForSelector: async () => {
    waits++;
    if (!root) throw Error("delayed conversation");
    return {};
  },
};
bot.visibleChatId = async () => visible;
assert.equal(await bot.openChat("c1"),true,"try the exact conversation row when a label click does not open it");
assert.equal(titleClicks,1);
assert.equal(rowClicks,1);
assert.equal(waits,2);
assert.equal(bot.lastChatOpenReason,null);
assert.equal(await bot.openChat("c1"),true,"already visible conversation must not get clicked twice");
assert.equal(titleClicks,1);
root=false; visible=null; allowRow=false;
bot.page.waitForSelector=async()=>{ throw Error("not yet visible"); };
assert.equal(await bot.openChat("c1"),false,"should fail safely if neither click opens the requested chat");
assert.match(bot.lastChatOpenReason,/did not show/);
// If the inner title is not clickable, the enclosing exact-ID row still is.
root=false; visible=null; allowRow=true; title.click=async()=>{titleClicks++; throw Error("span detached during virtualization");};
bot.page.waitForSelector=async()=>root ? {} : Promise.reject(Error("not visible yet"));
assert.equal(await bot.openChat("c1"),true,"fallback row works after title click throws");
assert.equal(bot.lastChatOpenReason,null);
console.log("Snapchat openChat fallback checks passed: exact row retry, visible root, safe refusal, detached title.");
