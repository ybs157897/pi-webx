/**
 * 工具卡：bash 走 dsh 的终端卡；read/write/edit 展开后只显示**结果**且自己滚动。
 *
 * 两条参考都来自 deepseek-harness：
 *
 * - `ToolRow`：单个文件的工具不渲染参数体（行摘要里的路径就是唯一的参数交互），
 *   read/write/edit 的展开体是结果本身。之前这里给 bash 又叠了一块「命令」、给 read
 *   叠了一块「参数」，把用户真正要看的输出往下挤；而输出没有高度上限，一段长输出会
 *   把整篇正文顶下去。
 * - `TerminalBlock`（bash 行）：shell 调用画成一张终端卡——提示行是「状态点 · 工作
 *   目录 · 命令」，输出在它下面；退出码是行上的 pill，不是输出里的一行文字；输出按
 *   ANSI 上色并按列对齐。
 *
 * 行摘要仍是命令：dsh 的 bash 行优先显示调用自带的 `description`，pi 的 bash 没有
 * 这个参数（只有 `command`），所以两侧都退化成「标题 · 命令」——参考实现遇到没有
 * description 的调用也是这样。
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

import { ToolCard, RESULT_ONLY_TOOLS } from '../src/components/ToolCard';
import { summarizeToolCall } from '../src/lib/format';
import { SessionCwdProvider } from '../src/lib/session-cwd';
import { TERMINAL_TOOLS, terminalCard } from '../src/lib/terminal-card';
import { BUILTIN_TOOL_NAMES } from '../src/shared/tool-presets';
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

/**
 * The same card with a session working directory in scope. The terminal card's
 * prompt label reads it from context (see `lib/session-cwd`), so the harness has
 * to provide it the way `App` does rather than pass it down as a prop.
 */
const renderWithCwd = (r: ToolRun, cwd: string): string =>
  renderToStaticMarkup(
    h(ConfigProvider, { motion }, h(SessionCwdProvider, { cwd }, h(ToolCard, { run: r }))),
  );

/**
 * The marked-up body as plain text. The result payload is syntax-highlighted,
 * so a sentence arrives split across Shiki's token spans; dropping the tags
 * puts it back together for a `includes` assertion.
 */
const textOf = (markup: string): string => markup.replace(/<[^>]*>/g, '');

const longOutput = Array.from({ length: 40 }, (_, i) => i + 1).join('\n');

// A shell call is dsh's terminal card: the command and its output share one
// surface, so there is no 「参数」 JSON block and no separate 「输出」 section —
// the card's own body IS the output.
const bash = render(run({ toolName: 'bash', args: { command: 'seq 1 40' }, output: longOutput }));
assert.ok(bash.includes('data-terminal'), 'bash 卡要走终端卡');
assert.match(bash, /class="command">seq 1 40</, '命令要画在终端卡的提示行里');
assert.ok(!bash.includes('参数'), `bash 卡不该有「参数」区块：${bash.slice(0, 200)}`);
assert.ok(!bash.includes('class="section"'), 'bash 卡不该再走通用 section 形状');

// 行标题是 dsh 的 titleKey（`Bash`），不是 pi 的小写工具 id；摘要仍是命令本身，
// 因为 pi 的 bash 没有 description 可放（参考实现同样退化成命令）。
assert.match(textOf(bash), /Bash·seq 1 40/, '行摘要要读作「Bash · 命令」');
assert.ok(!textOf(bash).includes('bash·'), '行里不该再出现小写的 bash 标题');

// 工作目录是会话的，不是调用的：pi 的 bash 永远在会话目录里跑、参数里没有 workdir。
// 提示标签取路径最后一段。没有会话目录时退回裸 `$`，不编一个出来。
const withCwd = renderWithCwd(
  run({ args: { command: 'pwd' }, output: '/w' }),
  '/Users/yin/Documents/ybs/code/pi-webx',
);
assert.match(withCwd, /class="cwd">pi-webx</, 'cwd 徽标要取会话目录的最后一段');
assert.match(bash, /class="cwd">\$</, '没有会话目录时提示符退回裸 $');

