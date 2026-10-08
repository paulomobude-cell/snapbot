// Normalize the public Railway origin before making requests. Vite env vars are
// strings and a bare domain would otherwise be resolved against Netlify itself.
// Reject relative URLs, path/query fragments and insecure production HTTP.
export function normalizeBackendUrl(configured, development = false) {
  const raw = typeof configured === "string" ? configured.trim() : "";
  if (!raw) return development ? "http://localhost:3001" : "";
  if (/[\s\\]/.test(raw)) return "";
  let address = raw;
  if (raw.startsWith("//")) {
    address = "https:" + raw;
  } else if (!/^[a-z][a-z\d+.-]*:\/\//i.test(raw)) {
    if (!/^[a-z\d.-]+(?::\d{1,5})?\/?$/i.test(raw)) return "";
    const local = /^(?:localhost|127\.0\.0\.1)(?::\d{1,5})?\/?$/i.test(raw);
    address = (development && local ? "http://" : "https://") + raw;
  }
  try {
    const u = new URL(address);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
    if (u.protocol !== "https:" && !(development && local && u.protocol === "http:")) return "";
    if (!u.hostname || (!u.hostname.includes(".") && !local) ||
      u.username || u.password || u.search || u.hash || u.pathname !== "/") return "";
    return u.origin;
  } catch {
    return "";
  }
}
