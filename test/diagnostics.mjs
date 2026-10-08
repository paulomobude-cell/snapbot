import assert from "node:assert/strict";
import { diagnostic, classifyDiagnosticError } from "../server/diagnostics.js";
const collected=[];
const previous=console.info;
console.info=(...args)=>collected.push(args.join(" "));
try {
  diagnostic("chat_sync", { accountId:"private-account-id", chatId:"private-friend-id",
    text:2,image:1,video:1,stored:1,failed:1,mode:"interactive",
    body:"Secret private message", src:"blob:private", password:"secret", error:"private" });
  assert.equal(collected.length,1);
  assert.ok(collected[0].startsWith("[snapbot] {"));
  const line=JSON.parse(collected[0].slice("[snapbot] ".length));
  assert.equal(line.event,"chat_sync");
  assert.equal(line.mode,"interactive");
  assert.equal(line.image,1);
  assert.equal(line.video,1);
  assert.match(line.account,/^[0-9a-f]{12}$/);
  assert.match(line.chat,/^[0-9a-f]{12}$/);
  assert.ok(!collected[0].includes("private"));
  assert.ok(!collected[0].includes("secret"));
  assert.equal(classifyDiagnosticError(new Error("R2 upload failed: 404 NoSuchBucket and secret-token")), "r2_no_such_bucket");
  assert.equal(classifyDiagnosticError(new Error("R2 upload failed: 403 Access Denied")), "r2_http_403");
  assert.equal(classifyDiagnosticError(new Error("render timed out")), "timeout");
  console.log("Structured diagnostics tests passed: safe fields, anonymous references and classified errors.");
} finally {
  console.info=previous;
}
