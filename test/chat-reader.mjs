import assert from "node:assert/strict";
import { extractVisibleMessages } from "../server/chat-reader.js";
const doc = globalThis.document;
const styles = globalThis.getComputedStyle;
try {
  const noop = () => null;
  const visible = { display: "block", visibility: "visible", borderColor: "rgb(14, 173, 255)" };
  globalThis.getComputedStyle = () => visible;
  function el(tag, value, opts = {}) {
    return {
      tagName: tag.toUpperCase(), textContent: value, children: opts.children || [],
      src: opts.src, naturalWidth: opts.width, naturalHeight: opts.height,
      hidden: false, querySelector: noop, querySelectorAll: () => [],
      getAttribute: () => null, closest: () => null, matches: () => false,
    };
  }
  const text = el("span", "hello there");
  const text2 = el("span", "I can see these");
  const image = el("img", "", { src: "blob:photo", width: 240, height: 240 });
  const time = el("span", "12:48");
  const root = {
    textContent: "hello there I can see these 12:48",
    querySelectorAll(selector) {
      if (selector === "li.T1yt2") return [];
      if (selector === "*") return [text,text2,time,image];
      return [];
    },
  };
  globalThis.document = { getElementById: id => id === "cv-friend" ? root : null };
  assert.equal(extractVisibleMessages("other", "Friend"), null, "other conversation must not be read");
  const items = extractVisibleMessages("friend", "Friend");
  assert.deepEqual(items.map(x => x.kind), ["text","text","media"]);
  assert.deepEqual(items.filter(x => x.kind === "text").map(x => x.text), ["hello there","I can see these"]);
  assert.equal(items.at(-1).src, "blob:photo");
  assert.ok(items.every(x => x.from === "Friend"));
  globalThis.document = { getElementById: () => ({
    textContent: "unknown layout", querySelectorAll: () => [],
  }) };
  assert.equal(extractVisibleMessages("friend", "Friend"), null, "selector failure must not become empty archive");
  globalThis.document = { getElementById: () => ({
    textContent: "No messages yet", querySelectorAll: () => [],
  }) };
  assert.deepEqual(extractVisibleMessages("friend", "Friend"), [], "explicit empty chat may return empty list");
  console.log("Snapchat message-reader fallbacks: text, media, timestamps, missing root and safe empty state passed");
} finally {
  globalThis.document = doc;
  globalThis.getComputedStyle = styles;
}
