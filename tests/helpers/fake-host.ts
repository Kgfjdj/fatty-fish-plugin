import type { EventEnvelope, EventRangeQuery, PushOptions, WorldHost } from 'cortico/core/types.ts';
import { nullLogger } from 'cortico/core/util.ts';

export interface RecordedPush {
  event: Parameters<WorldHost['pushEvent']>[0];
  opts?: PushOptions;
}

/** 事件流里的一条简化事件，用于轮数计数测试。 */
export interface FakeStoreEvent {
  cursor: number;
  origin: 'internal' | 'external';
  source: string;
  type: string;
  text: string;
  ts: string;
}

export interface FakeHostOptions {
  /** 宿主模型是否接受 image/jpeg；缺省 true。 */
  acceptsImage?: boolean;
  /** 预置事件流（cursor 需已按序赋值）。 */
  storeEvents?: FakeStoreEvent[];
}

export interface FakeHost {
  host: WorldHost;
  events: RecordedPush[];
  /** 追加一条事件到事件流（自动分配递增 cursor）。 */
  appendStoreEvent(e: Omit<FakeStoreEvent, 'cursor'>): FakeStoreEvent;
}

/** 最小 WorldHost 假实现：记录 pushEvent，提供可配置的 modelFacts 与事件流 store。 */
export function makeFakeHost(opts: FakeHostOptions = {}): FakeHost {
  const events: RecordedPush[] = [];
  const storeEvents: FakeStoreEvent[] = [...(opts.storeEvents ?? [])];

  const store = {
    get: (cursor: number) => storeEvents.find((e) => e.cursor === cursor) as EventEnvelope | undefined,
    latestCursor: () => (storeEvents.length ? storeEvents[storeEvents.length - 1].cursor : 0),
    range: (q: EventRangeQuery) => {
      const from = q.fromCursor ?? 0;
      const to = q.toCursor ?? Number.MAX_SAFE_INTEGER;
      return storeEvents.filter((e) => e.cursor >= from && e.cursor <= to) as unknown as EventEnvelope[];
    },
    around: () => [] as EventEnvelope[],
    grep: () => [],
  };

  const host = {
    pushEvent: async (e: RecordedPush['event'], o?: PushOptions) => {
      events.push({ event: e, opts: o });
      return { ...e, cursor: events.length, origin: e.origin ?? 'external' } as EventEnvelope;
    },
    pushDeferred: () => {},
    drainPendingEvents: async () => [],
    reportUsage: () => {},
    modelFacts: {
      model: () => 'test-model',
      accepts: () => opts.acceptsImage ?? true,
      contextWindow: () => 128000,
    },
    blob: () => null,
    log: nullLogger(),
    store,
  } as unknown as WorldHost;

  const appendStoreEvent = (e: Omit<FakeStoreEvent, 'cursor'>): FakeStoreEvent => {
    const cursor = storeEvents.length ? storeEvents[storeEvents.length - 1].cursor + 1 : 1;
    const ev: FakeStoreEvent = { ...e, cursor };
    storeEvents.push(ev);
    return ev;
  };

  return { host, events, appendStoreEvent };
}
