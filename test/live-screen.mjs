import assert from "node:assert/strict";
import Session from "../server/session.js";

const calls = [];
function makePage(host) {
  return {
    isClosed: () => false,
    url: () => `https://${host}/login`,
    title: async () => host,
    screenshot: async () => Buffer.from("fake-jpeg"),
    viewport: () => ({ width: 1920, height: 1080 }),
    bringToFront: async () => calls.push(host + ":front"),
    mouse: {
      click: async (x, y) => calls.push(host + ":click:" + x + "," + y),
      wheel: async (d) => calls.push(host + ":wheel:" + d.deltaY),
    },
    keyboard: {
      type: async (text) => calls.push(host + ":text:" + text),
      press: async (key) => calls.push(host + ":key:" + key),
    },
  };
}
const snapchat = makePage("accounts.snapchat.com");
const google = makePage("accounts.google.com");
const browserTabs = [snapchat];
const session = new Session({
  store: {}, media: {}, config: {}, profileDir: "/tmp/mock-screen",
});
session.bot = { page: snapchat, browser: { pages: async () => browserTabs } };
const frames = [];
session.on("screen:frame", (d) => frames.push(d));

await session.addViewer();
assert.equal(frames.at(-1).pages.length, 1);
assert.equal(frames.at(-1).width, 1920, "frame has native HD width");
assert.equal(frames.at(-1).height, 1080, "frame has native HD height");
assert.equal(frames.at(-1).quality, 86, "HD JPEG is the quality default");
const firstFrames = frames.length;
await session.pushScreenFrame();
assert.equal(frames.length, firstFrames, "unchanged frames should not be retransmitted");
assert.equal(frames.at(-1).pages[0].site, "accounts.snapchat.com");
await session.click(.5, .25);
assert.ok(calls.includes("accounts.snapchat.com:click:960,270"));
await session.type("hello@example.com");
assert.ok(calls.includes("accounts.snapchat.com:text:hello@example.com"));
await session.press("Tab");
assert.ok(calls.includes("accounts.snapchat.com:key:Tab"));

browserTabs.push(google);
await session.pushScreenFrame();
assert.equal(frames.at(-1).pages.length, 2);
assert.equal(frames.at(-1).pages.find(p => p.id === frames.at(-1).pageId).site, "accounts.google.com");
await session.click(.5, .5);
assert.ok(calls.includes("accounts.google.com:click:960,540"));

await session.selectScreenPage(frames.at(-1).pages.find(p => p.site === "accounts.snapchat.com").id);
await session.scroll(5000);
assert.ok(calls.includes("accounts.snapchat.com:wheel:1400"));
await assert.rejects(() => session.click(-1, 3), /coordinates/);
await assert.rejects(() => session.press("Control+P"), /Unsupported/);
await assert.rejects(() => session.type("x".repeat(2100)), /characters/);

await session.removeViewer();
assert.equal(session.screenTimer, null, "capture interval should stop when no viewers");
console.log("Interactive live-browser regression checks passed: tabs, popup, clicking, text, keys, scroll, validation, teardown.");
