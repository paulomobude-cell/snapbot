// A user gesture, not a socket reconnect, decides whether to open a
// conversation in Snapchat. Read state can change even if Web says "Opened".
export function resolveChatClick(mode, allowOpening) {
  if (mode === "open") return { open: true, remember: "open" };
  if (mode === "passive") return { open: false, remember: "passive" };
  return allowOpening === true
    ? { open: true, remember: "open" }
    : { open: false, remember: "passive" };
}
