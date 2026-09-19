/**
 * 工具卡：bash/read/write/edit 展开后只显示**结果**，且结果区自己滚动。
 *
 * 参考 deepseek-harness 的 `ToolRow`：单个文件的工具不渲染参数体（行摘要里的路径
 * 就是唯一的参数交互），shell 调用的命令在行摘要里已经写全，展开体是结果本身。
 * 之前这里给 bash 又叠了一块「命令」、给 read 叠了一块「参数」，把用户真正要看的
 * 输出往下挤；而输出没有高度上限，一段长输出会把整篇正文顶下去。
 *
 * 这是个渲染断言脚本（`node --import ./scripts/check-bootstrap.mjs` 起，见该文件），
 * 因为它要断言的东西只有渲染出来才看得见：哪个区块被渲染、类名挂在谁身上。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ConfigProvider } from '@lobehub/ui';
import { motion } from 'motion/react';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ToolCard } from '../src/components/ToolCard';
import type { ToolRun } from '../src/shared/transcript';

/**
 * A run the card renders expanded.
 *
 * `status: 'running'` is what opens the body without a click: a successful call
 * folds to its header line, so its sections are not in the markup at all.
 */
function run(over: Partial<ToolRun>): ToolRun {
  return {
    toolCallId: 'c1',
    toolName: 'bash',
    args: {},
    output: '',
    status: 'running',
    startedAt: 1,
    ...over,
  };
}

/**
 * The card is rendered inside the same provider the app mounts with; lobehub's
 * motion-backed components throw without it.
 */
const render = (r: ToolRun): string =>
  renderToStaticMarkup(h(ConfigProvider, { motion }, h(ToolCard, { run: r })));

const longOutput = Array.from({ length: 40 }, (_, i) => i + 1).join('\n');

// A shell call: the command lives in the row summary, so the body is the output
// alone — no repeated 「命令」 block.
const bash = render(run({ toolName: 'bash', args: { command: 'seq 1 40' }, output: longOutput }));
assert.ok(bash.includes('输出'), 'bash 卡要有输出区');
assert.ok(!bash.includes('命令'), `bash 卡不该再渲染「命令」区块：${bash.slice(0, 200)}`);

// The caption and its payload live inside ONE section element, and that element
// is the scrollport: that is what makes the caption sticky against the scroll
// rather than merely sitting above it.
assert.match(
  bash,
  /class="section"[^>]*>\s*<span class="sectionLabel">输出<\/span>/,
  '「输出」必须是 section 里的 sectionLabel，和 payload 同处一个滚动容器',
);

// A file read: the path is the row summary, so no 「参数」 JSON block either.
const read = render(
  run({ toolName: 'read', args: { path: '/tmp/example.ts' }, output: longOutput }),
);
assert.ok(read.includes('输出'), 'read 卡要有输出区');
assert.ok(!read.includes('参数'), 'read 卡不该再渲染「参数」区块');

// A tool whose arguments are NOT in the summary keeps its args block.
const other = render(
  run({ toolName: 'some_unknown_tool', args: { query: 'x', limit: 3 }, output: 'ok' }),
);
assert.ok(other.includes('参数'), '摘要里没有的工具仍要显示参数');

/**
 * The cap itself is a style contract, so it is read from the stylesheet: the
 * markup can show which element scrolls, not how tall it is. dsh's `.ioSection`
 * is the reference — 150px, its own scrollport.
 */
const css = readFileSync(new URL('../src/components/ToolCard.module.css', import.meta.url), 'utf8');
const cap = /\.section\s*\{([^}]*)\}/.exec(css);
assert.ok(cap, 'ToolCard.module.css 里要有 .section 规则');
assert.match(cap[1]!, /max-height:\s*150px/, '.section 的高度上限要是 150px（对齐 dsh ioSection）');
assert.match(cap[1]!, /overflow-y:\s*auto/, '.section 要自己滚动');

// 「sticky 标签」是 objective 明确点名的形态：caption 必须在滚动容器**内部**粘住，
// 而不是待在容器外面靠"不跟着滚"达到类似效果。
const label = /\.sectionLabel\s*\{([^}]*)\}/.exec(css);
assert.ok(label, 'ToolCard.module.css 里要有 .sectionLabel 规则');
assert.match(label[1]!, /position:\s*sticky/, '.sectionLabel 要 sticky');
assert.match(label[1]!, /top:\s*0/, '.sectionLabel 粘在滚动容器的顶边');

// caption 独占左栏（dsh 的两列网格）——这也是 sticky 不需要背景色的原因。
const grid = /\.section,\s*\n?\.sectionPlain\s*\{([^}]*)\}/.exec(css);
assert.ok(grid, '两个 section 变体要共用一套几何');
assert.match(grid[1]!, /grid-template-columns:\s*max-content\s+1fr/, 'caption 左栏 + payload 右栏');

// A tool that returned images renders its own section, and the thumbnails are
// NOT put behind the section scrollport: an image is content to look at, so
// capping it at 150px would clip the picture rather than trim a long log.
const withImages = render(
  run({
    toolName: 'render',
    args: {},
    output: 'ok',
    images: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }],
    imageCount: 1,
  }),
);
assert.ok(withImages.includes('图片'), '工具返回的图要有自己的区块');
assert.ok(withImages.includes('输出'), '同一张卡仍有输出区');
assert.match(
  withImages,
  /<img[^>]+src="data:image\/png;base64,AAAA"/,
  '服务端渲染时缩略图走内联回退（摘要还没算出来），不能是裂图',
);
// 图片区块用 sectionPlain：数一下带滚动上限的那个 class 出现几次，
// 只该有「输出」那一个（sectionLabel / sectionBody / sectionPlain 都不该被误计）。
assert.equal(
  (withImages.match(/class="section"/g) ?? []).length,
  1,
  '只有输出区该被 150px 滚动容器包住，图片区块走 sectionPlain',
);
assert.ok(
  withImages.includes('sectionPlain'),
  '图片区块要有自己的（不封顶的）section 变体',
);

console.log('PASS 工具卡：bash/read 只渲染结果、结果区是 150px 独立滚动容器且 caption sticky，摘要里没有的仍显示参数');
