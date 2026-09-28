

import { api } from '../../api.mjs'

import { TEXT, refsOf, titleOf, bodyOf, parseTags, buildRefs } from './model.jsx'

export function createKnowledgeActions({
  setKeyword, setActiveTag, setActiveSource, setStage, setPref,
  dirty, selected, setPendingNavigation, setSelectedBaseId, setSelectedFolderId,
  selectedId, setSelectedId, rows, setListOpen, navigate,
  pendingNavigation, draft, notify, baseRows, setBusy,
  mutate, setSaved, setLinksToken, selectedBase, selectedBaseId,
  selectedFolderId, pendingId, baseForm, setBaseForm, folderForm,
  baseFolders, setFolderForm, pendingBaseDelete, setPendingBaseDelete, pendingFolderDelete,
  setPendingFolderDelete, pendingDelete, setPendingDelete, onLoadDemo, setDemoBusy,
  askAI, seedId,
}) {
  function clearFilters() {
    setKeyword('')
    setActiveTag('')
    setActiveSource('')
  }

  function switchStage(next) {
    setStage(next)
    if (typeof setPref === 'function') setPref('kbStage', next)
  }

  function openBase(id, skipGuard = false) {
    if (!skipGuard && dirty && selected !== null && selected.knowledgeBaseId !== id) {
      setPendingNavigation({ kind: 'base', id })
      return
    }
    setSelectedBaseId(id)
    setSelectedFolderId('')
    switchStage('documents')
    clearFilters()
    if (typeof setPref === 'function') setPref('kbBaseId', id)
  }

  function backToBases() { switchStage('bases') }

  function openFolder(id) {
    setSelectedFolderId(id)
    clearFilters()
  }

  /** 切笔记先处理未保存内容；新笔记单独进入编辑态。 */
  function selectNote(id, skipGuard = false, edit = false) {
    if (!skipGuard && dirty && selectedId !== '' && selectedId !== id) {
      setPendingNavigation({ kind: 'note', id })
      return
    }
    setSelectedId(id)
    const row = rows.find(item => item.id === id)
    if (row?.knowledgeBaseId) {
      setSelectedBaseId(row.knowledgeBaseId)
      setSelectedFolderId(String(row.folderId ?? ''))
      if (typeof setPref === 'function') setPref('kbBaseId', row.knowledgeBaseId)
    }
    switchStage(id === '' ? 'documents' : 'reading')
    setListOpen(false)
    if (typeof setPref === 'function') setPref('kbSelectedId', id)
    if (id !== '') switchView(edit ? 'edit' : 'preview')
  }

  /** 回文档列表保留草稿；换篇时才检查是否丢弃。 */
  function backToHome() {
    switchStage('documents')
  }

  /** 编辑 / 预览切换：视图偏好照 Works 的写法直接落 prefs。 */
  function switchView(next) {
    if (typeof setPref === 'function') setPref('kbView', next)
  }

  /** 打开一条链接：知识库链接就地选中（进阅读态），跨模块链接跳对应模块。 */
  function openLink(link) {
    if (link.module === 'knowledge') {
      selectNote(link.id)
      return
    }
    if (dirty) {
      setPendingNavigation({ kind: 'link', link })
      return
    }
    if (typeof navigate === 'function') navigate(link.module)
  }

  function confirmNavigation() {
    const next = pendingNavigation
    setPendingNavigation(null)
    if (next?.kind === 'note') selectNote(next.id, true)
    if (next?.kind === 'create') createNote(true)
    if (next?.kind === 'base') openBase(next.id, true)
    if (next?.kind === 'link' && typeof navigate === 'function') navigate(next.link.module)
  }

  async function save() {
    if (selected === null || draft === null) return false
    const title = draft.title.trim()
    if (title === '') {
      notify(TEXT.needTitle, 'warn')
      return false
    }
    const nextTags = parseTags(draft.tags)
    if (nextTags.length > 8) {
      notify(TEXT.tagsLimit, 'warn')
      return false
    }
    const body = draft.body.trim()
    if (body.length > 50000) {
      notify(TEXT.bodyLimit, 'warn')
      return false
    }
    const nextRefs = buildRefs(baseRows, body, selected.id, refsOf(selected))
    if (nextRefs.length > 20) {
      notify(TEXT.refsLimit, 'warn')
      return false
    }
    setBusy(true)
    const ok = await mutate(
      () => api.patchRecord('knowledge', selected.id, { title, body, tags: nextTags, refs: nextRefs }),
      TEXT.saved,
    )
    setBusy(false)
    if (!ok) return false
    // 以用户输入为基线，trim 掉的空格不再点亮脏标记。
    setSaved({ ...draft })
    // 保存可能改了 refs：服务端链接图谱跟着重拉一次。
    setLinksToken(token => token + 1)
    return true
  }

  async function createNote(skipGuard = false) {
    if (selectedBase === null) return
    if (!skipGuard && dirty) {
      setPendingNavigation({ kind: 'create' })
      return
    }
    setBusy(true)
    const ok = await mutate(async () => {
      const created = await api.addRecord('knowledge', { title: TEXT.newTitle, knowledgeBaseId: selectedBaseId, folderId: selectedFolderId })
      pendingId.current = String(created?.record?.id ?? '')
      return created
    }, TEXT.created)
    setBusy(false)
    if (!ok) return
    // 新建后选中并直接落编辑视图（空笔记预览没有意义），清掉过滤保证卡片可见。
    selectNote(pendingId.current, true, true)
    clearFilters()
  }

  async function saveBaseForm() {
    if (baseForm === null) return
    if (!baseForm.id && dirty) { notify('请先保存当前文档，再新建知识库', 'warn'); return }
    const title = baseForm.title.trim()
    if (title === '') { notify('先填写知识库名称', 'warn'); return }
    const description = baseForm.description.trim()
    let createdId = ''
    setBusy(true)
    const ok = await mutate(async () => {
      if (baseForm.id) return api.patchRecord('knowledgeBases', baseForm.id, { title, description })
      const result = await api.addRecord('knowledgeBases', { title, description })
      createdId = String(result?.record?.id ?? '')
      return result
    }, baseForm.id ? '知识库已更新' : '知识库已创建')
    setBusy(false)
    if (!ok) return
    setBaseForm(null)
    if (createdId !== '') openBase(createdId, true)
  }

  async function saveFolderForm() {
    if (folderForm === null || selectedBase === null) return
    const title = folderForm.title.trim()
    if (title === '') { notify('先填写目录名称', 'warn'); return }
    const parentId = folderForm.id ? String(baseFolders.find(item => item.id === folderForm.id)?.parentId ?? '') : selectedFolderId
    if (baseFolders.some(item => item.id !== folderForm.id && item.parentId === parentId && titleOf(item) === title)) {
      notify('同一位置已有这个目录', 'warn')
      return
    }
    setBusy(true)
    const ok = await mutate(() => folderForm.id
      ? api.patchRecord('knowledgeFolders', folderForm.id, { title })
      : api.addRecord('knowledgeFolders', { title, knowledgeBaseId: selectedBaseId, parentId }), folderForm.id ? '目录已重命名' : '目录已创建')
    setBusy(false)
    if (ok) setFolderForm(null)
  }

  async function confirmBaseDelete() {
    if (pendingBaseDelete === null) return
    setBusy(true)
    const ok = await mutate(() => api.removeRecord('knowledgeBases', pendingBaseDelete.id), '知识库已删除')
    setBusy(false)
    if (!ok) return
    if (selectedBaseId === pendingBaseDelete.id) {
      setSelectedBaseId('')
      setSelectedId('')
      if (typeof setPref === 'function') { setPref('kbBaseId', ''); setPref('kbSelectedId', '') }
      switchStage('bases')
    }
    setPendingBaseDelete(null)
  }

  async function confirmFolderDelete() {
    if (pendingFolderDelete === null) return
    setBusy(true)
    const ok = await mutate(() => api.removeRecord('knowledgeFolders', pendingFolderDelete.id), '目录已删除')
    setBusy(false)
    if (!ok) return
    setSelectedFolderId(String(pendingFolderDelete.parentId ?? ''))
    setPendingFolderDelete(null)
  }

  async function moveSelectedDocument(folderId) {
    if (selected === null || folderId === String(selected.folderId ?? '')) return
    if (dirty) { notify('请先保存这篇文档，再移动目录', 'warn'); return }
    setBusy(true)
    const ok = await mutate(() => api.patchRecord('knowledge', selected.id, { folderId }), '文档已移动')
    setBusy(false)
    if (ok) setSelectedFolderId(folderId)
  }

  function toggleStar() {
    if (selected === null) return undefined
    const on = selected.starred === true
    return mutate(
      () => api.patchRecord('knowledge', selected.id, { starred: !on }),
      on ? '已取消星标' : '已加星标',
    )
  }

  async function confirmDelete() {
    const target = pendingDelete
    setBusy(true)
    const ok = await mutate(() => api.removeRecord('knowledge', target.id), TEXT.deleted)
    setBusy(false)
    if (!ok) return
    setPendingDelete(null)
    // 删掉的正是读着的那条：清选中回首页（种子重播会清掉草稿）。
    if (target.id === selectedId) selectNote('', true)
  }

  async function loadDemo() {
    if (typeof onLoadDemo !== 'function') return
    setDemoBusy(true)
    await onLoadDemo()
    setDemoBusy(false)
  }

  /** 「问小台」：把当前草稿的标题 + 正文送进 AI 副驾（没接线时按钮是禁用的）。 */
  function askAboutNote() {
    if (typeof askAI !== 'function' || selected === null) return
    const body = draft !== null && seedId === selected.id ? draft.body : bodyOf(selected)
    askAI(`【知识库笔记】${titleOf(selected)}\n\n${body}`)
  }

  return { clearFilters, switchStage, openBase, backToBases, openFolder, selectNote, backToHome, switchView, openLink, confirmNavigation, save, createNote, saveBaseForm, saveFolderForm, confirmBaseDelete, confirmFolderDelete, moveSelectedDocument, toggleStar, confirmDelete, loadDemo, askAboutNote }
}
