/**
 * 由源码自描述与 ENV_PROMPT.md 生成 describe.json，保证包内描述与代码一致。
 * 运行：pnpm build:describe
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCREEN_COMPANION } from '../src/definition.ts';
import { SCREEN_COMPANION_ID } from '../src/config.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPrompt = readFileSync(join(root, 'src', 'ENV_PROMPT.md'), 'utf8');

const doc = {
  tools: SCREEN_COMPANION.describe?.tools ?? [],
  events: SCREEN_COMPANION.describe?.events ?? [],
  prompts: [
    {
      key: `worlds.${SCREEN_COMPANION_ID}.envPrompt`,
      title: '屏幕陪伴桌宠 · 环境提示词',
      role: 'envPrompt',
      content: envPrompt,
    },
  ],
};

writeFileSync(join(root, 'describe.json'), `${JSON.stringify(doc, null, 2)}\n`);
console.log('describe.json 已生成');
