export function group(messages = []) {
  const groups = [];
  for (const message of messages) {
    if (!message) continue;
    const isMe = Boolean(message.isMe);
    const from = isMe ? "Me" : (message.from || "Unknown");
    const last = groups.at(-1);
    if (last && last.isMe === isMe && last.from === from) last.messages.push(message);
    else groups.push({ key: String(message.uid || message.id || groups.length), isMe, from, time: "", messages: [message] });
  }
  return groups;
}
