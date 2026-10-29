import { describe, expect, it } from 'vitest';
import { MemoryManager, type MemoryLimits } from '../src/memory.ts';

const limits: MemoryLimits = {
  maxScenes: 3,
  maxEntriesPerScene: 5,
  maxTurns: 10,
  ttlMs: 60 * 60_000,
};

const now = 1_000_000;

function makeManager(): MemoryManager {
  return new MemoryManager();
}

describe('MemoryManager.record', () => {
  it('写入一条摘要', () => {
    const m = makeManager();
    const r = m.record(
      { observationId: 'obs-1', sceneType: 'reading', sceneLabel: '三体', summary: '主角叶文洁收到三体文明的回信。' },
      limits,
      0,
      now,
    );
    expect(r).toMatchObject({ outcome: 'added', sceneType: 'reading', sceneLabel: '三体' });
    expect(m.listScenes()).toHaveLength(1);
    expect(m.listScenes()[0].entries).toHaveLength(1);
  });

  it('空或过短摘要不记', () => {
    const m = makeManager();
    expect(m.record({ summary: '   ' }, limits, 0, now)).toMatchObject({ outcome: 'skipped', reason: 'empty' });
    expect(m.record({ summary: '太短' }, limits, 0, now)).toMatchObject({ outcome: 'skipped', reason: 'tooShort' });
    expect(m.listScenes()).toHaveLength(0);
  });

  it('非法 sceneType 归为 unknown', () => {
    const m = makeManager();
    const r = m.record({ sceneType: 'gaming', summary: '一段足够长的内容摘要描述。' }, limits, 0, now);
    expect(r).toMatchObject({ sceneType: 'unknown' });
  });

  it('超长摘要被截断', () => {
    const m = makeManager();
    const long = '字'.repeat(500);
    m.record({ summary: long }, limits, 0, now);
    expect(m.listScenes()[0].entries[0].summary.length).toBeLessThanOrEqual(200);
  });
});

describe('场景归并与切换', () => {
  it('相同 label 归入同一场景', () => {
    const m = makeManager();
    m.record({ sceneType: 'reading', sceneLabel: '三体', summary: '第一页内容摘要……' }, limits, 0, now);
    m.record({ sceneType: 'reading', sceneLabel: '三体', summary: '第二页内容摘要……' }, limits, 0, now);
    expect(m.listScenes()).toHaveLength(1);
    expect(m.listScenes()[0].entries).toHaveLength(2);
  });

  it('不同 label 新建场景', () => {
    const m = makeManager();
    m.record({ sceneType: 'reading', sceneLabel: '三体', summary: '第一页内容摘要……' }, limits, 0, now);
    m.record({ sceneType: 'reading', sceneLabel: '活着', summary: '另一本书的摘要……' }, limits, 0, now);
    expect(m.listScenes()).toHaveLength(2);
  });

  it('切回旧场景仍能接上', () => {
    const m = makeManager();
    m.record({ sceneType: 'reading', sceneLabel: '三体', summary: '三体第一页摘要……' }, limits, 0, now);
    m.record({ sceneType: 'coding', sceneLabel: 'fatty-fish', summary: '代码项目的摘要……' }, limits, 0, now);
    // 切回三体
    const r = m.record({ sceneType: 'reading', sceneLabel: '三体', summary: '三体第二页摘要……' }, limits, 0, now);
    expect(r.outcome).toBe('added');
    const scenes = m.listScenes();
    expect(scenes).toHaveLength(2);
    const threeBody = scenes.find((s) => s.label === '三体')!;
    expect(threeBody.entries).toHaveLength(2);
    expect(threeBody.lastUpdatedAt).toBe(now);
  });

  it('没给 label 时按 type 归入最近活跃场景', () => {
    const m = makeManager();
    m.record({ sceneType: 'reading', summary: '第一页摘要……' }, limits, 0, now);
    m.record({ sceneType: 'reading', summary: '第二页摘要……' }, limits, 0, now);
    expect(m.listScenes()).toHaveLength(1);
    expect(m.listScenes()[0].entries).toHaveLength(2);
  });
});

