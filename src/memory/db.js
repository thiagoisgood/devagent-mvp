/**
 * 跨周期持久化记忆 (Memory DB) — SQLite 存储踩坑经验与黑名单规则
 * 在项目 .devagent 目录下初始化 devagent_memory.db，供 Supervisor 注入与 memorize 动作写入。
 */

import Database from "better-sqlite3";
import { mkdirSync, existsSync } from "node:fs";
import path from "node:path";

const DEVAGENT_DIR = path.resolve(process.cwd(), ".devagent");
const DB_PATH = path.join(DEVAGENT_DIR, "devagent_memory.db");

/** @type {Database.Database | null} */
let db = null;

/**
 * 确保 .devagent 目录存在并打开数据库连接；若表不存在则建表。
 * 模块加载时调用，保证后续 saveMemory / getAllMemories 可同步执行。
 */
function ensureDb() {
  if (db) return db;
  if (!existsSync(DEVAGENT_DIR)) {
    mkdirSync(DEVAGENT_DIR, { recursive: true });
  }
  db = new Database(DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      context TEXT NOT NULL,
      lesson TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

/**
 * 将一条教训写入 SQLite 记忆库，供后续任务在 System Prompt 中注入。
 * @param {string} context - 触发该教训的场景（如「升级 React」）
 * @param {string} lesson - 得出的结论或黑名单规则（如「绝对不能使用过期的某库」）
 */
function saveMemory(context, lesson) {
  const database = ensureDb();
  const stmt = database.prepare(
    "INSERT INTO memories (context, lesson) VALUES (?, ?)",
  );
  stmt.run(String(context || "").trim(), String(lesson || "").trim());
}

/**
 * 读取所有已持久化的记忆，用于 Supervisor 的「思想钢印」注入。
 * @returns {Array<{ id: number, context: string, lesson: string, created_at: string }>}
 */
function getAllMemories() {
  const database = ensureDb();
  const stmt = database.prepare(
    "SELECT id, context, lesson, created_at FROM memories ORDER BY id ASC",
  );
  return stmt.all();
}

export { saveMemory, getAllMemories };
