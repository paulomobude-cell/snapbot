export function group(messages = [], currentChatName = null) {
  const groups = [];
  for (const message of messages) {
    if (!message) continue;
    const isMe = Boolean(message.isMe);
    const isStatus = ["status", "notice"].includes(message.kind);
    // Archived sender labels can outlive a Snapchat contact rename. For normal
    // one-to-one chat bubbles, display the latest conversation name without
    // rewriting historical messages or changing system/status event provenance.
    const from = isMe ? "Me" : (!isStatus && currentChatName ? currentChatName : (message.from || "Unknown"));
    const last = groups.at(-1);
    if (last && !isStatus && !last.isStatus && last.isMe === isMe && last.from === from) last.messages.push(message);
    else groups.push({ key: String(message.uid || message.id || groups.length), isMe: isStatus ? false : isMe, isStatus, from, time: "", messages: [message] });
  }
  return groups;
}
