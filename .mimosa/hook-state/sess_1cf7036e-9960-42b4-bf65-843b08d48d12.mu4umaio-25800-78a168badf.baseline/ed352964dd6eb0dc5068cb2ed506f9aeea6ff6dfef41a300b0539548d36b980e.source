/**
 * Model configuration page: pi's own `~/.pi/agent/models.json`, edited in place
 * through the bridge's `/api/models-config` endpoints.
 *
 * This is the two-pane replacement for the old single-column models drawer:
 * providers on the left (230px), the editor for the selected provider on the
 * right, both panes scrolling on their own, one save bar underneath. pi loads
 * and hot-reloads that same file, so a single successful write reaches the pi
 * CLI and this UI at once — which is why every write reports upward through
 * `onChanged`.
 *
 * Credentials never cross the wire: this surface only ever describes *how* a key
 * is supplied (`shell` / `$ENV` / stored / missing), a blank input keeps the
 * configured value untouched, and `{remove:true}` is the only way to drop it.
 *
 * The layout is deliberately split from the data layer: `ModelConfigPage` owns
 * the request lifecycle, `ModelConfigPageView` is pure. antd renders a Modal
 * through a portal — nothing inside it exists in server-rendered markup — so the
 * smoke harness drives the view directly from fixtures.
 */

