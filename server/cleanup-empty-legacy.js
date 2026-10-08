import fs from "node:fs";
import path from "node:path";

// Startup cleanup is deliberately strict. It only deletes placeholders that
// have never held a username, encrypted password, chat, event, media, tombstone
// or Chromium profile. Anything potentially real survives for admin review.
export function purgeProvenEmptyLegacy(db, dataDir) {
  const candidates = db.prepare(`SELECT a.id FROM accounts a
    WHERE a.owner_user_id IS NULL
      AND a.username IS NULL
      AND a.secret IS NULL
      AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.account_id=a.id)
      AND NOT EXISTS (SELECT 1 FROM media m WHERE m.account_id=a.id)
      AND NOT EXISTS (SELECT 1 FROM events e WHERE e.account_id=a.id)
      AND NOT EXISTS (SELECT 1 FROM tombstones t WHERE t.account_id=a.id)`).all();
  const remove = db.prepare("DELETE FROM accounts WHERE id=? AND owner_user_id IS NULL");
  let cleared = 0;
  for (const { id } of candidates) {
    // Don't touch a profile even if it looks empty; the browser may have
    // persisted an authorization cookie, token or other session marker.
    if (fs.existsSync(path.join(dataDir, "profiles", id))) continue;
    if (remove.run(id).changes === 1) cleared++;
  }
  return cleared;
}
