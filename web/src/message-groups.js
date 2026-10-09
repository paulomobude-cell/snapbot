export function group(messages = []) {
  const groups = [];
  for (const message of messages) {
    if (!message) continue;
    const isMe = Boolean(message.isMe);
    const from = isMe ? "Me" : (message.from || "Unknown");
    const isStatus = ["status", "notice"].includes(message.kind);
    const last = groups.at(-1);
    if (last && !isStatus && !last.isStatus && last.isMe === isMe && last.from === from) last.messages.push(message);
    else groups.push({ key: String(message.uid || message.id || groups.length), isMe: isStatus ? false : isMe, isStatus, from, time: "", messages: [message] });
  }
  return groups;
}


// One stable keyed container per archived message. A grouped wrapper keyed by
// the *first* message remounts every video when older scrollback is prepended.
// This metadata preserves the same visual grouping without unstable wrappers.
export function stableMessageRows(messages = []) {
  let previous = null;
  return messages.filter(Boolean).map(message => {
    const isMe = Boolean(message.isMe);
    const from = isMe ? "Me" : message.from || "Unknown";
    const isStatus = ["status", "notice"].includes(message.kind);
    const startsGroup = !previous || isStatus || previous.isStatus ||
      previous.isMe !== isMe || previous.from !== from;
    const row = {
      key: String(message.uid || message.id),
      message, isMe: isStatus ? false : isMe, isStatus, from, startsGroup,
    };
    previous = row;
    return row;
  });
}