import { ActionIcon, Alert, Flexbox, Text, Tooltip } from '@lobehub/ui';
import {
  App as AntApp,
  AutoComplete,
  Button,
  Empty,
  Input,
  Modal,
  Select,
  Spin,
  Switch,
  Tag,
  theme,
} from 'antd';
import type { ModalFuncProps } from 'antd';
import { Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import {
  apiKeySummary,
  apiKeyTooltip,
  errorMessage,
  modelsConfigApi,
  PI_API_KIND_LABELS,
  providerIdError,
  sortedProviders,
} from '../../lib/modelsConfig';
import { PI_API_KINDS } from '../../shared/models-config';
import type { ApiKeyView, ModelConfigResponse, PiApiKind, ProviderView } from '../../shared/models-config';
import {
  buildProviderPayload,
  createModelDraft,
  createProviderDraft,
  storedApiKey,
  validateProviderDraft,
} from './providerDraft';
import type { DraftErrors, ModelDraft, ProviderDraft } from './providerDraft';

/* --------------------------------------------------------------- constants */

const MODAL_WIDTH = 'min(1040px, 92vw)';
const PANE_HEIGHT = 'min(560px, 70vh)';
const PANE_WIDTH = 230;
const FALLBACK_PATH = '~/.pi/agent/models.json';

/** id / name / contextWindow / maxTokens / reasoning / input / delete */
const MODEL_GRID = 'minmax(150px, 1.5fr) minmax(110px, 1fr) 88px 88px 52px minmax(130px, 150px) 28px';
const MODEL_MIN_WIDTH = 680;

const INPUT_OPTIONS = [
  { value: 'text', label: '文本' },
  { value: 'image', label: '图像' },
];

const TAG_STYLE = {
  fontSize: 10,
  lineHeight: '16px',
  marginInlineEnd: 0,
  paddingInline: 5,
} as const;

/** Canonical form of a draft, so "dirty" is a value comparison and not a flag. */
function baselineOf(draft: ProviderDraft): string {
  return JSON.stringify(buildProviderPayload(draft));
}

/* ---------------------------------------------------------------- feedback */

/**
 * antd's context `modal`/`message` inherit the app theme; outside an `<App>` the
 * context default is an empty object, so fall back to the static Modal API.
 */
function useAntdFeedback(): {
  confirm: (config: ModalFuncProps) => void;
  success: (content: ReactNode) => void;
} {
  const app = AntApp.useApp();
  return useMemo(() => {
    const modal = app.modal as Partial<typeof app.modal>;
    const message = app.message as Partial<typeof app.message>;
    const confirm = modal.confirm ?? Modal.confirm;
    return {
      confirm: (config: ModalFuncProps) => {
        confirm(config);
      },
      success: (content: ReactNode) => {
        message.success?.(content);
      },
    };
  }, [app.message, app.modal]);
}

/* -------------------------------------------------------------- primitives */

/** Green when a credential is configured, gray otherwise; the tooltip says how. */
function CredentialDot({ apiKey }: { apiKey: ApiKeyView }) {
  const { token } = theme.useToken();
  const label = apiKeyTooltip(apiKey);
  return (
    <Tooltip title={label}>
      <span
        role="img"
        aria-label={label}
        data-credential={apiKey.has ? 'configured' : 'missing'}
        style={{
          flexShrink: 0,
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: apiKey.has ? token.colorSuccess : token.colorTextQuaternary,
          opacity: apiKey.has ? 1 : 0.6,
        }}
      />
    </Tooltip>
  );
}

/** Labelled form row: label, control, then the error or the hint. */
function FormRow({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
}) {
  const { token } = theme.useToken();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      <Text fontSize={11} weight={600} style={{ color: token.colorTextSecondary }}>
        {label}
      </Text>
      {children}
      {error !== undefined ? (
        <Text fontSize={10.5} type="danger">
          {error}
        </Text>
      ) : typeof hint === 'string' ? (
        <Text fontSize={10.5} style={{ color: token.colorTextQuaternary }}>
          {hint}
        </Text>
      ) : (
        (hint ?? null)
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- info strip */

function InfoStrip({ path }: { path: string | null }) {
  const { token } = theme.useToken();
  const shown = path ?? FALLBACK_PATH;
  return (
    <Flexbox gap={4} style={{ flexShrink: 0 }}>
      <div
        title={shown}
        style={{
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontFamily: token.fontFamilyCode,
          fontSize: 11.5,
          color: token.colorTextSecondary,
        }}
      >
        {shown}
      </div>
      <Text fontSize={11.5} type="secondary">
        这是 pi 自己的模型配置文件，pi CLI 与本界面共用，保存即时生效。
      </Text>
    </Flexbox>
  );
}

/* ------------------------------------------------------------- left pane */

function ProviderListRow({
  id,
  name,
  apiKey,
  modelCount,
  pending,
  selected,
  onSelect,
  onDelete,
}: {
  id: string;
  name?: string;
  apiKey: ApiKeyView;
  modelCount: number;
  pending?: boolean;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const { token } = theme.useToken();
  const [hovered, setHovered] = useState(false);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect();
        }
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        minWidth: 0,
        padding: '6px 8px',
        borderRadius: token.borderRadius,
        cursor: 'pointer',
        background: selected ? token.colorFillSecondary : 'transparent',
      }}
    >
      <CredentialDot apiKey={apiKey} />
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
        <Flexbox horizontal align="center" gap={4} style={{ minWidth: 0 }}>
          <Text fontSize={12.5} weight={600} ellipsis noWrap style={{ minWidth: 0 }}>
            {id}
          </Text>
          {pending === true && <Tag style={TAG_STYLE}>新建</Tag>}
        </Flexbox>
        {name !== undefined && name.length > 0 && (
          <Text fontSize={11} type="secondary" ellipsis noWrap style={{ minWidth: 0 }}>
            {name}
          </Text>
        )}
      </div>
      <Text
        fontSize={10.5}
        title={`${modelCount} 个模型`}
        style={{ color: token.colorTextQuaternary, whiteSpace: 'nowrap' }}
      >
        {`${modelCount} 个`}
      </Text>
      <ActionIcon
        icon={Trash2}
        size="small"
        danger
        // `title` only reaches the tooltip portal, so the accessible name is explicit.
        aria-label={pending === true ? '放弃新建' : `删除「${id}」`}
        title={pending === true ? '放弃新建' : `删除「${id}」`}
        onClick={(event) => {
          event.stopPropagation();
          onDelete();
        }}
        style={{ opacity: hovered ? 1 : 0.35 }}
      />
    </div>
  );
}

interface ProviderListPaneProps {
  providers: ProviderView[];
  /** the unsaved draft, when it is a provider that does not exist yet */
  pending: { id: string; name: string; modelCount: number } | null;
  selectedId: string | null;
  adding: boolean;
  addId: string;
  addError: string | undefined;
  handlers: ModelConfigHandlers;
}

function ProviderListPane({
  providers,
  pending,
  selectedId,
  adding,
  addId,
  addError,
  handlers,
}: ProviderListPaneProps) {
  const { token } = theme.useToken();
  const existingIds = useMemo(() => providers.map((provider) => provider.id), [providers]);

  return (
    <Flexbox
      width={PANE_WIDTH}
      style={{
        flexShrink: 0,
        minHeight: 0,
        borderInlineEnd: `1px solid ${token.colorBorderSecondary}`,
      }}
    >
      <Flexbox
        horizontal
        align="center"
        justify="space-between"
        gap={8}
        style={{ flexShrink: 0, padding: '10px 8px 8px' }}
      >
        <Text fontSize={12} weight={600}>
          提供商
        </Text>
        <Button size="small" type="text" icon={<Plus size={13} />} onClick={handlers.addOpen}>
          添加
        </Button>
      </Flexbox>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          overscrollBehavior: 'contain',
          padding: '0 8px 8px',
        }}
      >
        {pending !== null && (
          <ProviderListRow
            id={pending.id}
            name={pending.name}
            apiKey={{ has: false, source: 'none' }}
            modelCount={pending.modelCount}
            pending
            selected={selectedId === pending.id}
            onSelect={() => undefined}
            onDelete={handlers.discardNew}
          />
        )}

        {providers.map((provider) => (
          <ProviderListRow
            key={provider.id}
            id={provider.id}
            {...(provider.name !== undefined ? { name: provider.name } : {})}
            apiKey={provider.apiKey}
            modelCount={provider.models.length}
            selected={selectedId === provider.id}
            onSelect={() => handlers.select(provider)}
            onDelete={() => handlers.remove(provider)}
          />
        ))}

        {providers.length === 0 && pending === null && (
          <Text fontSize={11} style={{ color: token.colorTextQuaternary, lineHeight: 1.6 }}>
            models.json 里还没有 provider。
          </Text>
        )}
      </div>

      <div
        style={{
          flexShrink: 0,
          borderTop: `1px solid ${token.colorBorderSecondary}`,
          padding: 8,
        }}
      >
        {adding ? (
          <Flexbox gap={6}>
            <AutoComplete
              autoFocus
              size="small"
              value={addId}
              options={existingIds.map((id) => ({ value: id }))}
              placeholder="例如 my-gateway"
              onChange={(value: string) => handlers.addChange(value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') handlers.addSubmit();
              }}
            />
            {addError !== undefined && (
              <Text fontSize={10.5} type="danger">
                {addError}
              </Text>
            )}
            <Text fontSize={10} style={{ color: token.colorTextQuaternary, lineHeight: 1.5 }}>
              创建后在右侧填写 Base URL 等配置。
            </Text>
            <Flexbox horizontal gap={6}>
              <Button size="small" type="primary" style={{ flex: 1 }} onClick={handlers.addSubmit}>
                创建
              </Button>
              <Button size="small" style={{ flex: 1 }} onClick={handlers.addCancel}>
                取消
              </Button>
            </Flexbox>
          </Flexbox>
        ) : (
          <Button block size="small" type="dashed" icon={<Plus size={13} />} onClick={handlers.addOpen}>
            添加 provider
          </Button>
        )}
      </div>
    </Flexbox>
  );
}

