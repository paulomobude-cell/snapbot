// Bounded, user-initiated scrollback reading. No conversation is opened here.
// read() returns only what Snapchat has rendered; scrollOlder() is supplied
// by the current opened chat. Never click an unopened Snap.
const MiB = 1024 * 1024;

function signature(item) {
  if (item.kind === "media")
    return JSON.stringify([item.kind, item.from, item.sha256 || item.src || "", item.text || ""]);
  if (item.kind === "snap") return JSON.stringify([item.kind, item.from, item.text || "", item.time || ""]);
  return JSON.stringify([item.kind, item.from, item.text || "", item.time || ""]);
}

function containsSequence(haystack, needle) {
  if (!needle.length || needle.length > haystack.length) return false;
  outer: for (let offset = 0; offset <= haystack.length - needle.length; offset++) {
    for (let i = 0; i < needle.length; i++)
      if (haystack[offset + i] !== needle[i]) continue outer;
    return true;
  }
  return false;
}

// Snapshots arrive newest viewport first, then progressively older ones.
// Only collapse a contiguous overlap: repeated "saved video" notices may
// legitimately be different events and must not be globally deduplicated.
export function mergeHistorySnapshots(snapshots) {
  if (!snapshots.length) return [];
  let merged = [...snapshots[0]];
  for (const older of snapshots.slice(1)) {
    const oldKeys = older.map(signature);
    const currentKeys = merged.map(signature);
    if (containsSequence(currentKeys, oldKeys)) continue;
    if (containsSequence(oldKeys, currentKeys)) { merged = [...older]; continue; }
    let overlap = 0;
    const max = Math.min(oldKeys.length, currentKeys.length);
    for (let n = max; n > 0; n--) {
      if (oldKeys.slice(-n).every((key, index) => key === currentKeys[index])) {
        overlap = n;
        break;
      }
    }
    merged = [...older.slice(0, older.length - overlap), ...merged];
  }
  return merged;
}

export async function collectHistory({
  firstItems, read, scrollOlder, restore, pause = async () => {},
  capture = async () => new Map(), maxSteps = 20, maxItems = 650,
  maxBufferedBytes = 96 * MiB,
}) {
  if (firstItems === null) return { items: null, buffers: new Map(), pages: 0, reachedTop: false, truncated: false };
  const snapshots = [];
  const buffers = new Map();
  let size = 0, reachedTop = false, truncated = false, stoppedBy = "none";
  let page = firstItems;
  let atTopAfterReading = false;
  let identical = 0;
  try {
    for (let step = 0; step < maxSteps; step++) {
      if (page === null) { truncated = true; stoppedBy = "render"; break; }
      const previous = snapshots.at(-1);
      const same = previous && JSON.stringify(previous.map(signature)) === JSON.stringify(page.map(signature));
      if (!same) { snapshots.push(page); identical = 0; }
      else identical++;
      const batch = await capture(page);
      for (const [sha, media] of batch) {
        if (buffers.has(sha)) continue;
        buffers.set(sha, media);
        size += media.buffer?.length || 0;
      }
      const items = mergeHistorySnapshots(snapshots);
      if (items.length >= maxItems) { truncated = true; stoppedBy = "item_limit"; break; }
      if (size >= maxBufferedBytes) { truncated = true; stoppedBy = "media_limit"; break; }
      if (atTopAfterReading) { reachedTop = true; stoppedBy = "top"; break; }
      if (identical >= 3) { truncated = true; stoppedBy = "no_progress"; break; }
      if (step === maxSteps - 1) { truncated = true; stoppedBy = "step_limit"; break; }
      const moved = await scrollOlder();
      if (!moved?.moved) {
        reachedTop = Boolean(moved?.atTop);
        truncated = !reachedTop;
        stoppedBy = reachedTop ? "top" : "unavailable_scroll";
        break;
      }
      atTopAfterReading = Boolean(moved.atTop);
      await pause(420);
      page = await read();
      if (page === null) {
        // Snapchat can briefly unmount the chat while scrolling.
        await pause(420);
        page = await read();
      }
    }
  } finally {
    await restore().catch(() => {});
  }
  return {
    items: mergeHistorySnapshots(snapshots), buffers,
    pages: snapshots.length, reachedTop, truncated, stoppedBy,
  };
}
