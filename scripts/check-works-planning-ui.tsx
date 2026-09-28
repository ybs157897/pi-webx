import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Agenda from '../src/workbench-app/modules/works/Agenda.jsx';
import RecordDialogs from '../src/workbench-app/modules/works/RecordDialogs.jsx';
import { scheduleGroups } from '../src/workbench-app/modules/works/schedule.mjs';

const works = [
  { id: 'later', title: '写周报', status: 'todo', scheduledDate: '2026-09-30', startTime: '11:00', endTime: '12:00' },
  { id: 'early', title: '完成接口设计', status: 'doing', scheduledDate: '2026-09-30', startTime: '09:00', endTime: '10:30', note: '先完成最重要的工作' },
  { id: 'legacy', title: '旧工作记录', status: 'todo' },
  { id: 'done', title: '已完成事项', status: 'done', scheduledDate: '2026-09-29', startTime: '09:00', endTime: '10:00' },
];
const groups = scheduleGroups(works);
assert.deepEqual(groups.days.map(group => group.entries.map(row => row.id)), [['early', 'later']]);
assert.deepEqual(groups.unscheduled.map(row => row.id), ['legacy']);
assert.equal(scheduleGroups(works, true).days.length, 2);
const markup = renderToStaticMarkup(h(Agenda, { works }));
assert.equal(markup.split('data-testid="works-agenda-entry"').length - 1, 2);
assert.ok(markup.indexOf('完成接口设计') < markup.indexOf('写周报'));
assert.ok(markup.includes('09:00') && markup.includes('10:30') && markup.includes('2026-09-30'));
assert.ok(markup.includes('data-testid="works-unscheduled"') && markup.includes('旧工作记录'));
assert.ok(!markup.includes('已完成事项'));
const dialog = renderToStaticMarkup(h(RecordDialogs, {
  form: { id: 'early', title: '接口设计', status: 'todo', note: '', tags: '', scheduledDate: '2026-09-30', startTime: '09:00', endTime: '10:30' },
  busy: false, pendingDelete: null, setForm() {}, submitForm() {}, setPendingDelete() {}, confirmDelete() {},
}));
assert.ok(dialog.includes('data-testid="works-schedule-date"') && dialog.includes('value="2026-09-30"'));
assert.ok(dialog.includes('data-testid="works-schedule-start"') && dialog.includes('value="09:00"'));
assert.ok(dialog.includes('data-testid="works-schedule-clear"'));
console.log('works planning UI: sorted time blocks, legacy unscheduled records, completed filter and schedule editing passed');
