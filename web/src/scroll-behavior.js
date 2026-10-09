// Background snapshots may prepend history, reorder saved messages and sign
// fresh media URLs. Follow the end only for an actual append when the viewer
// was already at the end; never force the end while reading old history.
export function shouldFollowTail(beforeIds, afterIds, wasAtBottom) {
  if (!wasAtBottom || !beforeIds?.length || afterIds.length <= beforeIds.length) return false;
  return beforeIds.every((uid, i) => uid === afterIds[i]);
}

export function chooseScrollTop({ previous, currentAnchorOffset, newScrollHeight,
  afterIds, beforeIds, forceLatest = false } = {}) {
  if (forceLatest || !beforeIds?.length) return newScrollHeight;
  if (shouldFollowTail(beforeIds, afterIds, previous?.atBottom)) return newScrollHeight;
  if (previous && Number.isFinite(currentAnchorOffset) && Number.isFinite(previous.anchorOffset))
    return Math.max(0, previous.scrollTop + currentAnchorOffset - previous.anchorOffset);
  return Math.max(0, previous?.scrollTop || 0);
}
