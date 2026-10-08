import assert from "node:assert/strict";
import { resolveChatClick } from "../src/chat-click-mode.js";
assert.deepEqual(resolveChatClick("ask", true), { open:true, remember:"open" });
assert.deepEqual(resolveChatClick("ask", false), { open:false, remember:"passive" });
assert.deepEqual(resolveChatClick("open", false), { open:true, remember:"open" });
assert.deepEqual(resolveChatClick("passive", true), { open:false, remember:"passive" });
console.log("Chat-click mode passed: one-time consent, remembered open mode and protected passive mode.");
