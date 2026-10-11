// Privacy-safe CDP transport tracker. It records only connection timings/counts,
// never websocket URLs, request headers, frames, credentials or message bodies.
// Snapchat Web may also use streaming HTTP/2; in that case the result is
// "unknown", NOT "disconnected" (absence of websockets proves nothing).
export function isSnapchatSocket(url) {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === "wss:" || parsed.protocol === "ws:") &&
      /(?:^|\.)(?:snapchat\.com|snap\.com)$/i.test(parsed.hostname);
  } catch { return false; }
}

export function createRealtimeTracker(now = () => Date.now()) {
  const pending = new Set();
  const active = new Set();
  let everConnected = false;
  let connectedAt = 0;
  let disconnectedAt = 0;
  let lastFrameAt = 0;
  let incomingFrames = 0;
  let failures = 0;

  return {
    reset() {
      pending.clear();
      active.clear();
      everConnected = false;
      connectedAt = 0;
      disconnectedAt = 0;
      lastFrameAt = 0;
      incomingFrames = 0;
      failures = 0;
    },
    created({ requestId, url } = {}) {
      if (requestId && isSnapchatSocket(url)) pending.add(requestId);
    },
    handshake({ requestId, response } = {}) {
      if (!pending.has(requestId) || response?.status !== 101) return;
      active.add(requestId);
      everConnected = true;
      connectedAt = now();
      disconnectedAt = 0;
    },
    received({ requestId } = {}) {
      if (!active.has(requestId)) return;
      lastFrameAt = now();
      incomingFrames++;
    },
    error({ requestId } = {}) {
      if (pending.has(requestId)) failures++;
    },
    closed({ requestId } = {}) {
      if (!pending.has(requestId)) return;
      const wasConnected = active.delete(requestId);
      pending.delete(requestId);
      if (wasConnected && active.size === 0) disconnectedAt = now();
    },
    snapshot() {
      return {
        state: active.size ? "healthy" : everConnected ? "disconnected" : "unknown",
        activeSockets: active.size,
        failures,
        incomingFrames,
        lastFrameAt,
        connectedAt,
        disconnectedForMs: disconnectedAt && !active.size ? Math.max(0, now() - disconnectedAt) : 0,
      };
    },
  };
}
