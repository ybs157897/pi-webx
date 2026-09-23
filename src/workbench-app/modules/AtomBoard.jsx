/**
 * 「资料卡 + 时间轴」模块的共用实现，供宠物日记与亲密关系使用。
 * 两者数据结构同为 `{ profile, records }`，差异只在字段集与文案，
 * 因此由调用方用 `config` 描述字段，这里只负责交互与渲染。
 * props 见 Dashboard.jsx 顶部说明（另加 `module` 与 `config`）。
 * @module src/modules/AtomBoard
 */

import { useRef, useState } from 'react'
import { api } from '../api.mjs'
import { Avatar, Card, ConfirmDialog, Empty, Field, FieldGroup, FormModal, IconButton } from '../ui.jsx'
import { IconCamera, IconEdit, IconImage, IconPlus, IconTrash } from '../icons.jsx'
import { byDateDesc, formatDay, safeImageUrl, todayISO } from '../util.mjs'

const TEXT = {
  editProfile: '编辑资料',
  save: '保存',
  uploadAvatar: '上传头像',
  uploadPhoto: '上传照片',
  removePhoto: '移除照片',
  addRecord: '添加记录',
  editRecord: '编辑记录',
  recordTitle: '标题',
  date: '日期',
  note: '备注',
  photo: '照片',
  profileSaved: '资料已更新',
  avatarSaved: '头像已更新',
  recordCreated: '已添加记录',
  recordUpdated: '记录已更新',
  recordDeleted: '记录已删除',
  noRecords: '还没有记录',
  noRecordsHint: '记下今天的一件小事，时间轴就有内容了',
  noName: '还没起名字',
  noProfileNote: '还没有备注',
  needTitle: '先写一个标题',
  deleteRecord: '删除记录',
  deleteRecordMessage: '确定删除这条记录？删除后无法恢复。',
  uploading: '上传中…',
}

/** 资料卡字段（由 config 描述，新增/编辑共用）。 */
function ProfileFields({ config, value, onChange }) {
  const update = patch => onChange({ ...value, ...patch })
  return (
    <>
      <Field label={config.nameLabel}>
        <input className="input" value={value.name ?? ''} placeholder={config.namePlaceholder} onChange={event => update({ name: event.target.value })} />
      </Field>
      {config.profileFields.map(field => (
        <Field key={field.key} label={field.label}>
          <input
            className="input"
            type={field.type}
            value={value[field.key] ?? ''}
            placeholder={field.placeholder}
            onChange={event => update({ [field.key]: event.target.value })}
          />
        </Field>
      ))}
      <Field label={config.noteLabel}>
        <textarea className="textarea" value={value.note ?? ''} placeholder={config.notePlaceholder} onChange={event => update({ note: event.target.value })} />
      </Field>
    </>
  )
}

/** 时间轴记录字段（含照片上传）。 */
function RecordFields({ config, value, onChange, onUpload, uploading }) {
  const inputRef = useRef(null)
  const update = patch => onChange({ ...value, ...patch })
  const preview = safeImageUrl(value.photoUrl)
  return (
    <>
      <Field label={TEXT.recordTitle}>
        <input className="input" value={value.title} placeholder={config.recordTitlePlaceholder} onChange={event => update({ title: event.target.value })} />
      </Field>
      <Field label={TEXT.date}>
        <input type="date" className="input" value={value.date} onChange={event => update({ date: event.target.value })} />
      </Field>
      <Field label={config.noteLabel}>
        <textarea className="textarea" value={value.note} onChange={event => update({ note: event.target.value })} />
      </Field>
      <FieldGroup label={TEXT.photo} hint="可留空；支持 png / jpeg / webp / gif，单张不超过 5MB">
        <div className="row-wrap">
          <button type="button" className="btn btn-sm" disabled={uploading} onClick={() => inputRef.current?.click()}>
            <IconImage size={15} /> {uploading ? TEXT.uploading : TEXT.uploadPhoto}
          </button>
          {preview !== '' && (
            <>
              <img className="timeline-photo" style={{ marginTop: 0, maxHeight: '64px' }} src={preview} alt="已上传的照片" />
              <button type="button" className="btn btn-sm btn-danger" onClick={() => update({ photoUrl: '' })}>{TEXT.removePhoto}</button>
            </>
          )}
        </div>
      </FieldGroup>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        style={{ display: 'none' }}
        onChange={event => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file !== undefined) onUpload(file)
        }}
      />
    </>
  )
}

