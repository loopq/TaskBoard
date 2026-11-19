#!/usr/bin/env node
// 全局 Claude Code Stop hook：会话里用户贴过任务链接，且自上次提醒后又执行了 git push / deploy.sh，
// 而任务在服务端还没完成时，让 Claude 判断一次任务是否已完成——完成就回填看板，没完成什么都不写。
// 每批新信号只提醒一次；任何异常一律静默放行，绝不卡住会话。
// 天花板：只认 Claude 自己执行的命令和用户消息里的链接；不校验 push 是否真的成功（误判只多一轮判断）；
// 查询任务失败（网络、未登录、查不到）按「不提醒」处理。升级路径见 docs/plans/taskboard-stop-hook-done-reminder.md。
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TB = join(dirname(fileURLToPath(import.meta.url)), 'tb.mjs');
const STATE_DIR = join(homedir(), '.cache', 'taskboard', 'stop-hook');
const LINK = /task\.loopq\.cn\/\?t=(\d+)/g;
const SIGNAL = /\bgit\s+(?:-C\s+\S+\s+)?push\b(?![^\n;&|]*--dry-run)|deploy\.sh/;

const blocksOf = (entry) => {
  const c = entry.message?.content;
  if (typeof c === 'string') return [{ type: 'text', text: c }];
  return Array.isArray(c) ? c : [];
};

// 绑定 = 用户亲自发的消息里出现的任务链接（isMeta 是 skill 正文、系统注入，跳过）；
// 信号 = 绑定之后 Bash 执行的 push / 部署命令，且结果不是报错。
function scan(text) {
  const tasks = new Set();
  const calls = new Set();
  let signals = 0;
  for (const line of text.split('\n')) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.isMeta || entry.isSidechain) continue;
    for (const b of blocksOf(entry)) {
      if (entry.type === 'user' && b.type === 'text') for (const m of b.text.matchAll(LINK)) tasks.add(Number(m[1]));
      if (b.type === 'tool_use' && b.name === 'Bash' && tasks.size && SIGNAL.test(b.input?.command ?? '')) calls.add(b.id);
      if (b.type === 'tool_result' && calls.has(b.tool_use_id) && b.is_error !== true) signals++;
    }
  }
  return { tasks, signals };
}

function isOpen(no) {
  try {
    const out = execFileSync(process.execPath, [TB, 'show', String(no), '--json'], {
      encoding: 'utf8',
      timeout: 8000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return !JSON.parse(out).task?.done_at;
  } catch {
    return false;
  }
}

function readSeen(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8')).signals ?? 0;
  } catch {
    return 0;
  }
}

const reason = (open) => {
  const list = open.map((n) => `#${n}（https://task.loopq.cn/?t=${n}）`).join('、');
  return `[taskboard] 本会话绑定了 ${list}，刚执行过 git push / 部署。逐个判断任务是否已经完成：
- 已完成（需求点都已落地并上线 / 合入；只差用户本人才能做的验收也算完成）→ 按 ~/.agents/skills/taskboard/SKILL.md「完成回填」的格式，用 \`node ~/.agents/skills/taskboard/scripts/tb.mjs\` 先 comment 写总结，再 done，回报链接。
- 还没完成 → 不写看板，直接结束，不用提这条提示。
每次新的 push / 部署之后只提醒一次。`;
};

function main() {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  if (input.stop_hook_active || !/^[\w-]+$/.test(input.session_id ?? '')) return;
  const text = readFileSync(input.transcript_path, 'utf8');
  if (!text.includes('task.loopq.cn/?t=') || !SIGNAL.test(text)) return;

  const { tasks, signals } = scan(text);
  const stateFile = join(STATE_DIR, `${input.session_id}.json`);
  if (signals <= readSeen(stateFile)) return;

  const open = [...tasks].filter(isOpen);
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(stateFile, JSON.stringify({ signals }));
  if (open.length) process.stdout.write(JSON.stringify({ decision: 'block', reason: reason(open) }));
}

try {
  main();
} catch {
  // 静默放行
}
