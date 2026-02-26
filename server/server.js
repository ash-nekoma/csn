
import express from "express";
import http from "http";
import cookieParser from "cookie-parser";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { Server as SocketIOServer } from "socket.io";
import pg from "pg";

const { Pool } = pg;

const PORT = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET || "dev-change-me";
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.warn("WARNING: DATABASE_URL not set. The server will not start without Postgres.");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined,
});

const app = express();
app.use(express.json());
app.use(cookieParser());

// Serve the single-page frontend
app.use(express.static(new URL("../public", import.meta.url).pathname, { extensions: ["html"] }));

function signToken(user) {
  return jwt.sign({ sub: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: "7d" });
}

function getTokenFromReq(req) {
  // Prefer httpOnly cookie, but allow Authorization header for dev/testing
  const cookieTok = req.cookies?.token;
  if (cookieTok) return cookieTok;

  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) return auth.slice("Bearer ".length).trim();

  return null;
}

function requireAuth(req, res, next) {
  const tok = getTokenFromReq(req);
  if (!tok) return res.status(401).json({ error: "Unauthorized" });

  try {
    req.user = jwt.verify(tok, JWT_SECRET);
    return next();
  } catch {
    return res.status(401).json({ error: "Unauthorized" });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "Forbidden" });
  return next();
}

async function ensureSchema() {
  // Lightweight schema bootstrap (idempotent)
  const sql = `
  CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'player',
    credits BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS bets (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    table_id TEXT NOT NULL,
    round_id TEXT NOT NULL,
    choice TEXT NOT NULL,
    amount BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS rounds (
    id TEXT PRIMARY KEY,
    table_id TEXT NOT NULL,
    status TEXT NOT NULL,
    winner TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at TIMESTAMPTZ
  );
  `;
  await pool.query(sql);
}

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1;");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: "db" });
  }
});

app.post("/api/register", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "Missing username/password" });

  const uname = String(username).trim().toLowerCase();
  if (uname.length < 3) return res.status(400).json({ error: "Username too short" });
  if (String(password).length < 4) return res.status(400).json({ error: "Password too short" });

  const hash = await bcrypt.hash(String(password), 10);

  try {
    const r = await pool.query(
      "INSERT INTO users (username, password_hash, credits, role) VALUES ($1,$2,$3,$4) RETURNING id, username, role, credits",
      [uname, hash, 0, "player"]
    );
    const user = r.rows[0];
    const tok = signToken(user);

    res.cookie("token", tok, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.json({ username: user.username, role: user.role, credits: Number(user.credits) });
  } catch (e) {
    if (String(e?.message || "").includes("unique")) {
      return res.status(409).json({ error: "Username already taken" });
    }
    return res.status(500).json({ error: "Register failed" });
  }
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "Missing username/password" });

  const uname = String(username).trim().toLowerCase();

  const r = await pool.query("SELECT id, username, password_hash, role, credits FROM users WHERE username=$1", [uname]);
  const user = r.rows[0];
  if (!user) return res.status(404).json({ error: "Account not found" });

  const ok = await bcrypt.compare(String(password), user.password_hash);
  if (!ok) return res.status(401).json({ error: "Incorrect username or password" });

  const tok = signToken(user);

  res.cookie("token", tok, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });

  res.json({ username: user.username, role: user.role, credits: Number(user.credits) });
});

app.post("/api/logout", (req, res) => {
  res.clearCookie("token");
  res.json({ ok: true });
});

app.get("/api/me", requireAuth, async (req, res) => {
  const userId = req.user.sub;
  const r = await pool.query("SELECT username, role, credits FROM users WHERE id=$1", [userId]);
  const u = r.rows[0];
  if (!u) return res.status(401).json({ error: "Unauthorized" });
  res.json({ username: u.username, role: u.role, credits: Number(u.credits) });
});

// --- Admin (single-page UI will call these) ---
app.get("/api/admin/users", requireAuth, requireAdmin, async (req, res) => {
  const r = await pool.query("SELECT id, username, role, credits, created_at FROM users ORDER BY id DESC LIMIT 200");
  res.json({ users: r.rows.map(x => ({ ...x, credits: Number(x.credits) })) });
});

app.patch("/api/admin/users/:id", requireAuth, requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { credits, role } = req.body || {};

  const updates = [];
  const vals = [];
  let idx = 1;

  if (credits !== undefined) {
    updates.push(`credits = $${idx++}`);
    vals.push(Number(credits));
  }
  if (role !== undefined) {
    updates.push(`role = $${idx++}`);
    vals.push(String(role));
  }
  if (!updates.length) return res.status(400).json({ error: "No changes" });

  vals.push(id);
  const q = `UPDATE users SET ${updates.join(", ")} WHERE id = $${idx} RETURNING id, username, role, credits`;
  const r = await pool.query(q, vals);
  const u = r.rows[0];
  if (!u) return res.status(404).json({ error: "User not found" });
  res.json({ user: { ...u, credits: Number(u.credits) } });
});

// --- Real-time shared tables (Socket.IO) ---
const httpServer = http.createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: { origin: true, credentials: true },
});

function parseCookie(header) {
  const out = {};
  (header || "").split(";").forEach(part => {
    const [k, ...rest] = part.trim().split("=");
    if (!k) return;
    out[k] = decodeURIComponent(rest.join("=") || "");
  });
  return out;
}