export default function AtomBoard({ module, data, mutate, notify, config }) {
  const today = todayISO()
  const atom = data[module]
  const avatarRef = useRef(null)
  const [editingProfile, setEditingProfile] = useState(false)
  const [profileDraft, setProfileDraft] = useState(atom.profile)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState(null)
  const [pendingDelete, setPendingDelete] = useState(null)
  const [busy, setBusy] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [draft, setDraft] = useState({ title: '', date: today, note: '', photoUrl: '' })

  const records = [...atom.records].sort(byDateDesc(record => record.date))

  /** 上传一张图并返回同源 URL；失败时提示并返回空串。 */
  async function uploadPhoto(file) {
    setUploading(true)
    let url = ''
    try {
      url = await api.upload(file)
    } catch (error) {
      notify(String(error?.message ?? error), 'error')
    }
    setUploading(false)
    return url
  }

  async function changeAvatar(event) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file === undefined) return
    setUploading(true)
    await mutate(async () => {
      const url = await api.upload(file)
      await api.putAtomProfile(module, { avatarUrl: url })
    }, TEXT.avatarSaved)
    setUploading(false)
  }

  async function saveProfile() {
    setBusy(true)
    const ok = await mutate(() => api.putAtomProfile(module, { ...profileDraft, avatarUrl: atom.profile.avatarUrl ?? '' }), TEXT.profileSaved)
    setBusy(false)
    if (ok) setEditingProfile(false)
  }

  async function submitAdd() {
    if (draft.title.trim() === '') {
      notify(TEXT.needTitle, 'warn')
      return
    }
    setBusy(true)
    const ok = await mutate(
      () => api.addAtomRecord(module, { title: draft.title.trim(), date: draft.date === '' ? today : draft.date, note: draft.note, photoUrl: draft.photoUrl }),
      TEXT.recordCreated,
    )
    setBusy(false)
    if (ok) {
      setAdding(false)
      setDraft({ title: '', date: today, note: '', photoUrl: '' })
    }
  }

  async function submitEdit() {
    if (editing.title.trim() === '') {
      notify(TEXT.needTitle, 'warn')
      return
    }
    setBusy(true)
    const ok = await mutate(
      () => api.patchAtomRecord(module, editing.id, {
        title: editing.title.trim(), date: editing.date === '' ? today : editing.date, note: editing.note, photoUrl: editing.photoUrl,
      }),
      TEXT.recordUpdated,
    )
    setBusy(false)
    if (ok) setEditing(null)
  }

  async function confirmDelete() {
    setBusy(true)
    const ok = await mutate(() => api.removeAtomRecord(module, pendingDelete.id), TEXT.recordDeleted)
    setBusy(false)
    if (ok) setPendingDelete(null)
  }

  const summary = config.summary(atom.profile)

  return (
    <>
      <div className="atom-grid">
        <Card title={config.profileLabel}>
          <div className="atom-profile">
            <Avatar src={atom.profile.avatarUrl} name={atom.profile.name} size={96} />
            <div>
              <p className="atom-name">{atom.profile.name === '' || atom.profile.name === undefined ? TEXT.noName : atom.profile.name}</p>
              <p className="small muted">{summary === '' ? config.profileHint : summary}</p>
            </div>
            <div className="row" style={{ gap: '8px' }}>
              <button type="button" className="btn btn-sm" disabled={uploading} onClick={() => avatarRef.current?.click()}>
                <IconCamera size={15} /> {uploading ? TEXT.uploading : TEXT.uploadAvatar}
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  setProfileDraft({ ...atom.profile })
                  setEditingProfile(true)
                }}
              >
                <IconEdit size={15} /> {TEXT.editProfile}
              </button>
            </div>
            <input
              ref={avatarRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              style={{ display: 'none' }}
              onChange={changeAvatar}
            />
            <dl className="atom-meta">
              {config.profileFields.map(field => (
                <div className="atom-meta-row" key={field.key}>
                  <dt className="atom-meta-key">{field.label}</dt>
                  <dd className="atom-meta-value">{config.display(field.key, atom.profile[field.key])}</dd>
                </div>
              ))}
              <div className="atom-meta-row">
                <dt className="atom-meta-key">{config.noteLabel}</dt>
                <dd className="atom-meta-value">{atom.profile.note === '' || atom.profile.note === undefined ? TEXT.noProfileNote : atom.profile.note}</dd>
              </div>
            </dl>
          </div>
        </Card>

        <Card
          title={config.recordLabel}
          subtitle={`共 ${records.length} 条`}
          action={(
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>
              <IconPlus size={15} /> {TEXT.addRecord}
            </button>
          )}
        >
          {records.length === 0
            ? <Empty icon={<IconCamera size={22} />} title={TEXT.noRecords} hint={TEXT.noRecordsHint} />
            : (
              <ul className="timeline">
                {records.map(record => {
                  const photo = safeImageUrl(record.photoUrl)
                  return (
                  <li className="timeline-item" key={record.id}>
                    <span className="timeline-dot" aria-hidden="true" />
                    <div className="timeline-card">
                      <div className="timeline-head">
                        <p className="timeline-title break">{record.title}</p>
                        <span className="timeline-date">{formatDay(record.date, 'full')}</span>
                      </div>
                      {record.note !== '' && <p className="timeline-note">{record.note}</p>}
                      {photo !== '' && (
                        <a href={photo} target="_blank" rel="noreferrer noopener">
                          <img className="timeline-photo" src={photo} alt={record.title} loading="lazy" />
                        </a>
                      )}
                      <div className="timeline-actions">
                        <IconButton label={TEXT.editRecord} onClick={() => setEditing({ ...record })}>
                          <IconEdit size={16} />
                        </IconButton>
                        <IconButton label="删除" tone="danger" onClick={() => setPendingDelete(record)}>
                          <IconTrash size={16} />
                        </IconButton>
                      </div>
                    </div>
                  </li>
                  )
                })}
              </ul>
            )}
        </Card>
      </div>

      <FormModal
        open={editingProfile}
        title={config.editProfileTitle}
        submitText={TEXT.save}
        busy={busy}
        onClose={() => setEditingProfile(false)}
        onSubmit={saveProfile}
      >
        <ProfileFields config={config} value={profileDraft} onChange={setProfileDraft} />
      </FormModal>

      <FormModal open={adding} title={TEXT.addRecord} submitText={TEXT.save} busy={busy} onClose={() => setAdding(false)} onSubmit={submitAdd}>
        <RecordFields
          config={config}
          value={draft}
          onChange={setDraft}
          uploading={uploading}
          onUpload={async file => {
            const url = await uploadPhoto(file)
            if (url !== '') setDraft(current => ({ ...current, photoUrl: url }))
          }}
        />
      </FormModal>

      <FormModal open={editing !== null} title={TEXT.editRecord} submitText={TEXT.save} busy={busy} onClose={() => setEditing(null)} onSubmit={submitEdit}>
        {editing !== null && (
          <RecordFields
            config={config}
            value={editing}
            onChange={setEditing}
            uploading={uploading}
            onUpload={async file => {
              const url = await uploadPhoto(file)
              if (url !== '') setEditing(current => ({ ...current, photoUrl: url }))
            }}
          />
        )}
      </FormModal>

      <ConfirmDialog
        open={pendingDelete !== null}
        title={TEXT.deleteRecord}
        message={pendingDelete === null ? '' : `「${pendingDelete.title}」${TEXT.deleteRecordMessage}`}
        busy={busy}
        onCancel={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
      />
    </>
  )
}
