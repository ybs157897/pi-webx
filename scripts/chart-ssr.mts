import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';

import { UiChart } from '../src/components/uikit/UiChart';

const html = renderToString(
  h(UiChart, {
    kind: 'line',
    labels: ['周一', '周二', '周三', '周四', '周五', '周六', '周日'],
    series: [{ name: '订单量', data: [1020, 1150, 980, 1210, 1320, 1284, 1420] }],
    height: 260,
  }),
);
const paths = (html.match(/<path/g) ?? []).length;
const svgs = (html.match(/<svg/g) ?? []).length;
console.log('svgs:', svgs, 'paths:', paths, 'empty:', html.includes('暂无数据'), 'len:', html.length);
console.log(html.slice(0, 220));