// 输入带 `$`、输出不带 —— 参考实现的口径：命令的**首行**挂工作目录标签，续行挂 `$`，
// 输出行一个都不挂。所以单行命令看不到 `$` 不是缺失，是首行让给了 cwd。
const multiLine = renderWithCwd(
  run({ toolName: 'bash', args: { command: 'set -e\nseq 1 3\necho done' }, output: '1\n2\n3\ndone' }),
  '/w/pi-webx',
);
assert.deepEqual(
  [...multiLine.matchAll(/class="cwd">([^<]*)<\/span><span class="command">([^<]*)</g)]
    .map((m) => `${m[1]!} ${m[2]!}`),
  ['pi-webx set -e', '$ seq 1 3', '$ echo done'],
  '命令首行挂工作目录、续行挂 $（dsh TerminalBlock 的口径）',
);
assert.deepEqual(
  [...multiLine.matchAll(/class="line">([^<]*)</g)].map((m) => m[1]!),
  ['1', '2', '3', 'done'],
  '输出行不带 $',
);

// pi 把失败的 shell 调用「抛」出来，输出后面附自己的状态行（`Command exited with
// code N`）。那是 pi 写的界面文案、不是命令印的字，所以它变成卡上的退出码 pill，
// 不再被画成输出的一部分。
const failedBash = render(
  run({
    toolName: 'bash',
    args: { command: 'exit 1' },
    output: 'boom\n\nCommand exited with code 1',
    status: 'error',
  }),
);
assert.match(failedBash, /class="pill status">退出码 1</, '失败退出码要成为卡上的 pill');
assert.ok(!textOf(failedBash).includes('Command exited with code'), 'pi 的状态行不该被画成输出');
assert.ok(textOf(failedBash).includes('boom'), '命令自己的输出要留下');

// `bashExecution`（pi 自己那条直连 shell，由快照回放）把退出码当字段带，不在文本里；
// 转写把它放在 run 的 `details` 上，那里报的码优先于文本解析。
assert.equal(
  terminalCard(
    run({ args: { command: 'ls' }, output: 'total 8', details: { exitCode: 2 }, status: 'error' }),
    null,
  )?.exitCode,
  2,
  'details 里报的退出码优先于文本解析',
);
// 被中止 / 超时是「没有退出码的失败」。
assert.equal(
  terminalCard(
    run({ args: { command: 'sleep 9' }, output: 'x\n\nCommand aborted', status: 'error' }),
    null,
  )?.exitCode,
  null,
  '被中止的命令没有退出码',
);
assert.equal(
  terminalCard(
    run({ args: { command: 'sleep 9' }, output: 'x\n\nCommand timed out after 3 seconds', status: 'error' }),
    null,
  )?.exitCode,
  null,
  '超时的命令没有退出码',
);
// 运行中没有退出状态；干净结束是 0（0 不上 pill）。
assert.equal(
  terminalCard(run({ args: { command: 'x' }, output: '' }), null)?.exitCode,
  undefined,
  '运行中没有退出码',
);
assert.equal(
  terminalCard(run({ args: { command: 'x' }, output: 'ok', status: 'success' }), null)?.exitCode,
  0,
  '干净结束是 0',
);
// 只有 shell 调用拿终端卡，别的工具仍走原来的 section 形状。
assert.equal(terminalCard(run({ toolName: 'read', args: { path: '/tmp/a' } }), null), null, 'read 不走终端卡');

// ANSI 输出被解析成带样式的 run 并落到主题令牌上：带色的日志读起来是带色的字，
// 而不是转义字节。
const ansi = render(run({ args: { command: 'ls' }, output: '\u001b[31mred\u001b[0m plain' }));
assert.match(
  ansi,
  /<span style="color:var\(--dsw-alias-state-error-primary\)">red<\/span>/,
  'ANSI 前景色要落到主题令牌上',
);
assert.ok(!ansi.includes('\u001b'), '输出里不该留裸的转义字节');

