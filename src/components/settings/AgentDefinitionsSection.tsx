/**
 * 子智能体设置页 —— 按 ZCode 的「设置 → 子智能体」1:1 复刻。
 *
 * 规格：`/tmp/pi-webx-subagents-implementation/zcode-ui-spec.md`，上游
 * `zai-org/ZCode@872ad960`。所有中文文案逐字取自其
 * `packages/ui/src/i18n/locales/zh-CN.ts:3314-3394`；结构、字段顺序、控件与交互
 * 对照 `packages/ui/src/settings/SubagentsSection.tsx`（行号见各段注释）。
 *
 * 三处**有意偏离**上游：
 *   1. 空态：上游无搜索词且无数据时不渲染空态（:1713/:1767），我们保留自己的；
 *   2. 模型行：上游有「主模型/轻量模型」，我们没有对应概念，沿用「继承当前对话/指定模型」；
 *   3. 表单说明句：上游写「…用户级 Markdown profile 目录」，我们按事实写 JSON 配置文件。
 *
 * 形态是**列表态 ⇄ 表单态整页互斥切换**（上游 `isFormView`，:1629），不是同屏两栏。
 * 最大轮数与并发上限**不再渲染**，但仍在草稿里原样保留并提交（上游 :1020-1024 语义）。
 *
 * 这个文件只负责渲染：三路读取在 `use-agent-catalog.ts`，编辑状态机与写操作在
 * `use-agent-form.ts`，可复用的表单/行零件在 `AgentDefinitionParts.tsx`。
 * 表单字段的渲染顺序、只读行的分支与删除弹窗的原文留在这里，`check-agent-definitions-ui.ts`
 * 逐字断言的就是这些。
 */

import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  AgentDefinition,
  AgentToolOption,
} from '../../shared/agent-definitions'
import { type PiThinkingLevel } from '../../shared/protocol'
import {
  catalogLabels,
  catalogModels,
  thinkingLevelsForModel,
} from '../../lib/modelCatalog'
import {
  Button,
  IconAgentPresetOutline16,
  IconChevronLeftOutline14,
  IconPlusOutline16,
  IconRefreshOutline16,
  IconSearchOutline16,
  Modal,
} from '../../ui/primitives/index.ts'
import {
  addToolName,
  agentDefinitionCounts,
  clearToolNames,
  decodeModelSelection,
  encodeModelSelection,
  groupAgentDefinitions,
  initialSelectedToolsForCustom,
  marksUnavailableModel,
  modelSelectionValue,
  removeToolName,
  selectAllToolNames,
  selectedToolNames,
  toggleAgentColor,
} from './agent-definitions-form.ts'
import {
  AgentColorPicker,
  AgentFormIssues,
  AgentRowActions,
  DiscardDialog,
  Field,
  NoticeLine,
  ToolCheckbox,
} from './AgentDefinitionParts.tsx'
import { useAgentCatalog } from './use-agent-catalog.ts'
import { useAgentForm } from './use-agent-form.ts'
import styles from './AgentDefinitionsSection.module.css'

/** Props of {@link AgentDefinitionsSection}. */
export interface AgentDefinitionsSectionProps {
  /** Current session, when the app already has one; the tool catalog is per-session. */
  sessionId?: string
}

/** Copy verbatim from the reference locale (zh-CN.ts:3314-3394). */
const COPY = {
  title: '子智能体',
  searchPlaceholder: '搜索子智能体...',
  empty: '没有找到子智能体',
  addNew: '新建子智能体',
  addDescription: '填写子智能体名称、工具和系统提示词，保存后返回列表。',
  edit: '编辑子智能体',
  editDescription: '修改子智能体配置，保存后返回列表。',
  backToList: '返回',
  noDescription: '暂无描述',
  groupBuiltIn: '内置子智能体',
  groupBuiltInHint: '内置 profile 是运行时默认能力，当前不可在这里编辑。',
  groupUser: '已安装',
  toolsAll: '全部工具',
  deleteTitle: '删除子智能体',
  formDescription: '保存后会写入运行时实际读取的子智能体配置文件。',
  nameLabel: '名称',
  namePlaceholder: 'code-reviewer',
  colorLabel: '颜色标记',
  modelLabel: '模型',
  descriptionLabel: '描述',
  descriptionPlaceholder: '展示给模型的简短说明',
  toolsLabel: '可用工具',
  toolsModeAll: '默认所有权限',
  toolsModeCustom: '自定义可用工具',
  toolsCardTitle: '控制该子智能体可以调用的工具范围。',
  /* task-70 made read-only tools exempt from the parent's tool surface. The
     form's hint used to say nothing about it, which implied a limit that no
     longer applies to `read/grep/find/ls`. */
  toolsCardHint:
    '只读工具（read/grep/find/ls）不受当前对话工具面限制；其它自定义工具仍以当前对话可用范围为上限。',
  systemPromptLabel: '系统提示词',
  systemPromptPlaceholder: '描述这个子智能体的角色、边界和规则...',
  injectAgentsMdLabel: '注入 AGENTS.md',
  modelInherit: '继承当前对话',
  modelFixed: '指定模型',
  modelLoadFailed: '模型列表加载失败。',
} as const

