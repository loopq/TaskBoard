-- 幂等：可重复执行。D1 默认开启外键约束，子表依赖 ON DELETE CASCADE。
CREATE TABLE IF NOT EXISTS columns (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('todo','normal','done')),
  sort REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL,
  column_id TEXT NOT NULL REFERENCES columns(id),
  title TEXT NOT NULL, desc_md TEXT NOT NULL DEFAULT '',
  sort REAL NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,      -- 0 无 / 1 较低 / 2 普通 / 3 紧急 / 4 非常紧急
  due_at INTEGER,                           -- unix ms
  done_at INTEGER, prev_column_id TEXT,     -- 完成时记录来源列（不加外键：来源列可以被删）
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  no INTEGER                                -- 任务编号 #12：全局递增，详情链接 /?t=12 和 skill 用（旧库由 sqlite.ts 迁移补列）
);
CREATE TABLE IF NOT EXISTS subtasks (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0, sort REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('user','system')),
  body_md TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS login_fail (user TEXT PRIMARY KEY, count INTEGER, locked_until INTEGER);
CREATE INDEX IF NOT EXISTS idx_tasks_owner_col ON tasks(owner, column_id, sort);
CREATE INDEX IF NOT EXISTS idx_comments_task ON comments(task_id, created_at);
-- 设计文档外补充：看板统计子任务进度、级联删除都按 task_id 查 subtasks
CREATE INDEX IF NOT EXISTS idx_subtasks_task ON subtasks(task_id, sort);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_no ON tasks(no);
