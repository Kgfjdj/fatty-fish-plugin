import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActivityMemoryStore, type ActivityMemoryLimits } from '../src/activity-memory.ts';

const HOUR = 3600_000;
const DAY = 24 * HOUR;

const limits: ActivityMemoryLimits = {
  mediumHours: 72,
  sessionGapMs: 30 * 60_000, // 30 分钟
  promotionSessions: 3,
  longDays: 30,
  compressedDays: 30,
  maxItems: 300,
};

const tmpDirs: string[] = [];

function makeStore(startMs = 1_000_000_000_000): { store: ActivityMemoryStore; dir: string; now: { t: number } } {
  const dir = mkdtempSync(join(tmpdir(), 'activity-memory-'));
  tmpDirs.push(dir);
  const now = { t: startMs };
  const store = new ActivityMemoryStore(dir, { now: () => now.t });
  return { store, dir, now };
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function book(observationId: string, confidence: 'high' | 'medium' | 'low' = 'high', title = '三体') {
  return {
    observationId,
    kind: 'book' as const,
    title,
    action: 'reading',
    summary: '正在读《三体》第二部，叶文洁与罗辑的线索逐渐交汇。',
    confidence,
  };
}

describe('ActivityMemoryStore.observe（中期记忆）', () => {
  it('首次有效观察形成一条中期活动记录', () => {
    const { store, now } = makeStore();
    const r = store.observe(book('obs-1'), limits, now.t);
    expect(r.outcome).toBe('added');
    expect(r.tier).toBe('medium');
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0].kind).toBe('book');
    expect(list[0].title).toBe('三体');
    expect(list[0].sessionStarts).toHaveLength(1);
    expect(list[0].evidenceCount).toBe(1);
  });

  it('连续截同一本书 20 次：同一活动、同一会话，不因总次数而晋升', () => {
    const { store, now } = makeStore();
    for (let i = 0; i < 20; i++) {
      store.observe(book(`obs-${i}`), limits, now.t); // 间隔 0，远小于 30 分钟会话间隔
    }
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0].sessionStarts).toHaveLength(1);
    expect(list[0].evidenceCount).toBe(20);
    expect(list[0].tier).toBe('medium');
  });

  it('同一 observationId 重复提交幂等，不重复计数', () => {
    const { store, now } = makeStore();
    store.observe(book('obs-1'), limits, now.t);
    const r = store.observe(book('obs-1'), limits, now.t);
    expect(r.outcome).toBe('duplicate');
    expect(store.list()[0].evidenceCount).toBe(1);
  });

  it('title 无法辨认时不形成精确身份，不进入中长期记忆', () => {
    const { store, now } = makeStore();
    const r = store.observe({ observationId: 'obs-1', kind: 'book', summary: '某个页面内容……' }, limits, now.t);
    expect(r.outcome).toBe('no_identity');
    expect(store.list()).toHaveLength(0);
  });

  it('confidence 为 low 时不进入中长期记忆', () => {
    const { store, now } = makeStore();
    const r = store.observe(book('obs-1', 'low'), limits, now.t);
    expect(r.outcome).toBe('low_confidence');
    expect(store.list()).toHaveLength(0);
  });

  it('书名号与空白不影响身份归并：三体 与《三体》合并', () => {
    const { store, now } = makeStore();
    store.observe(book('obs-1', 'high', '三体'), limits, now.t);
    now.t += 40 * 60_000;
    store.observe(book('obs-2', 'high', '《三体》'), limits, now.t);
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0].sessionStarts).toHaveLength(2);
  });
});

