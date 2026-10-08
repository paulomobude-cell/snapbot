import crypto from "node:crypto";

// Master service API_TOKEN is never a user credential.
// Users receive independent 256-bit, revocable keys. SQLite holds hashes only.
const normPhone = value => String(value || "").replace(/\D/g, "");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const equal = (a, b) => {
  const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || ""));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const apiKey = () => crypto.randomBytes(32).toString("hex");
const recoveryCode = () => crypto.randomBytes(24).toString("hex").toUpperCase();
const ITERATIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
function passwordHash(password, salt = crypto.randomBytes(16).toString("hex")) {
  return "scrypt:" + salt + ":" + crypto.scryptSync(password, Buffer.from(salt, "hex"), 64, ITERATIONS).toString("hex");
}
function matchPassword(entered, stored) {
  if (typeof stored !== "string" || !stored.startsWith("scrypt:")) return false;
  const [, salt, digest] = stored.split(":");
  if (!/^[0-9a-f]{32}$/.test(salt) || !/^[0-9a-f]{128}$/.test(digest)) return false;
  return equal(passwordHash(entered, salt), stored);
}

export class TenantAuth {
  constructor(db, { adminToken = "", now = () => Date.now() } = {}) {
    this.db = db;
    this.adminToken = adminToken;
    this.now = now;
    this.sql = {
      getPhone: db.prepare("SELECT * FROM app_users WHERE phone=?"),
      getId: db.prepare("SELECT * FROM app_users WHERE id=?"),
      getKey: db.prepare("SELECT * FROM app_users WHERE api_key_hash=?"),
      insert: db.prepare("INSERT INTO app_users (id, phone, password_hash, recovery_hash, api_key_hash, role, created_at) VALUES (?, ?, ?, ?, ?, 'user', ?)"),
      rotate: db.prepare("UPDATE app_users SET api_key_hash=?, password_hash=?, recovery_hash=? WHERE id=? AND recovery_hash=?"),
      delete: db.prepare("DELETE FROM app_users WHERE id=?"),
      users: db.prepare("SELECT id, phone, role, created_at FROM app_users ORDER BY created_at DESC"),
      count: db.prepare("SELECT COUNT(*) n FROM app_users"),
      attempts: db.prepare(`INSERT INTO auth_attempts (scope, count, window_start)
        VALUES (?, 1, ?) ON CONFLICT(scope) DO UPDATE SET
        count=CASE WHEN window_start <= ? THEN 1 ELSE count+1 END,
        window_start=CASE WHEN window_start <= ? THEN excluded.window_start ELSE window_start END
        WHERE window_start <= ? OR count < ?`),
      clearAttempt: db.prepare("DELETE FROM auth_attempts WHERE scope=?"),
    };
  }
  fail(message, status = 400) { const e = new Error(message); e.statusCode = status; throw e; }
  publicUser(row) { return { id: row.id, phone: row.phone, role: row.role, createdAt: row.created_at }; }
  // Rate limits reserve attempts atomically; neither retry races nor guessed
  // numbers can sidestep the per-IP+phone failed-login budget.
  guard(scope, ip, account = "") {
    const now = Math.floor(this.now() / 1000);
    const policies = {
      signup: [20, 3600], login: [20, 900], recovery: [8, 3600],
      key: [30, 900], admin: [15, 900],
    };
    const [max, seconds] = policies[scope] || [20, 900];
    const ipKey = hash(scope + "\0ip\0" + String(ip));
    const userKey = hash(scope + "\0account\0" + String(ip) + "\0" + normPhone(account));
    const reserve = key => this.sql.attempts.run(key, now, now - seconds, now - seconds, now - seconds, max);
    if (!reserve(ipKey).changes || (account && !reserve(userKey).changes))
      this.fail("Too many attempts. Try again later.", 429);
    return { success: () => { if (account) this.sql.clearAttempt.run(userKey); } };
  }
  signup(phone, password) {
    const clean = normPhone(phone);
    if (clean.length < 7 || clean.length > 15 || typeof password !== "string" ||
      password.length < 12 || password.length > 256)
      this.fail("Phone must contain 7–15 digits and password must contain 12–256 characters");
    if (this.sql.getPhone.get(clean)) this.fail("Account already exists", 409);
    const id = crypto.randomUUID(), key = apiKey(), recovery = recoveryCode();
    try {
      this.sql.insert.run(id, clean, passwordHash(password), hash(recovery), hash(key), this.now());
    } catch (error) {
      if (/UNIQUE/i.test(error.message)) this.fail("Account already exists", 409);
      throw error;
    }
    return { user: this.publicUser(this.sql.getId.get(id)), apiKey: key, recoveryCode: recovery };
  }
  login(phone, password) {
    const row = this.sql.getPhone.get(normPhone(phone));
    if (!row || typeof password !== "string" || password.length > 256 ||
      !matchPassword(password, row.password_hash)) this.fail("Invalid phone or password", 401);
    // Existing key is never stored in plaintext; rotate at login and invalidate
    // old browser sessions, keeping the stable tenant id unchanged.
    const key = apiKey();
    this.db.prepare("UPDATE app_users SET api_key_hash=? WHERE id=?").run(hash(key), row.id);
    return { user: this.publicUser(row), apiKey: key };
  }
  recover(phone, code, newPassword) {
    const row = this.sql.getPhone.get(normPhone(phone));
    if (!row || typeof code !== "string" || !/^[0-9a-f]{48}$/i.test(code) ||
      !equal(hash(code.trim().toUpperCase()), row.recovery_hash))
      this.fail("Invalid phone or recovery code", 401);
    if (typeof newPassword !== "string" || newPassword.length < 12 || newPassword.length > 256)
      this.fail("New password must contain 12–256 characters");
    const key = apiKey(), recovery = recoveryCode();
    const result = this.sql.rotate.run(hash(key), passwordHash(newPassword), hash(recovery), row.id, row.recovery_hash);
    if (!result.changes) this.fail("Recovery code already used", 409);
    return { user: this.publicUser(row), apiKey: key, recoveryCode: recovery };
  }
  resolve(key) {
    if (typeof key !== "string" || !/^[a-f0-9]{64}$/i.test(key)) return null;
    const row = this.sql.getKey.get(hash(key));
    return row ? this.publicUser(row) : null;
  }
  checkAdmin(candidate) {
    return typeof candidate === "string" && this.adminToken.length >= 32 &&
      candidate.length === this.adminToken.length && equal(candidate, this.adminToken);
  }
  users() { return this.sql.users.all(); }
  deleteUser(id) { return this.sql.delete.run(id).changes > 0; }
}
