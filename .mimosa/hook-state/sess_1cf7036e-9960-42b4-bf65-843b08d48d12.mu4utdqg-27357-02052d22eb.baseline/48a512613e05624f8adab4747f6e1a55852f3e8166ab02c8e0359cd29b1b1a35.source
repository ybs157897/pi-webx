import { Flexbox, Text } from '@lobehub/ui';
import { App as AntApp } from 'antd';
import { useMemo } from 'react';

import type { UiNode, UiSpec } from '../../shared/uikit';
import { UiRenderer } from './UiRenderer';

const h = (v: string, level?: 1 | 2 | 3 | 4): UiNode => ({ t: 'title', v, ...(level ? { level } : {}) });
const p = (v: string): UiNode => ({ t: 'text', v });

const dashboard: UiSpec = {
  title: '数据看板',
  root: [
    {
      t: 'row',
      gap: 12,
      wrap: true,
      children: [
        { t: 'stat', label: '本月营收', value: 482910, unit: '元', trend: 'up', hint: '环比 +12.4%' },
        { t: 'stat', label: '活跃用户', value: 12893, unit: '人', trend: 'up', hint: '环比 +3.1%' },
        { t: 'stat', label: '退款金额', value: 15230, unit: '元', trend: 'down', hint: '环比 -1.8%' },
      ],
    },
    {
      t: 'card',
      title: '近 7 日趋势',
      children: [
        {
          t: 'chart',
          kind: 'area',
          height: 200,
          labels: ['周一', '周二', '周三', '周四', '周五', '周六', '周日'],
          series: [
            { name: '营收（千元）', data: [32, 45, 38, 61, 55, 72, 68] },
          ],
        },
      ],
    },
    {
      t: 'row',
      gap: 12,
      children: [
        {
          t: 'card',
          variant: 'flat',
          children: [
            {
              t: 'chart',
              kind: 'bar',
              height: 200,
              labels: ['华东', '华北', '华南', '西南'],
              series: [
                { name: '今年', data: [120, 98, 143, 66] },
                { name: '去年', data: [101, 88, 121, 71] },
              ],
            },
          ],
        },
        {
          t: 'card',
          variant: 'flat',
          children: [
            {
              t: 'chart',
              kind: 'pie',
              height: 200,
              labels: ['新客', '复购', '召回', '自然流量'],
              series: [{ name: '来源', data: [40, 30, 20, 10] }],
            },
          ],
        },
      ],
    },
  ],
};

const tableReport: UiSpec = {
  title: '任务清单',
  root: [
    h('项目进度', 3),
    p('下面是本周的任务执行情况，逾期两项已标出。'),
    {
      t: 'table',
      columns: [
        { k: 'name', title: '任务' },
        { k: 'owner', title: '负责人' },
        { k: 'status', title: '状态' },
        { k: 'progress', title: '进度' },
      ],
      rows: [
        { name: '登录鉴权重构', owner: 'yin', status: '进行中', progress: '70%' },
        { name: '账单导出', owner: 'chen', status: '逾期', progress: '40%' },
        { name: '消息中心', owner: 'li', status: '已完成', progress: '100%' },
        { name: '性能压测', owner: 'yin', status: '逾期', progress: '25%' },
      ],
    },
    { t: 'divider' },
    {
      t: 'desc',
      title: '汇总',
      cols: 2,
      items: [
        { k: '任务总数', v: 4 },
        { k: '完成率', v: '25%' },
        { k: '逾期数', v: 2 },
        { k: '负责人', v: 'yin / chen / li' },
      ],
    },
    { t: 'tags', items: ['高优先级', '本周', '需要复审'] },
  ],
};

