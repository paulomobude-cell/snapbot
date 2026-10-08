// Runs directly inside Snapchat's Chromium page via page.evaluate().
// Do not import other helpers: Puppeteer serializes this function into the page.
//
// Snapchat changes class names frequently. First use the old proven structure;
// if no readable messages were found, fall back to semantic/leaf elements
// within the selected conversation container only. Never inspect the sidebar,
// outgoing network data, or other users' conversations.
export function extractVisibleMessages(chatId, chatName, deletedPattern, snapPattern) {
  const root = document.getElementById("cv-" + chatId);
  if (!root) return null; // not the selected conversation: do not misfile anything
  const ME = "rgb(242, 60, 87)";
  const deletedRe = new RegExp(deletedPattern || "\\bdeleted (a|an|the)? ?(chat|snap|message|photo|image|video|voice|audio|sticker|attachment)", "i");
  const snapRe = new RegExp(snapPattern || "\\b(tap to view|click to view|tap to replay|tap to load|new snap|received snap)\\b", "i");
  // Snapchat renders service activity inline with actual messages. An event
  // saying "saved a video" does not provide the underlying video file.
  const statusRe = /^(?:(?:you|[\p{L}][\p{L} .'-]{0,65})\s+)?(?:saved|unsaved|deleted|opened|replayed|screenshotted|recorded|received|sent|viewed|reacted to|removed|pinned|unpinned)\s+(?:(?:a|an|the|your|their)\s+)?(?:chat|message|snap|photo|video|image|sticker|attachment|audio|voice(?: note)?)(?:\s+(?:in|from|to)\s+chat)?[.!]?$/iu;
  const screenshotRe = /^(?:(?:you|[\p{L}][\p{L} .'-]{0,65})\s+)?(?:took a screenshot(?: of (?:the|a|your) (?:chat|snap|photo|video))?|screen recorded(?: the chat)?)\s*[.!]?$/iu;
  const savedRe = /^(?:saved (?:a )?(?:photo|video|snap|image|media)|tap to save|media saved in chat|snap saved in chat)$/i;
  // Actual Snapchat activity strings observed in the user's screenshots.
  // Keep these out of messages and never attribute them to "Me".
  const systemRe = /^(?:you are using snapchat for web|you (?:took a screenshot(?: of (?:chat|friendship profile|the chat|the friendship profile))?|screen recorded chat|saved (?:a |an? )?(?:video|photo|snap|image)(?: from .{1,80})?)|this (?:video|snap|photo) is no longer available|(?:you|.{1,65}) saved (?:a |an? )?(?:video|photo|snap)(?: from .{1,80})?)[.!]?$/i;
  const relativeTimeRe = /^(?:\d+\s+(?:seconds?|minutes?|hours?|days?|weeks?|months?|years?)\s+ago|today|yesterday)$/i;
  const output = [];
  let currentTime = "";
  let snapIndex = 0;

  const senderFrom = node => {
    const ancestor = node?.closest?.("[data-sender], [data-message-sender]");
    const explicit = ancestor?.getAttribute?.("data-sender") || ancestor?.getAttribute?.("data-message-sender");
    if (explicit) return /^(me|you|self|outgoing)$/i.test(explicit) ? "Me" : chatName;
    const wrapper = node?.closest?.("li, [role='listitem'], [data-message-id], [data-testid*='message' i]") || node;
    const header = wrapper.querySelector?.("header .nonIntl");
    if (header?.textContent?.trim()) return header.textContent.trim();
    const border = wrapper.querySelector?.(".KB4Aq") || wrapper.closest?.(".KB4Aq");
    if (border && getComputedStyle(border).borderColor === ME) return "Me";
    if (wrapper.matches?.("[class*='outgoing' i], [class*='sent' i], [class*='mine' i]") ||
        wrapper.closest?.("[class*='outgoing' i], [class*='sent' i], [class*='mine' i]")) return "Me";
    return chatName;
  };

  const addText = (text, node, forcedSender) => {
    const value = String(text || "").replace(/\s+/g, " ").trim();
    if (!value || value.length > 6000 || relativeTimeRe.test(value)) return;
    const from = forcedSender || senderFrom(node);
    const base = { from, isMe: from === "Me", time: currentTime };
    if (deletedRe.test(value) && value.length < 120) {
      const who = value.split(/\s+deleted\b/i)[0].trim();
      output.push({ kind: "notice", notice: "deleted", ...base, from: who || from, text: value });
    } else if ((statusRe.test(value) || screenshotRe.test(value) || savedRe.test(value) || systemRe.test(value)) && value.length < 200) {
      output.push({ kind: "notice", notice: /saved|unsaved/i.test(value) ? "saved" : "status",
        from: "Snapchat", isMe: false, time: currentTime, text: value });
    } else if (snapRe.test(value) && value.length < 160) {
      output.push({ kind: "snap", ...base, text: "", snapIndex: snapIndex++ });
    } else {
      output.push({ kind: "text", ...base, text: value });
    }
  };

  const contentImage = img => {
    if (img.closest?.("header, nav, button, [role='button'], [class*='avatar' i]")) return false;
    const width = img.naturalWidth || img.width || 0;
    const height = img.naturalHeight || img.height || 0;
    return width >= 64 && height >= 64;
  };
  const addMedia = (node, forcedSender) => {
    const from = forcedSender || senderFrom(node);
    const base = { from, isMe: from === "Me", time: currentTime };
    if (node.tagName === "IMG" && node.src && contentImage(node)) {
      output.push({ kind: "media", ...base, text: "", src: node.src, mediaType: "image" });
    } else if (node.tagName === "VIDEO") {
      const src = node.currentSrc || node.src || node.querySelector?.("source")?.src;
      if (src) output.push({ kind: "media", ...base, text: "", src, mediaType: "video" });
    }
  };

  const legacy = root.querySelectorAll("li.T1yt2");
  for (const row of legacy) {
    const timeElem = row.querySelector("time span");
    if (timeElem) {
      currentTime = timeElem.textContent?.trim() || "";
      continue;
    }
    const blocks = row.querySelectorAll("li");
    const targets = blocks.length ? blocks : [row];
    for (const block of targets) {
      const from = senderFrom(block);
      const nodes = block.querySelectorAll("span.ogn1z, img, video, button, [role='button']");
      for (const node of nodes) {
        if (node.matches("span.ogn1z")) addText(node.textContent, node, from);
        else if (node.tagName === "IMG" || node.tagName === "VIDEO") addMedia(node, from);
        else {
          const label = node.getAttribute?.("aria-label") || node.textContent || "";
          if (snapRe.test(label) && label.length < 160) {
            node.setAttribute("data-sb-snap", String(snapIndex));
            output.push({ kind: "snap", from, isMe: from === "Me", time: currentTime, text: "", snapIndex: snapIndex++ });
          }
        }
      }
    }
  }
  if (output.length) return output;

  // Newer Snapchat UI versions can replace the legacy "li.T1yt2" and
  // "span.ogn1z" classes. Traverse actual text/image leaves of the selected
  // chat only, in DOM order, and skip chrome, timestamps and the composer.
  const ignored = "header, nav, footer, aside, button, [role='button'], [role='textbox'], [contenteditable], input, textarea, svg, time, [aria-hidden='true']";
  const isIgnored = el => Boolean(el?.closest?.(ignored));
  const isVisible = el => {
    if (!el || el.hidden || el.getAttribute?.("aria-hidden") === "true") return false;
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden";
  };
  const dateOnly = /^(today|yesterday|tomorrow|mon(day)?|tue(sday)?|wed(nesday)?|thu(rsday)?|fri(day)?|sat(urday)?|sun(day)?|\d{1,2}:\d{2}(?:\s*[ap]m)?|received|delivered|opened|screenshotted|saved in chat)$/i;
  const seenText = new Map();
  for (const el of root.querySelectorAll("*")) {
    if (isIgnored(el) || !isVisible(el)) continue;
    if (el.tagName === "IMG" || el.tagName === "VIDEO") {
      addMedia(el);
      continue;
    }
    if (!["DIV", "SPAN", "P", "LI", "LABEL"].includes(el.tagName)) continue;
    // A leaf (or wrapper containing only empty decorative descendants) can
    // represent a message. Avoid collecting the same text from its ancestors.
    if ([...el.children].some(child => child.textContent?.trim())) continue;
    const value = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (!value || value.length > 6000) continue;
    if (dateOnly.test(value) && !/^(?:received|opened|saved in chat)$/i.test(value)) continue;
    if (el.matches?.("[class*='time' i], [class*='status' i], [class*='timestamp' i]")) continue;
    // Repeated identical text elements under the same bubble are duplicate
    // markup, not separate messages. Identical texts in separate bubbles stay.
    const bubble = el.closest?.("[data-message-id], [data-testid*='message' i], li, [role='listitem']") || el;
    if (seenText.has(bubble) && seenText.get(bubble)?.has(value)) continue;
    if (!seenText.has(bubble)) seenText.set(bubble, new Set());
    seenText.get(bubble).add(value);
    // Ignore untrusted metadata selectors only if they are visibly plain UI;
    // otherwise favor preserving the message over silently dropping it.
    addText(value, el);
  }

  // Never pretend a selector mismatch means messages were removed from
  // Snapchat: returning null prevents store.sync([]) from marking archived
  // copies as gone after repeated failed extractions.
  if (!output.length) {
    const explicitEmpty = /^(no messages|start a chat|send a chat to get started|no messages yet)[.!]?$/i
      .test((root.textContent || "").trim());
    return explicitEmpty ? [] : null;
  }
  return output;
}
