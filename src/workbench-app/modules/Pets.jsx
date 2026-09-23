/**
 * 宠物日记：宠物资料卡（头像、名字、物种、生日、备注）+ 时间轴记录。
 * 交互与渲染复用 AtomBoard，这里只描述字段与中文文案。
 * props 见 Dashboard.jsx 顶部说明。
 * @module src/modules/Pets
 */

import AtomBoard from './AtomBoard.jsx'
import { diffDays, formatDay, parseDay, todayISO } from '../util.mjs'

/** 生日 → 「1 岁 3 个月」这类年龄说法；不足一个月按天说。 */
function ageText(birthday) {
  const birth = parseDay(birthday)
  const today = parseDay(todayISO())
  if (Number.isNaN(birth.getTime()) || birth > today) return ''
  const days = diffDays(birthday) ?? 0
  if (days < 31) return `${days} 天`
  let months = (today.getFullYear() - birth.getFullYear()) * 12 + (today.getMonth() - birth.getMonth())
  if (today.getDate() < birth.getDate()) months -= 1
  const years = Math.floor(months / 12)
  const rest = months % 12
  if (years === 0) return `${months} 个月`
  return rest === 0 ? `${years} 岁` : `${years} 岁 ${rest} 个月`
}

const CONFIG = {
  profileLabel: '宠物资料',
  editProfileTitle: '编辑宠物资料',
  nameLabel: '名字',
  namePlaceholder: '旺财',
  profileHint: '补上名字和生日，就是它的小档案',
  profileFields: [
    { key: 'species', label: '物种', type: 'text', placeholder: '猫 / 狗 / 仓鼠' },
    { key: 'birthday', label: '生日', type: 'date' },
  ],
  noteLabel: '备注',
  notePlaceholder: '喜欢什么、害怕什么、有什么小习惯',
  recordLabel: '日记时间轴',
  recordTitlePlaceholder: '今天做了什么',
  /** 资料卡副标题。 */
  summary: profile => {
    const age = ageText(profile.birthday)
    if (age === '') return ''
    return `${age} · 陪伴 ${diffDays(profile.birthday) ?? 0} 天`
  },
  /** 资料行的显示值。 */
  display: (key, value) => {
    if (value === undefined || value === null || value === '') return '未填写'
    if (key === 'birthday') {
      const age = ageText(value)
      return age === '' ? formatDay(value) : `${formatDay(value)} · ${age}`
    }
    return String(value)
  },
}

export default function Pets({ data, mutate, notify }) {
  return <AtomBoard module="pets" data={data} mutate={mutate} notify={notify} config={CONFIG} />
}
