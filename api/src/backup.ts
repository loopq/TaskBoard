import { existsSync } from 'node:fs';
import { backup, DatabaseSync } from 'node:sqlite';

/**
 * 用法：node backup.ts <源库> <不存在的新文件>
 * SQLite 在线一致性备份（服务运行、WAL 有写入时也安全），完成后做完整性和外键校验，失败非零退出。
 */
const [source, dest] = process.argv.slice(2);
if (!source || !dest || existsSync(dest)) throw new Error('用法：node backup.ts <源库> <不存在的新文件>');
process.umask(0o077);

const db = new DatabaseSync(source);
try {
  await backup(db, dest);
} finally {
  db.close();
}

const copy = new DatabaseSync(dest, { readOnly: true });
try {
  const { integrity_check } = copy.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
  if (integrity_check !== 'ok' || copy.prepare('PRAGMA foreign_key_check').all().length) {
    throw new Error('备份完整性校验失败');
  }
  const counts = copy.prepare('SELECT (SELECT COUNT(*) FROM columns) AS columns, (SELECT COUNT(*) FROM tasks) AS tasks').get();
  console.log('backup verified', JSON.stringify(counts));
} finally {
  copy.close();
}
