import assert from "node:assert/strict";
import { normalizeBackendUrl } from "../src/backend-url.js";

const examples = [["snapbot.up.railway.app",false,"https://snapbot.up.railway.app"],[" snapbot.up.railway.app/ ",false,"https://snapbot.up.railway.app"],["https://snapbot.up.railway.app",false,"https://snapbot.up.railway.app"],["https://snapbot.up.railway.app/",false,"https://snapbot.up.railway.app"],["//snapbot.up.railway.app",false,"https://snapbot.up.railway.app"],["http://snapbot.up.railway.app",false,""],["snapbot.up.railway.app/api",false,""],["https://snapbot.up.railway.app/api",false,""],["/snapbot.up.railway.app",false,""],["https://attacker.example@railway.app",false,""],["",false,""],["",true,"http://localhost:3001"],["localhost:3001",true,"http://localhost:3001"],["http://localhost:3001",true,"http://localhost:3001"]];
for (const [input, dev, expected] of examples) {
  assert.equal(normalizeBackendUrl(input, dev), expected, "URL: " + JSON.stringify(input));
}
const expectedEndpoint = "https://snapbot.up.railway.app/api/auth/signup";
assert.equal(normalizeBackendUrl("snapbot.up.railway.app") + "/api/auth/signup", expectedEndpoint);
assert.notEqual(new URL(expectedEndpoint).origin, "https://snapbotcomnexus.netlify.app");
console.log("Backend URL smoke checks passed: scheme normalization, safe origins, path rejection and absolute signup endpoint.");
