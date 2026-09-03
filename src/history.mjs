import { existsSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

export async function migrateHistory({ dbPath, targetProvider = "momoapi-proxy", backup = true } = {}) {
  if (!dbPath || !existsSync(dbPath)) {
    return { migrated: 0, dbFound: false };
  }

  if (backup) {
    const backupPath = dbPath + ".momo-history.bak";
    if (!existsSync(backupPath)) {
      try { copyFileSync(dbPath, backupPath); } catch {}
    }
  }

  let updatedCount = 0;

  // 1. Try built-in node:sqlite
  try {
    const { DatabaseSync } = await import("node:sqlite");
    if (DatabaseSync) {
      const db = new DatabaseSync(dbPath);
      const stmt = db.prepare(
        "UPDATE threads SET model_provider = ? WHERE model_provider != ?"
      );
      const res = stmt.run(targetProvider, targetProvider);
      updatedCount = Number(res.changes || 0);
      db.close();
      return { migrated: updatedCount, dbFound: true, method: "node:sqlite" };
    }
  } catch (err) {
    // console.warn("node:sqlite failed:", err.message);
  }

  // 2. Fallback to python sqlite3
  try {
    const pyCode = "import sqlite3, sys\ndb, target = sys.argv[1:3]\ncon = sqlite3.connect(db, timeout=30)\ncur = con.cursor()\ncur.execute('UPDATE threads SET model_provider = ? WHERE model_provider != ?', (target, target))\ncon.commit()\nprint(cur.rowcount)\ncon.close()\n";
    const res = execFileSync("python", ["-c", pyCode, dbPath, targetProvider], { encoding: "utf8" });
    updatedCount = Number(res.trim() || 0);
    return { migrated: updatedCount, dbFound: true, method: "python" };
  } catch (err) {
    // console.warn("python sqlite3 failed:", err.message);
  }

  // 3. Fallback to sqlite3 CLI
  try {
    const sql = `UPDATE threads SET model_provider = '${targetProvider}' WHERE model_provider != '${targetProvider}';`;
    execFileSync("sqlite3", [dbPath, sql], { encoding: "utf8" });
    return { migrated: -1, dbFound: true, method: "sqlite3_cli" };
  } catch {}

  return { migrated: 0, dbFound: true, error: "No sqlite runner available" };
}

