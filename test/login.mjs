import assert from "node:assert/strict";
import SnapBot from "../snapbot.js";
import Session from "../server/session.js";

const USER = 'input[name="accountIdentifier"], #ai_input';
const PASS = '#password, input[type="password"]';
const SUBMIT = 'button[type="submit"]';
let passed = 0;

function pageWith({ twoStep = false, challenge = false, passwordAppears = true } = {}) {
  const actions = [];
  let showPassword = !twoStep;
  const username = {
    click: async () => actions.push("focus user"),
    type: async (value) => actions.push("user:" + value),
  };
  const password = {
    type: async (value) => actions.push("password:" + value),
  };
  const submit = {
    click: async () => {
      actions.push("submit");
      if (twoStep && passwordAppears) showPassword = true;
    },
  };
  const page = {
    isClosed: () => false,
    $: async selector => {
      if (challenge) return null;
      if (selector === USER) return username;
      if (selector === PASS) return showPassword ? password : null;
      if (selector === SUBMIT) return submit;
      return null;
    },
    waitForSelector: async selector => {
      if (selector === USER && !challenge) return username;
      if (selector === PASS && showPassword) return password;
      throw new Error("Selector unavailable");
    },
    keyboard: { press: async key => actions.push("key:" + key) },
  };
  return { page, actions };
}

async function check(name, fn) {
  await fn();
  passed++;
  console.log("✓", name);
}

await check("single-step login submits once", async () => {
  const bot = new SnapBot();
  const { page, actions } = pageWith();
  bot.page = page;
  await bot.login({ username: "test-user", password: "test-password" });
  assert.deepEqual(actions, ["focus user", "user:test-user", "password:test-password", "submit"]);
});

await check("two-step login waits for password and submits each step once", async () => {
  const bot = new SnapBot();
  const { page, actions } = pageWith({ twoStep: true });
  bot.page = page;
  await bot.login({ username: "test-user", password: "test-password" });
  assert.deepEqual(actions, ["focus user", "user:test-user", "submit", "password:test-password", "submit"]);
});

await check("missing password exposes verification state without a second submit", async () => {
  const bot = new SnapBot();
  const { page, actions } = pageWith({ twoStep: true, passwordAppears: false });
  bot.page = page;
  await assert.rejects(() => bot.login({ username: "user", password: "secret" }), /live screen/i);
  assert.equal(actions.filter(x => x === "submit").length, 1);
});

await check("challenge page never submits empty login", async () => {
  const bot = new SnapBot();
  const { page, actions } = pageWith({ challenge: true });
  bot.page = page;
  await assert.rejects(() => bot.login({ username: "user", password: "secret" }), /login form is unavailable/i);
  assert.deepEqual(actions, []);
});

await check("session transitions to needs_login with an actionable error", async () => {
  const session = new Session({ store: {}, media: {}, config: {}, profileDir: "/tmp/unneeded" });
  let logins = 0;
  session.bot = {
    page: { $: async () => ({}) },
    login: async () => {
      logins++;
      throw new Error("verification required");
    },
  };
  const first = session.login("user", "secret");
  const second = session.login("user", "secret");
  await Promise.all([first, second]);
  assert.equal(logins, 1, "concurrent requests must not overlap");
  assert.equal(session.status, "needs_login");
  assert.match(session.error, /verification required/);
  session.stopLoop();
});

console.log("\n" + passed + " login regression checks passed.");