/* ------------------------------------------------------------ models table */

function ModelTableRow({
  model,
  index,
  error,
  onChange,
  onRemove,
}: {
  model: ModelDraft;
  index: number;
  error: string | undefined;
  onChange: (key: string, next: Partial<ModelDraft>) => void;
  onRemove: (key: string) => void;
}) {
  const { token } = theme.useToken();
  const failed = error !== undefined;
  return (
    <Flexbox
      gap={6}
      padding={8}
      style={{
        border: `1px solid ${failed ? token.colorErrorBorder : token.colorBorderSecondary}`,
        borderRadius: token.borderRadius,
      }}
    >
      <div style={{ display: 'grid', gridTemplateColumns: MODEL_GRID, gap: 6, alignItems: 'center' }}>
        <Input
          size="small"
          value={model.id}
          status={failed ? 'error' : undefined}
          placeholder="例如 deepseek-v4-flash"
          onChange={(event) => onChange(model.key, { id: event.target.value })}
        />
        <Input
          size="small"
          value={model.name}
          placeholder="可留空"
          onChange={(event) => onChange(model.key, { name: event.target.value })}
        />
        <Input
          size="small"
          value={model.contextWindow}
          inputMode="numeric"
          placeholder="128000"
          onChange={(event) => onChange(model.key, { contextWindow: event.target.value })}
        />
        <Input
          size="small"
          value={model.maxTokens}
          inputMode="numeric"
          placeholder="8192"
          onChange={(event) => onChange(model.key, { maxTokens: event.target.value })}
        />
        <Switch
          size="small"
          checked={model.reasoning}
          onChange={(checked: boolean) => onChange(model.key, { reasoning: checked })}
        />
        <Select
          size="small"
          mode="multiple"
          style={{ width: '100%' }}
          value={model.input}
          options={INPUT_OPTIONS}
          placeholder="text / image"
          onChange={(value: string[]) => onChange(model.key, { input: value })}
        />
        <ActionIcon
          icon={Trash2}
          size="small"
          danger
          aria-label={`删除第 ${String(index + 1)} 个模型`}
          title="删除该模型"
          onClick={() => onRemove(model.key)}
        />
      </div>
      {failed && (
        <Text fontSize={10.5} type="danger">
          {`第 ${index + 1} 个模型：${error}`}
        </Text>
      )}
    </Flexbox>
  );
}