describe('晋升为长期记忆', () => {
  it('首次 + 72 小时内两次独立重访（间隔超过会话间隔）晋升长期', () => {
    const { store, now } = makeStore();
    store.observe(book('obs-1'), limits, now.t); // 会话 1
    now.t += 40 * 60_000;
    const r2 = store.observe(book('obs-2'), limits, now.t); // 会话 2
    now.t += 40 * 60_000;
    const r3 = store.observe(book('obs-3'), limits, now.t); // 会话 3
    expect(r3.outcome).toBe('promoted');
    expect(r3.tier).toBe('long');
    const list = store.list();
    expect(list[0].tier).toBe('long');
    expect(list[0].promotedAt).toBe(now.t);
    expect(list[0].sessionStarts).toHaveLength(0); // 晋升后清空
  });

  it('三次观察散布在滚动 72 小时窗口之外：不因总次数达到 3 而晋升', () => {
    const { store, now } = makeStore();
    store.observe(book('obs-1'), limits, now.t); // 会话 1 @ T0
    now.t += 73 * HOUR; // 超过 72 小时
    store.observe(book('obs-2'), limits, now.t); // 会话 2 @ T0+73h
    now.t += 1 * HOUR;
    store.observe(book('obs-3'), limits, now.t); // 会话 3 @ T0+74h
    // 滚动窗口 [T0+2h, T0+74h] 内只有会话 2、3，共 2 次 < 3
    const list = store.list();
    expect(list[0].tier).toBe('medium');
    expect(list[0].sessionStarts.filter((t) => t >= now.t - 72 * HOUR)).toHaveLength(2);
  });
});

describe('过期清理与压缩', () => {
  it('中期活动 72 小时未再出现自动过期清理', () => {
    const { store, now } = makeStore();
    store.observe(book('obs-1'), limits, now.t);
    expect(store.list()).toHaveLength(1);
    now.t += 72 * HOUR + 1;
    store.cleanup(limits, now.t);
    expect(store.list()).toHaveLength(0);
  });

  it('长期活动再次出现刷新 lastSeenAt，不产生重复档案', () => {
    const { store, now } = makeStore();
    store.observe(book('obs-1'), limits, now.t);
    now.t += 40 * 60_000;
    store.observe(book('obs-2'), limits, now.t);
    now.t += 40 * 60_000;
    store.observe(book('obs-3'), limits, now.t); // 晋升
    expect(store.list()).toHaveLength(1);
    const before = store.list()[0].id;
    now.t += 5 * DAY; // 5 天后再次出现
    store.observe(book('obs-4'), limits, now.t);
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(before);
    expect(list[0].lastSeenAt).toBe(now.t);
  });

  it('长期 30 天不再出现：高价值压缩为一句概括，低价值删除', () => {
    const { store, now } = makeStore();
    // 高价值：high 置信 → 压缩保留
    store.observe(book('obs-1', 'high'), limits, now.t);
    now.t += 40 * 60_000;
    store.observe(book('obs-2', 'high'), limits, now.t);
    now.t += 40 * 60_000;
    store.observe(book('obs-3', 'high'), limits, now.t); // 晋升 long
    now.t += 30 * DAY + 1;
    store.cleanup(limits, now.t);
    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0].tier).toBe('compressed');
    expect(list[0].compressedAt).toBe(now.t);
    expect(list[0].summary.length).toBeLessThanOrEqual(60);

    // 低价值：medium 置信 → 删除
    const { store: store2, now: now2 } = makeStore();
    store2.observe(book('obs-1', 'medium', '白夜行'), limits, now2.t);
    now2.t += 40 * 60_000;
    store2.observe(book('obs-2', 'medium', '白夜行'), limits, now2.t);
    now2.t += 40 * 60_000;
    store2.observe(book('obs-3', 'medium', '白夜行'), limits, now2.t);
    now2.t += 30 * DAY + 1;
    store2.cleanup(limits, now2.t);
    expect(store2.list()).toHaveLength(0);
  });

  it('压缩概括继续未出现最终删除，不永久占用存储', () => {
    const { store, now } = makeStore();
    store.observe(book('obs-1', 'high'), limits, now.t);
    now.t += 40 * 60_000;
    store.observe(book('obs-2', 'high'), limits, now.t);
    now.t += 40 * 60_000;
    store.observe(book('obs-3', 'high'), limits, now.t); // 晋升
    now.t += 30 * DAY + 1;
    store.cleanup(limits, now.t); // 压缩
    expect(store.list()[0].tier).toBe('compressed');
    now.t += 30 * DAY + 1;
    store.cleanup(limits, now.t); // 压缩概括到期
    expect(store.list()).toHaveLength(0);
  });

  it('压缩概括被重新观察到时重新激活并更新观察时间', () => {
    const { store, now } = makeStore();
    store.observe(book('obs-1', 'high'), limits, now.t);
    now.t += 40 * 60_000;
    store.observe(book('obs-2', 'high'), limits, now.t);
    now.t += 40 * 60_000;
    store.observe(book('obs-3', 'high'), limits, now.t); // 晋升
    now.t += 30 * DAY + 1;
    store.cleanup(limits, now.t); // 压缩
    expect(store.list()[0].tier).toBe('compressed');

    now.t += 1 * DAY;
    store.observe(book('obs-4', 'high'), limits, now.t); // 再次看到同一本书
    const list = store.list();
    expect(list[0].tier).toBe('long');
    expect(list[0].compressedAt).toBeUndefined();
    expect(list[0].lastSeenAt).toBe(now.t);
  });
});