const interaction: UiSpec = {
  title: '收集输入',
  root: [
    {
      t: 'callout',
      kind: 'warning',
      title: '需要确认',
      v: '检测到生产库的连接串写死在代码里，是否要我改成环境变量注入？',
    },
    {
      t: 'form',
      title: '部署参数',
      submit: '开始部署',
      action: '[部署确认] 请按以下参数执行部署',
      fields: [
        { t: 'input', k: 'env', label: '目标环境', ph: 'staging / production', required: true },
        { t: 'select', k: 'region', label: '区域', options: ['上海', '北京', '广州'] },
        { t: 'textarea', k: 'note', label: '备注', rows: 3 },
        { t: 'switch', k: 'dryRun', label: '先演练一次', checked: true },
        { t: 'checkbox', k: 'notify', label: '完成后通知我', checked: true },
      ],
    },
    { t: 'divider' },
    {
      t: 'btngroup',
      buttons: [
        { v: '改成环境变量', kind: 'primary', action: '请把连接串改成环境变量注入，并同步更新部署脚本。' },
        { v: '保持现状', action: '连接串保持现状，不做改动。' },
        { v: '先看改动范围', action: '列出所有写死连接串的位置，不要改动。' },
      ],
    },
  ],
};

const textShowcase: UiSpec = {
  title: '排版与代码',
  root: [
    { t: 'title', v: '一级标题', level: 1 },
    { t: 'title', v: '二级标题', level: 2 },
    p('普通段落，说明性的文字会以正文样式呈现。'),
    { t: 'text', v: '次要说明文字，用于补充信息。', kind: 'secondary' },
    { t: 'text', v: '加粗的关键结论。', kind: 'strong' },
    { t: 'text', v: 'npm run build', kind: 'code' },
    { t: 'md', v: '也支持 **Markdown**：列表、`行内代码`、[链接](https://example.com) 等。' },
    { t: 'callout', kind: 'info', v: 'info 提示条，用于一般性说明。' },
    { t: 'callout', kind: 'success', title: '成功', v: '构建通过，0 个错误。' },
    { t: 'callout', kind: 'error', v: '测试失败：2 个用例未通过。' },
    {
      t: 'code',
      lang: 'ts',
      v: 'export function greet(name: string): string {\n  return `hello, ${name}`;\n}',
    },
    {
      t: 'list',
      items: [
        '一项简单列表',
        { title: '带描述的列表项', desc: '补充说明会以次要文字展示。' },
        { title: '第二项', desc: '同样支持多行描述。' },
      ],
    },
  ],
};

const SECTIONS: { name: string; spec: UiSpec }[] = [
  { name: '数据看板（stat / chart / card / row）', spec: dashboard },
  { name: '表格与描述（table / desc / tags / divider）', spec: tableReport },
  { name: '交互（callout / form / btngroup）', spec: interaction },
  { name: '排版与代码（title / text / md / code / list）', spec: textShowcase },
];

/** Gallery proving every component kind renders — the 组件库 tab. */
export function UiShowcase({ onAction }: { onAction?: (action: string) => void }) {
  const { message } = AntApp.useApp();
  const sections = useMemo(() => SECTIONS, []);
  const handled = useMemo(
    () => (action: string) => {
      void message.info('演示模式：真实会话里会发送给 pi');
      onAction?.(action);
    },
    [message, onAction],
  );

  return (
    <Flexbox gap={20} style={{ padding: '20px 24px', overflowY: 'auto', height: '100%' }}>
      <Flexbox gap={4}>
        <Text fontSize={16} weight={600}>
          组件库
        </Text>
        <Text fontSize={12} type="secondary">
          agent 通过 render_ui 工具输出声明式 JSON，这里全部渲染为真实组件。共{' '}
          {SECTIONS.length} 组示例。
        </Text>
      </Flexbox>
      {sections.map((section) => (
        <Flexbox key={section.name} gap={10}>
          <Text fontSize={12} weight={600} type="secondary">
            {section.name}
          </Text>
          <UiRenderer spec={section.spec} onAction={handled} />
        </Flexbox>
      ))}
    </Flexbox>
  );
}
