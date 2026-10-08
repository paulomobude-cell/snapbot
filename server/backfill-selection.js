// Never use Snapchat Web's "Opened"/"Delivered" label to infer read state.
// A user must deliberately choose each conversation and acknowledge the risk.
export const MAX_BACKFILL_CHATS = 30;
export function validateBackfillSelection(selected, chats) {
  if (!Array.isArray(selected) || !selected.length || selected.length > MAX_BACKFILL_CHATS)
    throw new Error("Select between 1 and 30 conversations to archive.");
  const known = new Set((chats || []).map(chat => chat.id));
  const ids = [];
  for (const id of selected) {
    if (typeof id !== "string" || !known.has(id)) throw new Error("Unknown conversation selected.");
    if (ids.includes(id)) throw new Error("Select each conversation only once.");
    ids.push(id);
  }
  return ids;
}
