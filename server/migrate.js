import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { pool } from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function migrateIfNeeded() {
  if (process.env.AUTO_MIGRATE !== "true") return;

  // Try a quick check: do we have a users table?
  const client = await pool.connect();
  try {
    const check = await client.query(`
      SELECT to_regclass('public.users') as exists;
    `);

    if (check.rows?.[0]?.exists) return; // tables already exist

    const schemaPath = path.join(__dirname, "schema.sql");
    const sql = fs.readFileSync(schemaPath, "utf8");

    // naive split; works for simple schema files
    const statements = sql
      .split(";")
      .map(s => s.trim())
      .filter(Boolean);

    for (const stmt of statements) {
      await client.query(stmt);
    }

    console.log("✅ DB migrated (schema.sql applied).");
  } finally {
    client.release();
  }
}