function ModelsTable({
  models,
  errors,
  onAdd,
  onChange,
  onRemove,
}: {
  models: ModelDraft[];
  errors: Readonly<Record<string, string>>;
  onAdd: () => void;
  onChange: (key: string, next: Partial<ModelDraft>) => void;
  onRemove: (key: string) => void;
}) {
  const { token } = theme.useToken();
  return (
    <Flexbox gap={6}>
      <Flexbox horizontal align="center" justify="space-between" gap={8}>
        <Flexbox horizontal align="center" gap={6}>
          <Text fontSize={12} weight={600}>
            模型
          </Text>
          <Text fontSize={11} type="secondary">
            {`${models.length} 个`}
          </Text>
        </Flexbox>
        <Button size="small" icon={<Plus size={13} />} onClick={onAdd}>
          添加模型
        </Button>
      </Flexbox>

      {models.length === 0 ? (
        <Text fontSize={11.5} style={{ color: token.colorTextQuaternary }}>
          该 provider 暂无模型，点击「添加模型」补充。
        </Text>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <Flexbox gap={6} style={{ minWidth: MODEL_MIN_WIDTH }}>
            <div style={{ display: 'grid', gridTemplateColumns: MODEL_GRID, gap: 6, paddingInline: 8 }}>
              {['模型 ID', '显示名称', '上下文窗口', '最大输出', '推理', '输入类型', ''].map((label, index) => (
                <Text
                  key={`${label}-${String(index)}`}
                  fontSize={10.5}
                  style={{ color: token.colorTextQuaternary }}
                >
                  {label}
                </Text>
              ))}
            </div>
            {models.map((model, index) => (
              <ModelTableRow
                key={model.key}
                model={model}
                index={index}
                error={errors[model.key]}
                onChange={onChange}
                onRemove={onRemove}
              />
            ))}
          </Flexbox>
        </div>
      )}
    </Flexbox>
  );
}

/* ------------------------------------------------------------- right pane */

