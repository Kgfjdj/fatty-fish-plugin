import type { EventEnvelope, PushOptions, WorldHost } from 'cortico/core/types.ts';
import { nullLogger } from 'cortico/core/util.ts';

export interface RecordedPush {
  event: Parameters<WorldHost['pushEvent']>[0];
  opts?: PushOptions;
}

export interface FakeHostOptions {
  /** 宿主模型是否接受 image/jpeg；缺省 true。 */
  acceptsImage?: boolean;
}

export interface FakeHost {
  host: WorldHost;
  events: RecordedPush[];
}

/** 最小 WorldHost 假实现：记录 pushEvent，提供可配置的 modelFacts。 */
export function makeFakeHost(opts: FakeHostOptions = {}): FakeHost {
  const events: RecordedPush[] = [];
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
  } as unknown as WorldHost;
  return { host, events };
}