async function authFromSocket(socket) {
  const cookies = parseCookie(socket.request.headers.cookie || "");
  const tok = cookies.token || (socket.handshake.auth && socket.handshake.auth.token);
  if (!tok) return null;
  try {
    return jwt.verify(tok, JWT_SECRET);
  } catch {
    return null;
  }
}

// In-memory round state per table (authoritative; bets and credit updates are persisted)
const TABLES = new Map(); // tableId -> state

function getTable(tableId) {
  if (!TABLES.has(tableId)) {
    TABLES.set(tableId, {
      tableId,
      roundId: `r_${tableId}_${Date.now()}`,
      status: "BETTING",
      endsAt: Date.now() + 15000, // 15s betting
      totals: {}, // choice -> amount
    });
  }
  return TABLES.get(tableId);
}

function broadcastTable(tableId) {
  const t = getTable(tableId);
  io.to(`table:${tableId}`).emit("table:state", {
    tableId: t.tableId,
    roundId: t.roundId,
    status: t.status,
    endsAt: t.endsAt,
    totals: t.totals,
  });
}

async function closeAndResolve(tableId) {
  const t = getTable(tableId);
  if (t.status !== "BETTING") return;

  t.status = "LOCKED";
  broadcastTable(tableId);

  // Resolve after short delay for "animation" time
  setTimeout(async () => {
    // Pick winner among choices that have any bets; if none, pick "none"
    const choices = Object.keys(t.totals).filter(k => (t.totals[k] || 0) > 0);
    const winner = choices.length ? choices[Math.floor(Math.random() * choices.length)] : "none";

    // Persist round result
    try {
      await pool.query(
        "INSERT INTO rounds (id, table_id, status, winner, started_at, ended_at) VALUES ($1,$2,$3,$4, now(), now()) ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, winner=EXCLUDED.winner, ended_at=EXCLUDED.ended_at",
        [t.roundId, tableId, "DONE", winner]
      );
    } catch {}

    // Pay winners: amount*2 (no edge). For simplicity, do per-bet.
    // (In production: batch queries + house edge + anti-abuse)
    try {
      const bets = await pool.query(
        "SELECT id, user_id, amount FROM bets WHERE table_id=$1 AND round_id=$2 AND choice=$3",
        [tableId, t.roundId, winner]
      );
      for (const b of bets.rows) {
        const payout = Number(b.amount) * 2;
        await pool.query("UPDATE users SET credits = credits + $1 WHERE id=$2", [payout, b.user_id]);
      }
    } catch (e) {
      console.error("payout error", e?.message);
    }

    io.to(`table:${tableId}`).emit("round:result", { tableId, roundId: t.roundId, winner });

    // Start next round
    t.roundId = `r_${tableId}_${Date.now()}`;
    t.status = "BETTING";
    t.endsAt = Date.now() + 15000;
    t.totals = {};
    broadcastTable(tableId);
  }, 2000);
}

setInterval(() => {
  const now = Date.now();
  for (const [tableId, t] of TABLES.entries()) {
    if (t.status === "BETTING" && now >= t.endsAt) closeAndResolve(tableId);
  }
}, 250);

io.on("connection", async (socket) => {
  const user = await authFromSocket(socket);
  if (!user) {
    socket.emit("auth:error", { error: "Unauthorized" });
    return socket.disconnect(true);
  }
  socket.data.user = user;

  socket.on("table:join", (payload) => {
    const tableId = String(payload?.tableId || "").trim();
    if (!tableId) return;
    socket.join(`table:${tableId}`);
    // Ensure round exists in DB
    const t = getTable(tableId);
    pool.query(
      "INSERT INTO rounds (id, table_id, status) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING",
      [t.roundId, tableId, "BETTING"]
    ).catch(() => {});
    broadcastTable(tableId);
  });

  socket.on("bet:place", async (payload, ack) => {
    const tableId = String(payload?.tableId || "").trim();
    const choice = String(payload?.choice || "").trim().toLowerCase();
    const amount = Number(payload?.amount);

    const t = getTable(tableId);

    if (!tableId || !choice || !Number.isFinite(amount) || amount <= 0) {
      ack?.({ ok: false, error: "Invalid bet." });
      return;
    }
    if (t.status !== "BETTING") {
      ack?.({ ok: false, error: "Bets are closed! Wait for next round." });
      return;
    }

    const userId = socket.data.user.sub;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const bal = await client.query("SELECT credits FROM users WHERE id=$1 FOR UPDATE", [userId]);
      const credits = Number(bal.rows[0]?.credits ?? 0);
      if (amount > credits) {
        await client.query("ROLLBACK");
        ack?.({ ok: false, error: "Insufficient TC." });
        return;
      }

      await client.query("UPDATE users SET credits = credits - $1 WHERE id=$2", [amount, userId]);
      await client.query(
        "INSERT INTO bets (user_id, table_id, round_id, choice, amount) VALUES ($1,$2,$3,$4,$5)",
        [userId, tableId, t.roundId, choice, amount]
      );
      await client.query("COMMIT");

      // Update in-memory totals and broadcast
      t.totals[choice] = Number(t.totals[choice] || 0) + amount;
      broadcastTable(tableId);

      const me = await pool.query("SELECT credits FROM users WHERE id=$1", [userId]);
      ack?.({ ok: true, credits: Number(me.rows[0]?.credits ?? 0) });
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch {}
      console.error("bet error", e?.message);
      ack?.({ ok: false, error: "Server error." });
    } finally {
      client.release();
    }
  });
});

await ensureSchema();

httpServer.listen(PORT, () => {
  console.log(`Server listening on ${PORT}`);
});