describe('容量限制', () => {
  it('每场景最多 maxEntriesPerScene 条，超出淘汰最旧', () => {
    const m = makeManager();
    for (let i = 1; i <= 7; i++) {
      m.record({ sceneType: 'reading', sceneLabel: '书', summary: `第 ${i} 页的内容摘要，足够长。` }, limits, 0, now + i);
    }
    const entries = m.listScenes()[0].entries;
    expect(entries).toHaveLength(5);
    expect(entries[0].summary).toContain('第 3 页');
    expect(entries[4].summary).toContain('第 7 页');
  });

  it('场景数最多 maxScenes 个，超出淘汰最久未更新', () => {
    const m = makeManager();
    for (const label of ['甲', '乙', '丙', '丁']) {
      m.record({ sceneType: 'reading', sceneLabel: label, summary: `${label} 的内容摘要，足够长。` }, limits, 0, now);
    }
    const scenes = m.listScenes();
    expect(scenes).toHaveLength(3);
    const labels = scenes.map((s) => s.label);
    expect(labels).not.toContain('甲'); // 最旧的被淘汰
    expect(labels).toEqual(expect.arrayContaining(['乙', '丙', '丁']));
  });
});

describe('去重', () => {
  it('同一 observationId 重复记录时更新而非新增', () => {
    const m = makeManager();
    m.record({ observationId: 'obs-1', sceneType: 'reading', summary: '第一版摘要……' }, limits, 0, now);
    const r = m.record({ observationId: 'obs-1', sceneType: 'reading', summary: '第二版摘要……' }, limits, 0, now);
    expect(r.outcome).toBe('updated');
    const entries = m.listScenes()[0].entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].summary).toContain('第二版');
  });
});

describe('过期', () => {
  it('轮数过期：达到 maxTurns 后不再返回', () => {
    const m = makeManager();
    m.record({ sceneType: 'reading', summary: '一条摘要，足够长。' }, limits, 0, now);
    expect(m.recent(undefined, 9, now, limits)).toHaveLength(1); // 第 9 轮仍有效
    expect(m.recent(undefined, 10, now, limits)).toHaveLength(0); // 第 10 轮过期
  });

  it('时间过期：超过 ttlMs 后不再返回', () => {
    const m = makeManager();
    m.record({ sceneType: 'reading', summary: '一条摘要，足够长。' }, limits, 0, now);
    expect(m.recent(undefined, 0, now + 60 * 60_000 - 1, limits)).toHaveLength(1);
    expect(m.recent(undefined, 0, now + 60 * 60_000, limits)).toHaveLength(0);
  });

  it('过期后 advanceTurn 会清理，listScenes 不再含空场景', () => {
    const m = makeManager();
    m.record({ sceneType: 'reading', summary: '一条摘要，足够长。' }, limits, 0, now);
    m.advanceTurn(10, now, limits);
    expect(m.listScenes()).toHaveLength(0);
  });
});

describe('recent 与 clear', () => {
  it('recent 返回最新在前', () => {
    const m = makeManager();
    m.record({ sceneType: 'reading', summary: '第一条摘要，足够长。' }, limits, 0, now);
    m.record({ sceneType: 'reading', summary: '第二条摘要，足够长。' }, limits, 0, now + 1);
    const entries = m.recent(undefined, 0, now + 1, limits);
    expect(entries).toHaveLength(2);
    expect(entries[0].summary).toContain('第二条');
    expect(entries[1].summary).toContain('第一条');
  });

  it('指定 sceneId 只返回该场景', () => {
    const m = makeManager();
    const a = m.record({ sceneType: 'reading', sceneLabel: '甲', summary: '甲的内容摘要……' }, limits, 0, now);
    m.record({ sceneType: 'reading', sceneLabel: '乙', summary: '乙的内容摘要……' }, limits, 0, now);
    if (a.outcome !== 'added') throw new Error('expected added');
    const entries = m.recent(a.sceneId, 0, now, limits);
    expect(entries).toHaveLength(1);
    expect(entries[0].summary).toContain('甲');
  });

  it('clear 清空全部', () => {
    const m = makeManager();
    m.record({ sceneType: 'reading', summary: '一条摘要，足够长。' }, limits, 0, now);
    m.clear();
    expect(m.listScenes()).toHaveLength(0);
    expect(m.recent(undefined, 0, now, limits)).toHaveLength(0);
  });
});
