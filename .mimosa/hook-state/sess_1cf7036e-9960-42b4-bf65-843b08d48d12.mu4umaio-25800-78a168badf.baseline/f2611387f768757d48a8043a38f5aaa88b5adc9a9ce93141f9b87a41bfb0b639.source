/**
 * pi extension: gives the agent a `render_ui` tool.
 *
 * The agent calls it with a declarative UI spec (see pi-webx's
 * `src/shared/uikit.ts` for the schema). The tool does nothing but validate and
 * echo the spec back; the web UI picks it up from the tool-call event and
 * renders real components. Nothing is executed — this is data, not code.
 *
 * Deployed from pi-webx/extensions/pi-webx-ui.ts — keep the two in sync.
 */

// @ts-nocheck — loaded by pi's own runtime, which provides these modules.
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

const UI_GUIDE = `UI 规格是一个 JSON 对象：{ title?: string, root: Node | Node[] }。
Node 的 t 取值：
  布局   row(align/gap/wrap) col(gap) card(title,variant:outlined|highlight|flat) divider
  文本   title(v,level:1-4) text(v,kind:p|secondary|code|strong) md(v:markdown)
  数据   stat(label,value,unit,trend:up|down,hint)
         table(columns:[{k,title,w}],rows:[{...}])
         desc(title,cols:1-3,items:[{k,v}]) tags(items:[str])
         callout(kind:info|success|warning|error,title,v) code(v,lang) list(items)
  交互   button(v,kind:primary|default|dashed|danger,action) btngroup(buttons:[...])
         form(title,fields,submit,action) — field: {t:input|textarea|select|checkbox|switch, k, label, ph?, required?, options?}
  图表   chart(kind:line|bar|area|pie, labels:[str], series:[{name,data:[num]}], height?)
children 表示子节点数组。用户点按钮/提交表单时，action 文本会作为新消息发回给你。`;

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

export default function piWebxUiExtension(pi) {
  pi.registerTool({
    name: 'render_ui',
    label: '渲染界面',
    description:
      '把结构化 UI（卡片、表格、指标卡、图表、表单等）渲染到用户的界面上，用于展示数据看板、报表、对比结果或收集输入。' +
      '必须传入完整、合法的 JSON 规格；不要用它输出纯文字（普通回复即可）。',
    promptSnippet: 'render_ui: 用声明式 JSON 组件规格渲染界面（卡片/表格/图表/表单）',
    promptGuidelines: [
      '当用户要求数据看板、报表、对比表、统计卡片、图表或结构化表单时，优先调用 render_ui。',
      'spec 必须是单个 JSON 对象，不要包含注释、尾逗号或 Markdown 代码块围栏。',
      '数字一律用 number 类型而不是字符串；图表的 labels 与每条 series 的 data 长度要一致。',
      '需要用户确认或选择时，用 form 或带 action 的 button，用户操作后会作为新消息发回。',
      UI_GUIDE,
    ],
    parameters: Type.Object({
      title: Type.Optional(Type.String({ description: '这块界面的标题' })),
      spec: Type.Any({ description: '完整的 UI 规格 JSON 对象（含 root 字段）' }),
    }),
    async execute(_toolCallId, params) {
      // Models frequently pass `spec` as a JSON-encoded string — unwrap up to twice.
      let raw = params?.spec;
      for (let round = 0; round < 2 && typeof raw === 'string'; round += 1) {
        try {
          raw = JSON.parse(raw);
        } catch {
          break;
        }
      }

      if (!raw || !isRecord(raw)) {
        return {
          content: [
            {
              type: 'text',
              text: 'render_ui 被拒绝：spec 必须是 JSON 对象（形如 {"root":[...]}）。请修正后重试，或改用普通文本回复。',
            },
          ],
          details: { ok: false, reason: 'spec-not-object' },
        };
      }

      const root = isRecord(raw) && 'root' in raw ? raw.root : raw;
      let nodeCount = 0;
      const count = (value) => {
        if (Array.isArray(value)) return value.reduce((sum, entry) => sum + count(entry), 0);
        if (isRecord(value)) {
          let total = 1;
          for (const child of Object.values(value)) total += count(child);
          return total;
        }
        return 0;
      };
      try {
        nodeCount = count(root);
      } catch {
        nodeCount = 0;
      }

      const title = typeof raw.title === 'string' && raw.title ? raw.title : params?.title;

      return {
        content: [
          {
            type: 'text',
            text: `已在用户界面渲染组件视图${title ? `「${title}」` : ''}（约 ${nodeCount} 个节点）。用户可以点击其中的按钮/表单，操作会作为新消息发回给你。`,
          },
        ],
        details: {
          ok: true,
          // The web UI renders from this normalized envelope, falling back to
          // the raw call arguments when it is absent.
          a2ui: { ...(title ? { title } : {}), root },
          nodeCount,
        },
      };
    },
  });

  pi.on('session_start', (_event, ctx) => {
    ctx.ui.setStatus?.('pi-webx-ui', 'render_ui 就绪');
  });
}
