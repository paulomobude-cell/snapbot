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

  // Snapchat can use legacy <li> for captions while saved images/videos sit
  // outside that list. The reader must not stop after the first text message.
  const caption = el("span", "Isn't this winifred your sister?");
  caption.matches = selector => selector === "span.ogn1z";
  const legacyBubble = el("li", "");
  legacyBubble.querySelectorAll = selector => selector === "span.ogn1z, img, video, button, [role='button']" ? [caption] : [];
  const legacyRow = el("li", "");
  legacyRow.querySelector = () => null;
  legacyRow.querySelectorAll = selector => selector === "li" ? [legacyBubble] : [];
  const savedPhoto = el("img", "", { src:"blob:saved-photo", width:480, height:620 });
  const savedVideo = el("video", "", { src:"blob:saved-video", width:400, height:300 });
  // Snapchat wraps many saved images in interactive containers. That should
  // not cause a visible saved photo to disappear from the archive.
  savedPhoto.closest = selector => selector === "button, [role='button']"
    ? { getAttribute: () => "Saved image", textContent: "Saved image" } : null;
  savedVideo.currentSrc = "blob:saved-video";
  globalThis.document = { getElementById: id => id === "cv-friend" ? ({
    textContent: "caption and saved media",
    querySelectorAll: selector => selector === "li.T1yt2" ? [legacyRow] :
      selector === "img, video, [style*='background-image']" ? [savedPhoto, savedVideo] :
      selector === "*" ? [savedPhoto, legacyRow, legacyBubble, caption, savedVideo] : [],
  }) : null };
  const combined = extractVisibleMessages("friend", "Friend");
  assert.deepEqual(combined.map(m=>m.kind), ["media","text","media"],
    "image before caption, then video in DOM order with legacy text present");
  assert.deepEqual(combined.filter(m=>m.kind==="media").map(m=>m.src),
    ["blob:saved-photo","blob:saved-video"]);
  assert.ok(combined.every(m=>m.from==="Friend"));
  const statusItems = [
    el("span", "You saved a video"),
    el("span", "You took a screenshot of the chat"),
    el("span", "Alex saved a photo to chat"),
    el("span", "Photo from vacation"),
  ];
  globalThis.document = { getElementById: id => id === "cv-friend" ? ({
    textContent: statusItems.map(item => item.textContent).join(" "),
    querySelectorAll: selector => selector === "*" ? statusItems : [],
  }) : null };
  const classified = extractVisibleMessages("friend", "Friend");
  assert.deepEqual(classified.map(item => item.kind), ["notice", "notice", "notice", "text"]);
  assert.equal(classified.some(item => item.kind === "media"), false,
    "saved-media notice must not pretend its bytes are available");
    const realLabels = [
    el("span", "YOU ARE USING SNAPCHAT FOR WEB"),
    el("span", "YOU TOOK A SCREENSHOT OF CHAT!"),
    el("span", "YOU SCREEN RECORDED CHAT!"),
    el("span", "YOU SAVED A VIDEO FROM Osaebobo"),
    el("span", "This video is no longer available"),
    el("span", "1 year ago"),
    el("span", "Click to view"),
    el("span", "Okay my love"),
  ];
  globalThis.document = { getElementById: id => id === "cv-friend" ? ({
    textContent: realLabels.map(item => item.textContent).join(" "),
    querySelectorAll: selector => selector === "*" ? realLabels : [],
  }) : null };
  const reality = extractVisibleMessages("friend", "Friend");
  assert.deepEqual(reality.map(item => item.kind), ["notice","notice","notice","notice","notice","snap","text"]);
  assert.ok(reality.filter(item=>item.kind==="notice").every(item=>item.isMe===false && item.from==="Snapchat"),
    "system labels must never be presented as outgoing messages");
  assert.equal(reality.at(-1).text,"Okay my love");
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
