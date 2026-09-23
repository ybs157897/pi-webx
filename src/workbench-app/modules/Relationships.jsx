/**
 * 亲密关系：资料卡（头像、名字、纪念日、备注）+ 时间轴记录。
 * 交互与渲染复用 AtomBoard，这里只描述字段与中文文案。
 * props 见 Dashboard.jsx 顶部说明。
 * @module src/modules/Relationships
 */

import AtomBoard from './AtomBoard.jsx'
import { diffDays, formatDay } from '../util.mjs'

const CONFIG = {
  profileLabel: '关系资料',
  editProfileTitle: '编辑关系资料',
  nameLabel: '名字',
  namePlaceholder: 'TA 的名字',
  profileHint: '写下纪念日，就能一直数着过',
  profileFields: [
    { key: 'since', label: '纪念日', type: 'date' },
  ],
  noteLabel: '备注',
  notePlaceholder: '喜欢什么、在意什么、想一起做的事',
  recordLabel: '时间轴',
  recordTitlePlaceholder: '今天一起做了什么',
  /** 资料卡副标题：在一起多少天。 */
  summary: profile => {
    const days = diffDays(profile.since)
    if (days === null || days < 0) return ''
    return `在一起 ${days} 天`
  },
  /** 资料行的显示值。 */
  display: (key, value) => {
    if (value === undefined || value === null || value === '') return '未填写'
    if (key === 'since') {
      const days = diffDays(value)
      return days === null || days < 0 ? formatDay(value) : `${formatDay(value)} · 第 ${days} 天`
    }
    return String(value)
  },
}

export default function Relationships({ data, mutate, notify }) {
  return <AtomBoard module="relationships" data={data} mutate={mutate} notify={notify} config={CONFIG} />
}
