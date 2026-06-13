import Database from 'better-sqlite3';

export function openDb(path = process.env.HELM_DB || 'helm.db'): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS lists (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, goal TEXT DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'general', color TEXT, repoUrl TEXT,
  createdAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sublists (
  id TEXT PRIMARY KEY, listId TEXT NOT NULL, name TEXT NOT NULL,
  createdAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sprints (
  id TEXT PRIMARY KEY, number INTEGER NOT NULL, name TEXT,
  startDate TEXT NOT NULL, endDate TEXT NOT NULL, status TEXT NOT NULL,
  capacityDays INTEGER NOT NULL DEFAULT 10, leaveDays TEXT NOT NULL DEFAULT '[]',
  goal TEXT, createdAt INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, listId TEXT NOT NULL, sublistId TEXT, title TEXT NOT NULL,
  importance INTEGER NOT NULL, timeSensitivity INTEGER NOT NULL,
  complexity TEXT NOT NULL, estHours REAL NOT NULL, due TEXT,
  slotType TEXT NOT NULL, slots INTEGER NOT NULL, slotsDone INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL, blocker TEXT, sprintId TEXT,
  dependsOn TEXT NOT NULL DEFAULT '[]', rationale TEXT,
  createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, completedAt INTEGER
);
`;