// A file read: the path is the row summary, so no 「参数」 JSON block, and the
// result itself carries no caption — `输出` named the one block the card's shape
// already implies, and charged a left column to say it.
const read = render(
  run({ toolName: 'read', args: { path: '/tmp/example.ts' }, output: longOutput }),
);
assert.ok(read.includes('class="bare"'), 'read 的结果区走无标签的 bare 区块');
assert.ok(!read.includes('输出'), `read 卡不该再挂「输出」左栏标签：${read.slice(0, 200)}`);
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

// 无标签区块：同样的 150px 上限与自己的滚动条，但没有 caption 栏——结果区用它。
const bareRule = /\.bare\s*\{([^}]*)\}/.exec(css);
assert.ok(bareRule, 'ToolCard.module.css 里要有 .bare 规则（不带 caption 的区块）');
assert.match(bareRule[1]!, /max-height:\s*150px/, '.bare 与 .section 同一高度上限');
assert.match(bareRule[1]!, /overflow-y:\s*auto/, '.bare 也要自己滚动');

/**
 * 终端卡的高度上限同样是样式契约：参考实现把上限加在**输出区**（对话行里是
 * 224px），命令横幅钉住不动，行数上限关掉（`maxLines={Infinity}`）——于是一段长日志
 * 在卡内滚动，而不是把正文顶下去。
 */