function EditorPane({
  draft,
  stored,
  baseUrlError,
  modelErrors,
  handlers,
}: {
  draft: ProviderDraft;
  stored: ApiKeyView;
  baseUrlError: string | undefined;
  modelErrors: Readonly<Record<string, string>>;
  handlers: ModelConfigHandlers;
}) {
  const typed = draft.apiKey.trim().length > 0;
  return (
    <Flexbox gap={12}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <FormRow label="显示名称" hint="用于界面展示，可留空">
          <Input
            value={draft.name}
            placeholder="例如 自建网关"
            onChange={(event) => handlers.patchDraft({ name: event.target.value })}
          />
        </FormRow>

        <FormRow
          label="Base URL"
          error={baseUrlError}
          hint={draft.isNew ? '必填，例如 https://api.example.com/v1' : '留空将保持 models.json 中的现有值'}
        >
          <Input
            value={draft.baseUrl}
            status={baseUrlError !== undefined ? 'error' : undefined}
            placeholder="https://api.example.com/v1"
            onChange={(event) => handlers.patchDraft({ baseUrl: event.target.value })}
          />
        </FormRow>

        <FormRow label="API 类型">
          <Select
            style={{ width: '100%' }}
            value={draft.api}
            options={PI_API_KINDS.map((kind) => ({ value: kind, label: PI_API_KIND_LABELS[kind] }))}
            onChange={(value: PiApiKind) => handlers.patchDraft({ api: value })}
          />
        </FormRow>

        <FormRow label="authHeader" hint="在请求头中携带密钥（部分网关需要）">
          <Switch
            checked={draft.authHeader}
            onChange={(checked: boolean) => handlers.patchDraft({ authHeader: checked })}
          />
        </FormRow>
      </div>

      <FormRow label="API Key">
        <Flexbox gap={6}>
          <Text fontSize={11} type="secondary">
            {apiKeySummary(stored)}
            {typed ? '；保存后将写入新密钥' : ''}
          </Text>
          <Flexbox horizontal align="center" gap={6}>
            <Input.Password
              value={draft.apiKey}
              style={{ flex: 1 }}
              placeholder="留空则保持已配置的密钥不变"
              onChange={(event) => handlers.patchDraft({ apiKey: event.target.value, apiKeyRemove: false })}
            />
            {stored.has && !draft.apiKeyRemove && (
              <Button
                type="link"
                size="small"
                danger
                onClick={() => handlers.patchDraft({ apiKey: '', apiKeyRemove: true })}
              >
                清除密钥
              </Button>
            )}
          </Flexbox>
          {draft.apiKeyRemove && (
            <Flexbox horizontal align="center" gap={8}>
              <Text fontSize={10.5} type="warning">
                保存后将删除 models.json 中已配置的密钥
              </Text>
              <Button type="link" size="small" onClick={() => handlers.patchDraft({ apiKeyRemove: false })}>
                撤销
              </Button>
            </Flexbox>
          )}
        </Flexbox>
      </FormRow>

      <ModelsTable
        models={draft.models}
        errors={modelErrors}
        onAdd={handlers.addModel}
        onChange={handlers.patchModel}
        onRemove={handlers.removeModel}
      />
    </Flexbox>
  );
}

/* ------------------------------------------------------------ the pure view */

/** Everything the layout needs to render: server state, transient UI state, callbacks. */
export interface ModelConfigViewProps {
  config: ModelConfigResponse | null;
  loading: boolean;
  loadError: string | null;
  /** providers in display order */
  providers: ProviderView[];
  selectedId: string | null;
  /** editor state for the selected provider (existing or not yet written) */
  draft: ProviderDraft | null;
  dirty: boolean;
  saving: boolean;
  /** client-side problems that block the save, already worded for the user */
  errors: DraftErrors;
  /** the last write's server error, shown verbatim */
  saveError: string | null;
  adding: boolean;
  addId: string;
  addError: string | undefined;
  handlers: ModelConfigHandlers;
}

export interface ModelConfigHandlers {
  reload: () => void;
  select: (provider: ProviderView) => void;
  remove: (provider: ProviderView) => void;
  addOpen: () => void;
  addCancel: () => void;
  addChange: (value: string) => void;
  addSubmit: () => void;
  discardNew: () => void;
  patchDraft: (next: Partial<ProviderDraft>) => void;
  patchModel: (key: string, next: Partial<ModelDraft>) => void;
  addModel: () => void;
  removeModel: (key: string) => void;
  save: () => void;
  cancel: () => void;
}

