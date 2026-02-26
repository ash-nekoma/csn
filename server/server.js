import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import cookieParser from "cookie-parser";
import { pool } from "./db.js";
import { migrateIfNeeded } from "./migrate.js";

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: true,
    credentials: true
  }
});

const PORT = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET;

// Middleware
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static("public"));

/* =========================
   AUTH HELPERS
========================= */

function authMiddleware(req, res, next) {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: "Not authenticated" });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

function adminMiddleware(req, res, next) {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Admin only" });
  }
  next();
}

/* =========================
   AUTH ROUTES
========================= */

app.post("/api/register", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password)
    return res.status(400).json({ error: "Missing fields" });

  const hashed = await bcrypt.hash(password, 10);

  try {
    await pool.query(
      "INSERT INTO users (username, password, credits, role) VALUES ($1,$2,$3,$4)",
      [username, hashed, 1000, "user"]
    );

    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: "Username already taken" });
  }
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;

  const result = await pool.query(
    "SELECT * FROM users WHERE username=$1",
    [username]
  );

  if (!result.rows.length)
    return res.status(400).json({ error: "Account not found" });

  const user = result.rows[0];
  const valid = await bcrypt.compare(password, user.password);

  if (!valid)
    return res.status(400).json({ error: "Incorrect username or password" });

  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: "7d" }
  );

  res.cookie("token", token, {
    httpOnly: true,
    secure: true,
    sameSite: "none"
  });

  res.json({ success: true });
});

app.get("/api/me", authMiddleware, async (req, res) => {
  const result = await pool.query(
    "SELECT id, username, credits, role FROM users WHERE id=$1",
    [req.user.id]
  );

  res.json(result.rows[0]);
});

app.post("/api/logout", (req, res) => {
  res.clearCookie("token");
  res.json({ success: true });
});

/* =========================
   ADMIN ROUTES
========================= */

app.get("/api/admin/users", authMiddleware, adminMiddleware, async (req, res) => {
  const result = await pool.query(
    "SELECT id, username, credits, role FROM users"
  );
  res.json(result.rows);
});

/* =========================
   SOCKET.IO (Shared Tables)
========================= */

io.use((socket, next) => {
  const token = socket.handshake.headers.cookie
    ?.split("; ")
    .find(c => c.startsWith("token="))
    ?.split("=")[1];

  if (!token) return next(new Error("Unauthorized"));

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.user = decoded;
    next();
  } catch {
    next(new Error("Unauthorized"));
  }
});

io.on("connection", socket => {
  console.log("User connected:", socket.user.username);

  socket.on("bet:place", async ({ choice, amount }) => {
    if (!amount || amount <= 0)
      return socket.emit("bet:rejected", { reason: "Invalid amount" });

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const userRes = await client.query(
        "SELECT credits FROM users WHERE id=$1 FOR UPDATE",
        [socket.user.id]
      );

      const credits = userRes.rows[0].credits;

      if (credits < amount) {
        await client.query("ROLLBACK");
        return socket.emit("bet:rejected", { reason: "Insufficient balance" });
      }

      await client.query(
        "UPDATE users SET credits=credits-$1 WHERE id=$2",
        [amount, socket.user.id]
      );

      await client.query("COMMIT");

      socket.emit("bet:accepted", { newCredits: credits - amount });

      io.emit("table:update", {
        player: socket.user.username,
        choice,
        amount
      });

    } catch (err) {
      await client.query("ROLLBACK");
      socket.emit("bet:rejected", { reason: "Server error" });
    } finally {
      client.release();
    }
  });
});

/* =========================
   START SERVER
========================= */

await migrateIfNeeded();

server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
