// Socket snapshots repeatedly sign the same media key. A changed signed URL
// makes <video> fetch again and can reset playback. Retain the previous URL
// until shortly before expiration; never reuse when media identity changes.
function signedExpiry(url) {
  if (!url) return 0;
  try {
    const query = new URL(url).searchParams;
    const local = Number(query.get("exp"));
    if (Number.isFinite(local) && local > 0) return local * 1000;
    const duration = Number(query.get("X-Amz-Expires"));
    const stamp = query.get("X-Amz-Date");
    if (!stamp || !Number.isFinite(duration) || duration <= 0 || !/^\d{8}T\d{6}Z$/.test(stamp)) return 0;
    const start = Date.UTC(+stamp.slice(0, 4), +stamp.slice(4, 6) - 1, +stamp.slice(6, 8),
      +stamp.slice(9, 11), +stamp.slice(11, 13), +stamp.slice(13, 15));
    return start + duration * 1000;
  } catch { return 0; }
}

export function signedUrlStillFresh(url, now = Date.now()) {
  return signedExpiry(url) > now + 2 * 60 * 1000;
}

function stableMessage(old, incoming, now) {
  if (!old || old.uid !== incoming.uid) return incoming;
  const currentMedia = new Map((old.media || []).map(m => [m.id, m]));
  let media = incoming.media;
  if (Array.isArray(media)) {
    media = media.map(next => {
      const previous = currentMedia.get(next.id);
      if (!previous || next.status !== "stored" || previous.status !== "stored" ||
          previous.kind !== next.kind || previous.size !== next.size ||
          previous.contentType !== next.contentType ||
          !signedUrlStillFresh(previous.url, now)) return next;
      const stable = { ...next, url: previous.url };
      return JSON.stringify(stable) === JSON.stringify(previous) ? previous : stable;
    });
  }
  const next = { ...incoming, media };
  // Preserve object identity when only regenerated URLs changed, reducing
  // re-rendering of visible videos while background snapshots arrive.
  return JSON.stringify(old) === JSON.stringify(next) ? old : next;
}

export function reconcileSnapshot(previous = [], incoming = [], now = Date.now()) {
  const known = new Map(previous.map(message => [message.uid, message]));
  const next = [...incoming].sort((a, b) => a.ord - b.ord)
    .map(message => stableMessage(known.get(message.uid), message, now));
  if (next.length === previous.length && next.every((m, i) => m === previous[i]))
    return previous;
  return next;
}

export function reconcileUpdate(previous, updated, now = Date.now()) {
  return stableMessage(previous, updated, now);
}