/**
 * Render the sub-agent settings section.
 * @param props - the optional session id used to scope the tool catalog.
 * @returns the section content column.
 */
export function AgentDefinitionsSection({ sessionId }: AgentDefinitionsSectionProps): ReactNode {
  const { listed, setListed, listLoading, listError, loadDefinitions, models, loadModels, tools, loadTools } =
    useAgentCatalog(sessionId)

  const [query, setQuery] = useState('')
  const [extraToolInput, setExtraToolInput] = useState('')

  const agents = listed?.agents ?? []
  const revision = listed?.revision

  /* Built-ins are product-shipped and read-only; split them out before anything
     else so they never enter the form and never carry an enable switch. */
  const grouped = useMemo(() => groupAgentDefinitions(agents), [agents])

  /* Only the user's own definitions are siblings for the duplicate-name check: a
     definition of the same name shadows a built-in on purpose. */
  const {
    editing,
    showForm,
    draft,
    problems,
    busy,
    notice,
    formError,
    confirmDiscard,
    confirmDelete,
    update,
    guardDirty,
    openNew,
    openExisting,
    backToList,
    save,
    toggleEnabled,
    doDelete,
    setNotice,
    setConfirmDiscard,
    setConfirmDelete,
  } = useAgentForm({ revision, userAgents: grouped.user, setListed, loadDefinitions })

  const matched = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle.length === 0) return grouped
    const keep = (agent: AgentDefinition): boolean =>
      agent.name.toLowerCase().includes(needle) ||
      agent.description.toLowerCase().includes(needle)
    return { builtin: grouped.builtin.filter(keep), user: grouped.user.filter(keep) }
  }, [grouped, query])

  /* Filtering is what decides the empty states, not the raw listing: built-ins
     mean the list is never empty before a search, so "nothing here yet" can no
     longer be inferred from `agents.length`. */
  const hasSearch = query.trim().length > 0
  const noMatches = matched.builtin.length === 0 && matched.user.length === 0
  const noUserAgents = grouped.user.length === 0

  const counts = useMemo(() => agentDefinitionCounts(agents), [agents])

  const modelNames = useMemo(() => catalogLabels(models.value), [models.value])
  const allModels = useMemo(() => catalogModels(models.value), [models.value])
  const selectedModel = useMemo(
    () => allModels.find((model) => model.provider === draft.providerId && model.id === draft.modelId),
    [allModels, draft.modelId, draft.providerId],
  )
  const storedModelMissing = marksUnavailableModel(
    draft,
    (providerId, modelId) =>
      allModels.some((model) => model.provider === providerId && model.id === modelId),
    models.value !== null,
  )

  /* The reference omits the reasoning field entirely when the selected model has
     no reasoning support (`SubagentReasoningField.tsx:36-60`); it is equally
     meaningless while the model is inherited. */
  const thinkingLevels: readonly PiThinkingLevel[] =
    selectedModel === undefined ? [] : thinkingLevelsForModel(selectedModel)
  const showThinkingLevel = draft.modelMode === 'fixed' && thinkingLevels.length > 0

  const builtinTools: AgentToolOption[] = (tools.value?.tools ?? []).filter((tool) => tool.source === 'builtin')
  const extensionTools: AgentToolOption[] = (tools.value?.tools ?? []).filter((tool) => tool.source === 'extension')
  const catalogToolNames = useMemo(
    () => (tools.value?.tools ?? []).map((tool) => tool.name),
    [tools.value],
  )
  const excludedTools = tools.value?.excluded ?? []
  const chosen = selectedToolNames(draft)

  /* ------------------------------------------------------------- form view */

  if (showForm) {
    return (
      <div className={styles.section}>
        <NoticeLine notice={notice} />
        <div className={styles.formHeader}>
          <button type="button" className={styles.backRow} onClick={backToList}>
            <IconChevronLeftOutline14 size={16} />
            <span>{COPY.backToList}</span>
          </button>
          <div>
            <h3 className={styles.formTitle}>{editing === undefined ? COPY.addNew : COPY.edit}</h3>
            <p className={styles.formDescription}>
              {editing === undefined ? COPY.addDescription : COPY.editDescription}
            </p>
          </div>
        </div>

        <form
          className={styles.form}
          onSubmit={(event) => { event.preventDefault(); void save() }}
        >
          <Field label={COPY.nameLabel} htmlFor="agent-name">
            <input
              id="agent-name"
              className={styles.input}
              value={draft.name}
              placeholder={COPY.namePlaceholder}
              onChange={(event) => { update({ name: event.target.value }) }}
            />
          </Field>

          <Field label={COPY.colorLabel}>
            <AgentColorPicker
              label={COPY.colorLabel}
              color={draft.color}
              onSelect={(color) => { update({ color: toggleAgentColor(draft.color, color) }) }}
            />
          </Field>

          <Field label={COPY.modelLabel}>
            <div className={styles.row}>
              <label className={styles.radio}>
                <input
                  type="radio"
                  name="agent-model-mode"
                  checked={draft.modelMode === 'inherit'}
                  onChange={() => { update({ modelMode: 'inherit' }) }}
                />
                <span>{COPY.modelInherit}</span>
              </label>
              <label className={styles.radio}>
                <input
                  type="radio"
                  name="agent-model-mode"
                  checked={draft.modelMode === 'fixed'}
                  onChange={() => { update({ modelMode: 'fixed' }) }}
                />
                <span>{COPY.modelFixed}</span>
              </label>
              {draft.modelMode === 'fixed' && (
                <select
                  className={styles.input}
                  aria-label={COPY.modelLabel}
                  value={modelSelectionValue(draft)}
                  onChange={(event) => { update(decodeModelSelection(event.target.value)) }}
                >
                  <option value="">请选择模型…</option>
                  {storedModelMissing && (
                    <option value={modelSelectionValue(draft)}>
                      {`${draft.providerId}/${draft.modelId}（当前目录中不可用）`}
                    </option>
                  )}
                  {allModels.map((model) => (
                    <option
                      key={encodeModelSelection(model.provider, model.id)}
                      value={encodeModelSelection(model.provider, model.id)}
                    >
                      {`${modelNames[model.provider] ?? model.provider} · ${model.name}`}
                    </option>
                  ))}
                </select>
              )}
              {showThinkingLevel && (
                <select
                  className={styles.input}
                  aria-label="思考档位"
                  value={draft.thinkingLevel ?? ''}
                  onChange={(event) => {
                    const value = event.target.value
                    update({
                      thinkingLevel: value.length === 0 ? undefined : (value as PiThinkingLevel),
                    })
                  }}
                >
                  <option value="">不指定</option>
                  {thinkingLevels.map((level) => (
                    <option key={level} value={level}>{level}</option>
                  ))}
                </select>
              )}
            </div>
            {models.error !== undefined && (
              <p className={styles.hint} role="alert">
                {COPY.modelLoadFailed}
                <Button variant="ghost" size="sm" onClick={() => { void loadModels() }}>重试</Button>
              </p>
            )}
            {storedModelMissing && (
              <p className={styles.hint} role="alert">
                已保存的指定模型不在当前目录中：该子智能体调用时会直接失败，请重新选择或改为继承。
              </p>
            )}
          </Field>

          <Field label={COPY.descriptionLabel} htmlFor="agent-description">
            <input
              id="agent-description"
              className={styles.input}
              value={draft.description}
              placeholder={COPY.descriptionPlaceholder}
              onChange={(event) => { update({ description: event.target.value }) }}
            />
          </Field>

          <Field label={COPY.toolsLabel}>
            <div className={styles.toolsHead}>
              <select
                className={styles.input}
                aria-label={COPY.toolsLabel}
                value={draft.toolsMode === 'all' ? 'all' : 'custom'}
                onChange={(event) => {
                  if (event.target.value === 'all') {
                    update({ toolsMode: 'all' })
                    return
                  }
                  update({
                    toolsMode: 'selected',
                    selectedTools: initialSelectedToolsForCustom(catalogToolNames, draft.selectedTools),
                  })
                }}
              >
                <option value="all">{COPY.toolsModeAll}</option>
                <option value="custom">{COPY.toolsModeCustom}</option>
              </select>
              <span className={styles.hint}>{COPY.toolsCardTitle}</span>
            </div>
            <p className={styles.hint}>{COPY.toolsCardHint}</p>

            {draft.toolsMode === 'selected' && (
              <>
                <div className={styles.toolCard}>
                  <div className={styles.toolGrid}>
                    {[...builtinTools, ...extensionTools].map((option) => (
                      <ToolCheckbox
                        key={option.name}
                        label={option.name}
                        title={option.description}
                        checked={chosen.includes(option.name)}
                        onToggle={() => {
                          update({
                            selectedTools: chosen.includes(option.name)
                              ? removeToolName(draft.selectedTools, option.name)
                              : addToolName(draft.selectedTools, option.name),
                          })
                        }}
                      />
                    ))}
                  </div>
                  {catalogToolNames.length === 0 && (
                    <p className={styles.hint}>
                      未读到可用工具清单；扩展工具名可以手动填写，实际可用性由运行时校验。
                    </p>
                  )}
                </div>

                <div className={styles.toolsActions}>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      update({ selectedTools: selectAllToolNames(catalogToolNames, draft.selectedTools) })
                    }}
                  >
                    全选
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      update({ selectedTools: clearToolNames(), extraTools: clearToolNames() })
                    }}
                  >
                    全不选
                  </Button>
                  <input
                    className={styles.input}
                    value={extraToolInput}
                    placeholder="手动添加扩展工具名"
                    aria-label="手动添加扩展工具名"
                    onChange={(event) => { setExtraToolInput(event.target.value) }}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      update({
                        extraTools: addToolName(draft.extraTools, extraToolInput),
                        selectedTools: addToolName(draft.selectedTools, extraToolInput),
                      })
                      setExtraToolInput('')
                    }}
                  >
                    添加
                  </Button>
                </div>

                {tools.error !== undefined && (
                  <p className={styles.hint} role="alert">
                    工具清单读取失败。
                    <Button variant="ghost" size="sm" onClick={() => { void loadTools() }}>重试</Button>
                  </p>
                )}
                {excludedTools.length > 0 && (
                  <p className={styles.hint}>以下工具不会提供给子智能体：{excludedTools.join('、')}。</p>
                )}
                {chosen.length === 0 && (
                  <p className={styles.hint}>
                    未选择任何工具：该子智能体将只能推理，不能读写文件或执行命令。
                  </p>
                )}
              </>
            )}
          </Field>

          <Field label={COPY.systemPromptLabel} htmlFor="agent-prompt">
            <textarea
              id="agent-prompt"
              className={styles.textarea}
              value={draft.systemPrompt}
              placeholder={COPY.systemPromptPlaceholder}
              onChange={(event) => { update({ systemPrompt: event.target.value }) }}
            />
          </Field>

          <label className={styles.switchRow} htmlFor="agent-inject-agents-md">
            <span>{COPY.injectAgentsMdLabel}</span>
            <input
              id="agent-inject-agents-md"
              type="checkbox"
              role="switch"
              checked={draft.injectAgentsMd}
              onChange={(event) => { update({ injectAgentsMd: event.target.checked }) }}
            />
          </label>

          <p className={styles.hint}>{COPY.formDescription}</p>

          <AgentFormIssues problems={problems} formError={formError} />

          <div className={styles.formActions}>
            <Button variant="primary" size="sm" type="submit" disabled={busy || problems.errors.length > 0}>
              保存
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={backToList}>
              取消
            </Button>
            {editing !== undefined && (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => { setConfirmDelete(editing) }}
              >
                删除
              </Button>
            )}
          </div>
        </form>

        <DeleteDialog
          target={confirmDelete}
          onCancel={() => { setConfirmDelete(undefined) }}
          onConfirm={() => { void doDelete() }}
        />
        <DiscardDialog
          open={confirmDiscard !== undefined}
          onCancel={() => { setConfirmDiscard(undefined) }}
          onConfirm={() => { confirmDiscard?.() }}
        />
      </div>
    )
  }

  /* ------------------------------------------------------------- list view */

  return (
    <div className={styles.section}>
      <div className={styles.listHead}>
        <div className={styles.listTitle}>
          <span>{COPY.title}</span>
          <span className={styles.count}>{matched.builtin.length + matched.user.length}</span>
        </div>
        <div className={styles.listHeadActions}>
          <div className={styles.searchBox}>
            <IconSearchOutline16 size={16} />
            <input
              className={styles.searchInput}
              type="search"
              value={query}
              placeholder={COPY.searchPlaceholder}
              aria-label={COPY.searchPlaceholder}
              onChange={(event) => { setQuery(event.target.value) }}
            />
          </div>
          <Button
            variant="primary"
            size="sm"
            icon={<IconPlusOutline16 size={16} />}
            onClick={() => { guardDirty(openNew) }}
          >
            {COPY.addNew}
          </Button>
        </div>
      </div>

      <NoticeLine notice={notice} />

      {listError !== undefined && (
        <p className={`${styles.notice} ${styles.noticeAlert}`} role="alert">
          读取子智能体配置失败：{listError}
          <Button
            variant="ghost"
            size="sm"
            icon={<IconRefreshOutline16 size={16} />}
            onClick={() => { void loadDefinitions() }}
          >
            重试
          </Button>
        </p>
      )}

      {/* Both catalogs get a retry where they failed, the way the reference does
          for its model list (`SubagentsSection.tsx:1748-1755`, `common.retry`).
          The message stays; the button only re-issues the read. */}
      {tools.error !== undefined && (
        <p className={styles.hint} role="alert">
          工具清单读取失败：{tools.error}
          <Button variant="ghost" size="sm" onClick={() => { void loadTools() }}>重试</Button>
        </p>
      )}
      {models.error !== undefined && (
        <p className={styles.hint} role="alert">
          {COPY.modelLoadFailed}
          <Button variant="ghost" size="sm" onClick={() => { void loadModels() }}>重试</Button>
        </p>
      )}

      {listLoading && listed === undefined ? (
        <p className={styles.empty}>加载中…</p>
      ) : noMatches ? (
        /* The only empty state left: a search that matched nothing. Built-ins
           mean the unfiltered list is never empty, so the "create your first
           one" prompt lives inside the user group instead. */
        <p className={styles.empty}>{COPY.empty}</p>
      ) : (
        <>
          {matched.builtin.length > 0 && (
            <section className={styles.group}>
              <div className={styles.groupHeader}>
                <span>{COPY.groupBuiltIn}</span>
                <span className={styles.count}>{matched.builtin.length}</span>
              </div>
              <p className={styles.groupHint}>{COPY.groupBuiltInHint}</p>
              <div className={styles.card}>
                {matched.builtin.map((agent, index) => (
                  <div key={agent.id}>
                    {index > 0 ? <div className={styles.divider} aria-hidden="true" /> : null}
                    <AgentRow
                      agent={agent}
                      modelLabel={modelLabelOf(agent, modelNames)}
                      busy={busy}
                      onOpen={() => { setNotice({ text: COPY.groupBuiltInHint, tone: 'info' }) }}
                      onToggle={undefined}
                      onDelete={undefined}
                    />
                  </div>
                ))}
              </div>
            </section>
          )}

          {matched.user.length > 0 && (
            <section className={styles.group}>
              <div className={styles.groupHeader}>
                <span>{COPY.groupUser}</span>
                <span className={styles.count}>{matched.user.length}</span>
              </div>
              <div className={styles.card}>
                {matched.user.map((agent, index) => (
                  <div key={agent.id}>
                    {index > 0 ? <div className={styles.divider} aria-hidden="true" /> : null}
                    <AgentRow
                      agent={agent}
                      modelLabel={modelLabelOf(agent, modelNames)}
                      busy={busy}
                      onOpen={() => { guardDirty(() => { openExisting(agent) }) }}
                      onToggle={(enabled) => { void toggleEnabled(agent, enabled) }}
                      onDelete={() => { setConfirmDelete(agent) }}
                    />
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Nothing of the user's own yet: say so where their list would be,
              rather than hiding the built-ins behind an empty state. */}
          {!hasSearch && noUserAgents && (
            <p className={styles.empty}>还没有子智能体定义，点「{COPY.addNew}」创建一个。</p>
          )}
        </>
      )}

      <p className={styles.footerSummary}>
        {`共 ${counts.total} 个子智能体 · ${counts.enabled} 个已启用`}
      </p>

      <DeleteDialog
        target={confirmDelete}
        onCancel={() => { setConfirmDelete(undefined) }}
        onConfirm={() => { void doDelete() }}
      />
      <DiscardDialog
        open={confirmDiscard !== undefined}
        onCancel={() => { setConfirmDiscard(undefined) }}
        onConfirm={() => { confirmDiscard?.() }}
      />
    </div>
  )
}

/** The model badge text for one row: its own model, else "继承当前对话". */
function modelLabelOf(agent: AgentDefinition, modelNames: Record<string, string>): string {
  if (agent.model.mode === 'inherit') return COPY.modelInherit
  const provider = modelNames[agent.model.providerId] ?? agent.model.providerId
  return `${provider} · ${agent.model.modelId}`
}

/** The tools badge text: "全部工具" or "N 个工具". */
function toolsLabelOf(agent: AgentDefinition): string {
  return agent.tools.mode === 'all' ? COPY.toolsAll : `${agent.tools.names.length} 个工具`
}

/** One list row: avatar + colour dot, name + badges + description, switch, delete. */
/**
 * One list row: avatar + colour dot, name + badges + description, then whatever
 * the row is allowed to do.
 *
 * A read-only row (a built-in) renders **no** enable switch and **no** delete
 * button, and its body is a plain element rather than a button: the reference's
 * built-in rows have no inline interaction, and offering one that the server
 * would refuse (PATCH/DELETE on a builtin id is a 400) is worse than offering
 * none. `onOpen` still fires — the list passes a hint for it — so a click
 * explains itself instead of doing nothing.
 */
function AgentRow({ agent, modelLabel, busy, onOpen, onToggle, onDelete }: {
  agent: AgentDefinition
  modelLabel: string
  busy: boolean
  onOpen: () => void
  /** Absent for a read-only row: no enable switch is rendered. */
  onToggle?: ((enabled: boolean) => void) | undefined
  /** Absent for a read-only row: no delete button is rendered. */
  onDelete?: (() => void) | undefined
}): ReactNode {
  const body = (
    <>
      <span className={styles.avatar} aria-hidden="true">
        <IconAgentPresetOutline16 size={16} />
        {agent.color === undefined
          ? null
          : <span className={styles.avatarDot} data-color={agent.color} />}
      </span>
      <span className={styles.agentText}>
        <span className={styles.agentTitle}>
          <span className={styles.agentName}>{agent.name}</span>
          <span className={styles.badge}>{modelLabel}</span>
          <span className={styles.badge}>{toolsLabelOf(agent)}</span>
        </span>
        <span className={styles.agentDescription}>
          {agent.description.length === 0 ? COPY.noDescription : agent.description}
        </span>
      </span>
    </>
  )

  return (
    <div className={styles.agentRow}>
      {/* The body is a button in both cases, so a built-in click still reaches
          `onOpen` (which shows the hint) instead of silently doing nothing. */}
      <button type="button" className={styles.agentMain} onClick={onOpen}>
        {body}
      </button>
      {agent.readOnly
        ? null
        : (
          <AgentRowActions
            name={agent.name}
            enabled={agent.enabled}
            busy={busy}
            onToggle={onToggle}
            onDelete={onDelete}
          />
        )}
    </div>
  )
}

/** The delete confirmation; title and description verbatim from the reference.
 *
 * Deliberately nothing else: the reference's dialog is exactly
 * 「删除子智能体」 + 「确定要删除子智能体「{name}」吗？此操作无法撤销。」
 * (i18n/locales/zh-CN.ts:3350-3351), and an extra reassuring sentence here was a
 * 1:1 mismatch. Removing it is asserted so it cannot creep back. */
function DeleteDialog({ target, onCancel, onConfirm }: {
  target: AgentDefinition | undefined
  onCancel: () => void
  onConfirm: () => void
}): ReactNode {
  return (
    <Modal
      open={target !== undefined}
      onClose={onCancel}
      title={COPY.deleteTitle}
      closeLabel="关闭"
      description={target === undefined
        ? ''
        : `确定要删除子智能体「${target.name}」吗？此操作无法撤销。`}
      footer={(
        <>
          <Button variant="ghost" size="sm" onClick={onCancel}>取消</Button>
          <Button variant="primary" size="sm" onClick={onConfirm}>删除</Button>
        </>
      )}
    />
  )
}
