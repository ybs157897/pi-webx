/**
 * 设置面板：外观（主题 / 密度）、数据（导入导出 / 演示数据）、快捷键表。
 * 从各页面右上角收回来的「数据导入/导出」安放在此——运维操作不再占门面。
 * （AI 对话改为全屏浮层后不再有「默认开合」偏好，该项已移除。）
 * @module shell/SettingsSheet
 */

import { useRef, useState } from 'react'
import { Modal, Segmented } from '../ui.jsx'
import { IconTrash, IconUpload } from '../icons.jsx'

const THEME_OPTIONS = [
  { value: 'auto', label: '跟随系统' },
  { value: 'light', label: '亮色' },
  { value: 'dark', label: '暗色' },
]

const DENSITY_OPTIONS = [
  { value: 'comfortable', label: '舒适' },
  { value: 'compact', label: '紧凑' },
]

const SHORTCUTS = [
  ['⌘K / Ctrl+K', '打开命令面板（搜索、跳转、执行命令）'],
  ['⌘1 … ⌘7', '切换到对应模块'],
  ['Esc', '关闭面板、弹窗与命令面板'],
  ['Enter / Shift+Enter', '在 AI 副驾里发送 / 换行'],
]

export default function SettingsSheet({
  open, prefs, setPref, onExport, onImport, onLoadDemo, onClearAll, onClose,
}) {
  const [confirmClear, setConfirmClear] = useState(false)
  const fileRef = useRef(null)

  return (
    <Modal open={open} title="设置" onClose={onClose} wide>
      <section style={{ marginBottom: 24 }}>
        <h3 className="card-title" style={{ marginBottom: 12 }}>外观</h3>
        <div className="form-row">
          <div className="field">
            <span className="field-label">主题</span>
            <Segmented options={THEME_OPTIONS} value={prefs.theme ?? 'auto'} onChange={value => setPref('theme', value)} label="主题" />
          </div>
          <div className="field">
            <span className="field-label">密度</span>
            <Segmented options={DENSITY_OPTIONS} value={prefs.density ?? 'comfortable'} onChange={value => setPref('density', value)} label="密度" />
          </div>
        </div>
      </section>

      <section style={{ marginBottom: 24 }}>
        <h3 className="card-title" style={{ marginBottom: 12 }}>数据</h3>
        <p className="small muted" style={{ marginBottom: 12 }}>
          全部模块的数据保存在本机 SQLite。直接导入旧版 JSON 不包含图片文件；配套 pi-webx 的迁移脚本可连同旧图片一起搬迁，原文件不会被修改。
        </p>
        <div className="form-row">
          <button type="button" className="btn" onClick={onExport}>
            <IconUpload size={15} />导出 JSON 备份
          </button>
          <button type="button" className="btn" onClick={() => fileRef.current?.click()}>
            导入工作台 JSON
          </button>
          <button type="button" className="btn" onClick={onLoadDemo}>灌入演示数据</button>
          <button type="button" className="btn" style={{ color: 'var(--danger)' }} onClick={() => setConfirmClear(true)}>
            <IconTrash size={15} />清空全部数据
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          style={{ display: 'none' }}
          onChange={event => { onImport(event); event.target.value = '' }}
        />
      </section>

      <section>
        <h3 className="card-title" style={{ marginBottom: 12 }}>快捷键</h3>
        <div className="list">
          {SHORTCUTS.map(([keys, description]) => (
            <div className="list-item" key={keys}>
              <kbd>{keys}</kbd>
              <span className="small muted">{description}</span>
            </div>
          ))}
        </div>
      </section>

      <Modal
        open={confirmClear}
        title="清空全部数据"
        onClose={() => setConfirmClear(false)}
        footer={(
          <>
            <button type="button" className="btn" onClick={() => setConfirmClear(false)}>取消</button>
            <button
              type="button"
              className="btn btn-danger-solid"
              onClick={() => { setConfirmClear(false); onClearAll(); onClose() }}
            >
              确认清空
            </button>
          </>
        )}
      >
        <p className="confirm-message">
          将删除本机 SQLite 中的全部工作台记录（保留你的昵称与偏好设置）。此操作不可撤销，建议先导出备份。确定继续？
        </p>
      </Modal>
    </Modal>
  )
}