const terminalCardCss = /\.terminal\s*\{([^}]*)\}/.exec(css);
assert.ok(terminalCardCss, 'ToolCard.module.css 里要有 .terminal 规则');
assert.match(
  terminalCardCss[1]!,
  /--dsl-terminal-output-max-height:\s*224px/,
  '终端卡输出区上限 224px（对齐 dsh bash 行的 .terminal）',
);
const primitiveCss = readFileSync(
  new URL('../src/ui/primitives/TerminalBlock.module.css', import.meta.url),
  'utf8',
);
const outputRule = /\.output\s*\{([^}]*)\}/.exec(primitiveCss);
assert.ok(outputRule, 'TerminalBlock.module.css 里要有 .output 规则');
assert.match(
  outputRule[1]!,
  /max-height:\s*var\(--dsl-terminal-output-max-height/,
  '输出区的高度上限由渲染点通过自定义属性给定',
);
assert.match(outputRule[1]!, /overflow-y:\s*auto/, '输出区要自己滚动（命令横幅钉住）');
// 代码字体必须走 `font-family`：本仓库的代码字体令牌只是字体栈，而 `font: <字体栈>`
// 是非法简写、会被浏览器整条丢掉（实测会让终端文字退回正文字体）。
assert.match(
  outputRule[1]!,
  /font-family:\s*var\(--dsl-terminal-font/,
  '.output 要用 font-family 装代码字体（参考实现的 font 简写在这是非法的）',
);
assert.ok(
  !/font:\s*var\(--dsl-terminal-font\)/.test(primitiveCss),
  '整个终端卡都不该用 font 简写装字体栈',
);

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
assert.match(
  withImages,
  /<img[^>]+src="data:image\/png;base64,AAAA"/,
  '服务端渲染时缩略图走内联回退（摘要还没算出来），不能是裂图',
);
// 图片区块走不封顶的 sectionPlain，输出走封顶的 bare：所以带 caption 的 .section
// 在这张卡里一个都没有（正则带引号，不会误匹配 sectionPlain）。
assert.equal(
  (withImages.match(/class="section"/g) ?? []).length,
  0,
  '输出区已不带 caption，图片区块走 sectionPlain',
);
assert.equal(
  (withImages.match(/class="bare"/g) ?? []).length,
  1,
  '只有输出区该被 150px 滚动容器包住',
);
assert.ok(
  withImages.includes('sectionPlain'),
  '图片区块要有自己的（不封顶的）section 变体',
);

/**
 * The classification, checked as a set rather than name by name.
 *
 * Two ways it can be wrong and stay invisible: a name that is not a pi builtin
 * (a typo — the card would silently keep its args block for the real tool), and
 * a name whose row summary is empty (dropping the args block would leave the
 * call with no description at all). Requiring a representative payload per
 * classified tool means adding a name to the set forces proving both.
 */
const REPRESENTATIVE_ARGS: Record<string, Record<string, unknown>> = {
  bash: { command: 'seq 1 40' },
  powershell: { command: 'Get-ChildItem' },
  read: { path: '/tmp/example.ts' },
  write: { path: '/tmp/example.ts', content: 'export const x = 1\n' },
  edit: { path: '/tmp/example.ts', edits: [{ oldText: 'a', newText: 'b' }] },
};

for (const name of RESULT_ONLY_TOOLS) {
  assert.ok(BUILTIN_TOOL_NAMES.has(name), `${name} 不是 pi 的内建工具名（拼错了？）`);
  const args = REPRESENTATIVE_ARGS[name];
  assert.ok(args, `${name} 要有一条代表性参数，用来证明「行摘要已经说清这次调用」`);
  assert.notEqual(
    summarizeToolCall(name, args),
    '',
    `${name} 的行摘要是空的——去掉参数区后这次调用就没有任何描述了`,
  );
  const markup = render(run({ toolName: name, args, output: longOutput }));
  assert.ok(!markup.includes('参数'), `${name} 卡不该渲染「参数」区块`);
  if (TERMINAL_TOOLS.has(name)) {
    // 「只显示结果」在这条路径上的形态是终端卡：命令在提示行，结果就是卡身。
    assert.ok(markup.includes('data-terminal'), `${name} 卡要走终端卡`);
  } else {
    // 写文件类的结果是那份变更（带「变更」标签）；其余是结果区块——它已不带 caption，
    // 所以这里断言区块本身渲染出来，而不是找一个标签词。
    assert.ok(
      textOf(markup).includes('变更') || markup.includes('class="bare"'),
      `${name} 卡要显示结果（变更区块或无 caption 的结果区块）`,
    );
  }
}

// A mutation that landed: the diff IS the result. pi's result text restates it
// ("Successfully wrote 2 bytes to …"), so giving it its own section would only
// push the card down — the thing this whole card was changed to stop doing.
const wrote = render(
  run({
    toolName: 'write',
    args: { path: '/tmp/example.ts', content: 'export const x = 1\n' },
    output: 'Successfully wrote 22 bytes to /tmp/example.ts',
  }),
);
assert.ok(wrote.includes('变更'), '落地的 write 要画变更');
assert.ok(!wrote.includes('输出'), '落地 write 的结果文本是变更的复述，不单列');

// A mutation that FAILED. pi reports it in the result text with an empty patch
// ("Could not find edits[14] in …", isError), so the args-derived diff is the
// never-applied request drawn over the error that explains it.
const failedEdit = render(
  run({
    toolName: 'edit',
    args: { path: '/tmp/example.ts', edits: [{ oldText: 'a', newText: 'b' }] },
    output: 'Could not find edits[0] in /tmp/example.ts.',
    status: 'error',
  }),
);
assert.ok(
  textOf(failedEdit).includes('Could not find edits[0]'),
  '失败的 edit 要显示失败原因',
);
assert.ok(!failedEdit.includes('变更'), '失败的 edit 不该把没落地的改动画成变更');

console.log(
  'PASS 工具卡：bash 走终端卡（Bash · 命令、cwd 徽标、命令带 $/输出不带、退出码 pill、ANSI 上色、输出区 224px 自滚），'
  + 'read/write/edit 只渲染结果、结果区不带 caption 且仍是 150px 独立滚动容器，摘要里没有的仍显示参数',
);
