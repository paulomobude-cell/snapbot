// Snapchat's conversation list is virtualized: only mounted rows can be
// queried, even when many more conversations exist above or below the view.
// Scan in bounded steps, deduplicate by stable Snapchat chat ID, and restore
// the user's original list position if the page is still available.
export async function discoverChats({
  readVisible, getPosition, scrollTo, pause = () => Promise.resolve(),
  fullScan = false, maxSteps = 160,
}) {
  const seen = new Map();
  const collect = async () => {
    for (const row of (await readVisible()) || []) {
      if (!row || typeof row.id !== "string" || !row.id || !row.name) continue;
      const prior = seen.get(row.id);
      seen.set(row.id, prior ? { ...prior, ...row } : row);
    }
  };
  if (!fullScan) {
    await collect();
    return [...seen.values()];
  }
  const initial = await getPosition();
  if (!initial || initial.clientHeight < 1) {
    await collect();
    return [...seen.values()];
  }
  try {
    await scrollTo(0);
    await pause(120);
    let lastTop = -Infinity;
    for (let step = 0; step < maxSteps; step++) {
      await collect();
      const position = await getPosition();
      if (!position || position.scrollHeight <= position.clientHeight + 2) break;
      const { scrollTop, scrollHeight, clientHeight } = position;
      const maxTop = Math.max(0, scrollHeight - clientHeight);
      if (scrollTop >= maxTop - 2 || scrollTop <= lastTop + 1) break;
      const next = Math.min(maxTop, scrollTop + Math.max(120, Math.floor(clientHeight * .72)));
      if (next <= scrollTop + 1) break;
      lastTop = scrollTop;
      await scrollTo(next);
      await pause(110);
    }
  } finally {
    await scrollTo(initial.scrollTop).catch(() => {});
  }
  return [...seen.values()];
}