export function ModelConfigPageView({
  config,
  loading,
  loadError,
  providers,
  selectedId,
  draft,
  dirty,
  saving,
  errors,
  saveError,
  adding,
  addId,
  addError,
  handlers,
}: ModelConfigViewProps) {
  const { token } = theme.useToken();
  const selected = config !== null && selectedId !== null ? config.providers[selectedId] : undefined;
  const stored = storedApiKey(selected);
  const blocked = errors.messages.length > 0;
  const pending =
    draft !== null && draft.isNew
      ? { id: draft.id, name: draft.name, modelCount: draft.models.length }
      : null;

  return (
    <Flexbox gap={12}>
      <InfoStrip path={config?.path ?? null} />

      <Flexbox
        horizontal
        style={{
          height: PANE_HEIGHT,
          minHeight: 0,
          border: `1px solid ${token.colorBorderSecondary}`,
          borderRadius: token.borderRadius,
          overflow: 'hidden',
        }}
      >
        <ProviderListPane
          providers={providers}
          pending={pending}
          selectedId={selectedId}
          adding={adding}
          addId={addId}
          addError={addError}
          handlers={handlers}
        />

        <div
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            overflowY: 'auto',
            overscrollBehavior: 'contain',
            padding: 12,
          }}
        >
          {loading && config === null ? (
            <Flexbox align="center" justify="center" style={{ height: '100%' }}>
              <Spin />
            </Flexbox>
          ) : config === null ? (
            <Flexbox align="center" justify="center" gap={10} style={{ height: '100%' }}>
              <Text fontSize={11.5} type="secondary">
                读取 models.json 失败，暂时无法显示 providers。
              </Text>
              <Button size="small" icon={<RefreshCw size={13} />} onClick={handlers.reload}>
                重试
              </Button>
            </Flexbox>
          ) : draft !== null ? (
            <EditorPane
              draft={draft}
              stored={stored}
              baseUrlError={errors.baseUrl}
              modelErrors={errors.models}
              handlers={handlers}
            />
          ) : providers.length === 0 ? (
            <Flexbox align="center" justify="center" gap={8} style={{ height: '100%' }}>
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有自定义模型" />
              <Text fontSize={11.5} type="secondary" style={{ textAlign: 'center', lineHeight: 1.6 }}>
                在左侧点击「添加 provider」，为 pi 添加第一个自定义模型。
              </Text>
            </Flexbox>
          ) : (
            <Flexbox align="center" justify="center" style={{ height: '100%' }}>
              <Text fontSize={11.5} type="secondary">
                从左侧选择一个 provider 进行编辑。
              </Text>
            </Flexbox>
          )}
        </div>
      </Flexbox>

      {loadError !== null && (
        <Alert type="error" title="读取 models.json 失败" description={loadError} />
      )}
      {saveError !== null && <Alert type="error" title="保存失败" description={saveError} />}
      {draft !== null && blocked && (
        <Alert
          type="warning"
          title="请先修正以下问题"
          description={
            <ul style={{ margin: 0, paddingInlineStart: 18 }}>
              {errors.messages.map((message) => (
                <li key={message}>
                  <Text fontSize={12}>{message}</Text>
                </li>
              ))}
            </ul>
          }
        />
      )}

      <Flexbox
        horizontal
        align="center"
        justify="space-between"
        gap={12}
        style={{ flexShrink: 0, borderTop: `1px solid ${token.colorBorderSecondary}`, paddingTop: 12 }}
      >
        <Text fontSize={11.5} type={dirty ? 'warning' : 'secondary'}>
          {saving
            ? '正在保存…'
            : dirty
              ? '未保存的修改'
              : config !== null
                ? `已保存 · 修订 ${config.revision}`
                : ''}
        </Text>
        <Flexbox horizontal gap={8}>
          <Button onClick={handlers.cancel}>取消</Button>
          <Button
            type="primary"
            disabled={!dirty || blocked || saving}
            loading={saving}
            onClick={handlers.save}
          >
            保存
          </Button>
        </Flexbox>
      </Flexbox>
    </Flexbox>
  );
}

/* ----------------------------------------------------------- the wired page */

export interface ModelConfigPageProps {
  open: boolean;
  onClose: () => void;
  /** called after every successful write */
  onChanged?: () => void;
}