describe('持久化与重启恢复', () => {
  it('退出并重启后恢复中期与长期数据，并完成过期检查', () => {
    const { store, dir, now } = makeStore();
    store.observe(book('obs-1', 'high'), limits, now.t); // 中期
    now.t += 40 * 60_000;
    store.observe(book('obs-2', 'high'), limits, now.t);
    now.t += 40 * 60_000;
    store.observe(book('obs-3', 'high'), limits, now.t); // 晋升长期

    // 模拟重启：新实例读同一目录
    const store2 = new ActivityMemoryStore(dir, { now: () => now.t });
    const list = store2.list();
    expect(list).toHaveLength(1);
    expect(list[0].tier).toBe('long');
    expect(list[0].identityKey).toBe('book:三体');
  });

  it('重启后过期的中期记录被清理', () => {
    const { store, dir, now } = makeStore();
    store.observe(book('obs-1'), limits, now.t);
    now.t += 72 * HOUR + 1;
    const store2 = new ActivityMemoryStore(dir, { now: () => now.t });
    expect(store2.cleanup(limits, now.t)).toBe(1);
    expect(store2.list()).toHaveLength(0);
  });
});

describe('检索 / 列出 / 删除', () => {
  it('list 按最近观察排序，recall 按文字匹配', () => {
    const { store, now } = makeStore();
    store.observe(book('obs-1', 'high', '三体'), limits, now.t);
    now.t += 40 * 60_000;
    store.observe({ observationId: 'obs-2', kind: 'project', title: 'fatty-fish-plugin', action: 'working', summary: '开发屏幕陪伴插件的记忆模块。', confidence: 'high' }, limits, now.t);

    const list = store.list();
    expect(list).toHaveLength(2);
    expect(list[0].title).toBe('fatty-fish-plugin');

    const hits = store.recall('三体');
    expect(hits).toHaveLength(1);
    expect(hits[0].title).toBe('三体');
  });

  it('forget 按 id 删除错误记忆', () => {
    const { store, now } = makeStore();
    const r = store.observe(book('obs-1'), limits, now.t);
    expect(store.list()).toHaveLength(1);
    expect(store.forget(r.id!)).toBe(true);
    expect(store.list()).toHaveLength(0);
    expect(store.forget(r.id!)).toBe(false);
  });

  it('容量超出上限时淘汰最久未更新的', () => {
    const { store, now } = makeStore();
    const small: ActivityMemoryLimits = { ...limits, maxItems: 2 };
    store.observe(book('a', 'high', 'A'), small, now.t);
    now.t += 40 * 60_000;
    store.observe(book('b', 'high', 'B'), small, now.t);
    now.t += 40 * 60_000;
    store.observe(book('c', 'high', 'C'), small, now.t);
    const list = store.list();
    expect(list).toHaveLength(2);
    expect(list.map((i) => i.title)).not.toContain('A');
  });
});