export function ModelConfigPage({ open, onClose, onChanged }: ModelConfigPageProps) {
  const { confirm, success } = useAntdFeedback();

  const [config, setConfig] = useState<ModelConfigResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ProviderDraft | null>(null);
  const [baseline, setBaseline] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addId, setAddId] = useState('');
  const [addError, setAddError] = useState<string | undefined>(undefined);

  const providers = useMemo(() => sortedProviders(config), [config]);
  const existingIds = useMemo(() => providers.map((provider) => provider.id), [providers]);
  const errors = useMemo<DraftErrors>(
    () =>
      draft === null ? { messages: [], models: {} } : validateProviderDraft(draft, { existingIds }),
    [draft, existingIds],
  );
  const blocked = errors.messages.length > 0;
  const dirty = draft !== null && (draft.isNew || baselineOf(draft) !== baseline);

  const load = useCallback(async (): Promise<ModelConfigResponse | null> => {
    setLoading(true);
    try {
      const next = await modelsConfigApi.read();
      setConfig(next);
      setLoadError(null);
      return next;
    } catch (error) {
      setLoadError(errorMessage(error));
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  /** Adopt the server's view of one provider as the editor's starting point. */
  const openProvider = useCallback((provider: ProviderView) => {
    const next = createProviderDraft(provider);
    setDraft(next);
    setSelectedId(provider.id);
    setBaseline(baselineOf(next));
    setSaveError(null);
  }, []);

  // pi watches the same file, so every open starts from a fresh read; the first
  // provider is selected so a machine that already has providers never opens on
  // a blank pane.
  useEffect(() => {
    if (!open) return;
    setDraft(null);
    setSelectedId(null);
    setSaveError(null);
    setAdding(false);
    setAddId('');
    setAddError(undefined);
    void load().then((next) => {
      const first = sortedProviders(next)[0];
      if (first !== undefined) openProvider(first);
    });
  }, [open, load, openProvider]);

  const patchDraft = useCallback((next: Partial<ProviderDraft>) => {
    setDraft((previous) => (previous === null ? previous : { ...previous, ...next }));
  }, []);

  const patchModel = useCallback((key: string, next: Partial<ModelDraft>) => {
    setDraft((previous) =>
      previous === null
        ? previous
        : {
            ...previous,
            models: previous.models.map((model) =>
              model.key === key ? { ...model, ...next } : model,
            ),
          },
    );
  }, []);

  const addModel = useCallback(() => {
    setDraft((previous) =>
      previous === null ? previous : { ...previous, models: [...previous.models, createModelDraft()] },
    );
  }, []);

  const removeModel = useCallback((key: string) => {
    setDraft((previous) =>
      previous === null
        ? previous
        : { ...previous, models: previous.models.filter((model) => model.key !== key) },
    );
  }, []);

  /** Anything that would throw the draft away asks first — but only when it is dirty. */
  const guardDirty = useCallback(
    (action: () => void, content: string) => {
      if (!dirty) {
        action();
        return;
      }
      confirm({
        title: '放弃未保存的修改？',
        content,
        okText: '放弃修改',
        okType: 'danger',
        cancelText: '继续编辑',
        centered: true,
        onOk: () => {
          action();
        },
      });
    },
    [confirm, dirty],
  );

  const select = useCallback(
    (provider: ProviderView) => {
      if (provider.id === selectedId) return;
      guardDirty(() => openProvider(provider), `当前编辑内容尚未保存，切换到「${provider.id}」后将丢失。`);
    },
    [guardDirty, openProvider, selectedId],
  );

  const discardNew = useCallback(() => {
    guardDirty(() => {
      setDraft(null);
      setSelectedId(null);
      setBaseline('');
    }, '新建的 provider 还没有写入 models.json，放弃后需要重新创建。');
  }, [guardDirty]);

  const remove = useCallback(
    (provider: ProviderView) => {
      confirm({
        title: '删除 provider',
        content: `确定要删除「${provider.id}」吗？它下面的 ${String(provider.models.length)} 个模型会一并从 models.json 中移除。`,
        okText: '删除',
        okType: 'danger',
        cancelText: '取消',
        centered: true,
        onOk: async () => {
          try {
            const next = await modelsConfigApi.deleteProvider(provider.id);
            setConfig(next);
            setLoadError(null);
            if (selectedId === provider.id) {
              setDraft(null);
              setSelectedId(null);
              setBaseline('');
              const first = sortedProviders(next)[0];
              if (first !== undefined) openProvider(first);
            }
            success(`已删除 provider「${provider.id}」`);
            onChanged?.();
          } catch (error) {
            setSaveError(errorMessage(error));
          }
        },
      });
    },
    [confirm, onChanged, openProvider, selectedId, success],
  );

  const addOpen = useCallback(() => {
    setAdding(true);
    setAddId('');
    setAddError(undefined);
  }, []);

  const addChange = useCallback((value: string) => {
    setAddId(value);
    setAddError(undefined);
  }, []);

  const addCancel = useCallback(() => {
    setAdding(false);
    setAddId('');
    setAddError(undefined);
  }, []);

  const addSubmit = useCallback(() => {
    const id = addId.trim();
    const problem =
      providerIdError(id) ??
      (existingIds.includes(id) ? `Provider ID 已存在：${id}，请直接编辑该 provider` : undefined);
    if (problem !== undefined) {
      setAddError(problem);
      return;
    }
    guardDirty(() => {
      const next: ProviderDraft = { ...createProviderDraft(), id };
      setDraft(next);
      setSelectedId(id);
      setBaseline(baselineOf(next));
      setAdding(false);
      setAddId('');
      setAddError(undefined);
      setSaveError(null);
    }, '当前 provider 有未保存的修改，新建将先丢弃这些修改。');
  }, [addId, existingIds, guardDirty]);

  const save = useCallback(() => {
    if (draft === null || saving || blocked) return;
    const providerId = draft.id.trim();
    setSaving(true);
    setSaveError(null);
    modelsConfigApi
      .upsertProvider(providerId, buildProviderPayload(draft))
      .then((next) => {
        setConfig(next);
        setLoadError(null);
        const view = next.providers[providerId];
        if (view !== undefined) {
          openProvider(view);
        } else {
          setDraft(null);
          setSelectedId(null);
          setBaseline('');
        }
        success('已保存');
        onChanged?.();
      })
      .catch((error: unknown) => {
        setSaveError(errorMessage(error));
      })
      .finally(() => {
        setSaving(false);
      });
  }, [blocked, draft, onChanged, openProvider, saving, success]);

  const requestClose = useCallback(() => {
    if (!dirty) {
      onClose();
      return;
    }
    confirm({
      title: '放弃未保存的修改？',
      content: '关闭后本次编辑不会写入 models.json。',
      okText: '放弃并关闭',
      okType: 'danger',
      cancelText: '继续编辑',
      centered: true,
      onOk: () => {
        setDraft(null);
        setSelectedId(null);
        onClose();
      },
    });
  }, [confirm, dirty, onClose]);

  return (
    <Modal
      open={open}
      title="模型配置"
      width={MODAL_WIDTH}
      footer={null}
      destroyOnHidden
      centered
      onCancel={requestClose}
    >
      <ModelConfigPageView
        config={config}
        loading={loading}
        loadError={loadError}
        providers={providers}
        selectedId={selectedId}
        draft={draft}
        dirty={dirty}
        saving={saving}
        errors={errors}
        saveError={saveError}
        adding={adding}
        addId={addId}
        addError={addError}
        handlers={{
          reload: () => {
            void load();
          },
          select,
          remove,
          addOpen,
          addCancel,
          addChange,
          addSubmit,
          discardNew,
          patchDraft,
          patchModel,
          addModel,
          removeModel,
          save,
          cancel: requestClose,
        }}
      />
    </Modal>
  );
}

/* ------------------------------------------------------------------ asserts */

/**
 * Usage assert: the workspace shell renders `<ModelConfigPage {...props} />`
 * with exactly these props, so the public contract cannot change silently.
 */
const samplePageProps: ModelConfigPageProps = {
  open: true,
  onClose: () => {},
  onChanged: () => {},
};

export type ModelConfigPagePropsAssertion = typeof samplePageProps;

/**
 * Usage assert: `ModelConfigPage` renders `<ModelConfigPageView {...props} />`
 * with exactly these props, so the pure layout cannot drift from its wiring.
 */
const sampleHandlers: ModelConfigHandlers = {
  reload: () => {},
  select: () => {},
  remove: () => {},
  addOpen: () => {},
  addCancel: () => {},
  addChange: () => {},
  addSubmit: () => {},
  discardNew: () => {},
  patchDraft: () => {},
  patchModel: () => {},
  addModel: () => {},
  removeModel: () => {},
  save: () => {},
  cancel: () => {},
};

const sampleViewProps: ModelConfigViewProps = {
  config: {
    revision: 1,
    path: '/home/example/.pi/agent/models.json',
    providers: {},
  },
  loading: false,
  loadError: null,
  providers: [],
  selectedId: null,
  draft: null,
  dirty: false,
  saving: false,
  errors: { messages: [], models: {} },
  saveError: null,
  adding: false,
  addId: '',
  addError: undefined,
  handlers: sampleHandlers,
};

export type ModelConfigViewPropsAssertion = typeof sampleViewProps;

/**
 * Usage assert: every field below is sent by the save path, so a change to the
 * wire contract that drops one of them fails `tsc` here first.
 */
const sampleDraft: ProviderDraft = {
  ...createProviderDraft(),
  id: 'example',
  baseUrl: 'https://api.example.com/v1',
  models: [createModelDraft()],
};

export type ModelConfigPageDraftAssertion = typeof sampleDraft;
