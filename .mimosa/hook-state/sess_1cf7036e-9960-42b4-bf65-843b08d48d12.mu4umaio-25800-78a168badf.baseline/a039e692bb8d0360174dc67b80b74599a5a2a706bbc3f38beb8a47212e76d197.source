/**
 * Editor for one provider of pi's `~/.pi/agent/models.json`.
 *
 * Opened from `ModelsDrawer` as an antd Modal over the drawer. All editing state
 * lives in a `ProviderDraft`; validation runs before the request so a bad row is
 * named without a round trip, and the server's error text is shown verbatim when
 * a write still fails.
 *
 * The API key is write-only: the input starts empty, the stored credential is
 * only ever *described* (`已通过环境变量 $X 配置`), and the payload omits `apiKey`
 * unless the user typed a value or explicitly asked to clear it.
 */

import { Alert, Flexbox, Text } from '@lobehub/ui';
import { AutoComplete, Button, Input, Modal, Select, Switch } from 'antd';
import { useMemo, useState } from 'react';

import {
  apiKeySummary,
  errorMessage,
  modelsConfigApi,
  PI_API_KIND_LABELS,
} from '../../lib/modelsConfig';
import { PI_API_KINDS } from '../../shared/models-config';
import type { ModelConfigResponse, PiApiKind, ProviderView } from '../../shared/models-config';
import { Field } from './Field';
import { ModelListEditor } from './ModelListEditor';
import {
  buildProviderPayload,
  createModelDraft,
  createProviderDraft,
  storedApiKey,
  validateProviderDraft,
} from './providerDraft';
import type { ModelDraft, ProviderDraft } from './providerDraft';

export interface ProviderEditorProps {
  open: boolean;
  /** undefined starts a new provider */
  provider?: ProviderView;
  /** provider ids already in the file: create-mode collision check + hints */
  existingIds: string[];
  onClose: () => void;
  /** the server's fresh state after a successful write, plus the id written */
  onSaved: (config: ModelConfigResponse, providerId: string) => void;
}

export function ProviderEditor({
  open,
  provider,
  existingIds,
  onClose,
  onSaved,
}: ProviderEditorProps) {
  const [draft, setDraft] = useState<ProviderDraft>(() => createProviderDraft(provider));
  /** validation gates the first save attempt, then stays live so fixes clear */
  const [attempted, setAttempted] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const errors = useMemo(
    () => validateProviderDraft(draft, { existingIds }),
    [draft, existingIds],
  );
  const blocked = errors.messages.length > 0;
  const stored = storedApiKey(provider);
  const authHeaderStuck = provider?.authHeader === true && !draft.authHeader;

  const patch = (next: Partial<ProviderDraft>) => {
    setDraft((previous) => ({ ...previous, ...next }));
  };

  const patchModel = (key: string, next: Partial<ModelDraft>) => {
    setDraft((previous) => ({
      ...previous,
      models: previous.models.map((model) => (model.key === key ? { ...model, ...next } : model)),
    }));
  };

  const removeModel = (key: string) => {
    setDraft((previous) => ({
      ...previous,
      models: previous.models.filter((model) => model.key !== key),
    }));
  };

  const addModel = () => {
    setDraft((previous) => ({ ...previous, models: [...previous.models, createModelDraft()] }));
  };

  const submit = () => {
    setAttempted(true);
    setSaveError(null);
    if (blocked) return;
    setSaving(true);
    const providerId = draft.id.trim();
    modelsConfigApi
      .upsertProvider(providerId, buildProviderPayload(draft))
      .then((config) => {
        onSaved(config, providerId);
      })
      .catch((error: unknown) => {
        setSaveError(errorMessage(error));
      })
      .finally(() => {
        setSaving(false);
      });
  };

  return (
    <Modal
      open={open}
      title={draft.isNew ? '添加 provider' : `编辑 provider：${provider?.id ?? draft.id}`}
      width={680}
      centered
      destroyOnHidden
      maskClosable={false}
      okText="保存"
      cancelText="取消"
      confirmLoading={saving}
      onOk={submit}
      onCancel={onClose}
    >
      <Flexbox gap={12} style={{ maxHeight: '62vh', overflowY: 'auto', paddingInlineEnd: 4 }}>
        {saveError !== null && <Alert type="error" message="保存失败" description={saveError} />}

        {attempted && blocked && (
          <Alert
            type="warning"
            message="请先修正以下问题"
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

        <Field
          label="显示名称"
          hint={draft.isNew ? '用于界面展示，可留空' : '留空将保持 models.json 中的现有名称'}
        >
          <Input
            value={draft.name}
            placeholder="例如 自建网关"
            onChange={(event) => patch({ name: event.target.value })}
          />
        </Field>

        <Field
          label="Provider ID"
          error={attempted ? errors.id : undefined}
          hint={
            draft.isNew
              ? '保存后不可修改；只能使用字母、数字、点、下划线和连字符'
              : 'models.json 中的键名，本界面不支持重命名'
          }
        >
          {draft.isNew ? (
            <AutoComplete
              value={draft.id}
              placeholder="例如 my-gateway"
              options={existingIds.map((id) => ({ value: id }))}
              onChange={(value: string) => patch({ id: value })}
            />
          ) : (
            <Input value={draft.id} disabled />
          )}
        </Field>

        <Field
          label="Base URL"
          error={attempted ? errors.baseUrl : undefined}
          hint={
            draft.isNew
              ? '必填，例如 https://api.example.com/v1'
              : '接口不支持删除 baseUrl：留空将保持现有值'
          }
        >
          <Input
            value={draft.baseUrl}
            placeholder="https://api.example.com/v1"
            onChange={(event) => patch({ baseUrl: event.target.value })}
          />
        </Field>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="API 类型">
            <Select
              style={{ width: '100%' }}
              value={draft.api}
              options={PI_API_KINDS.map((kind) => ({ value: kind, label: PI_API_KIND_LABELS[kind] }))}
              onChange={(value: PiApiKind) => patch({ api: value })}
            />
          </Field>
          <Field
            label="authHeader"
            hint={
              authHeaderStuck ? (
                <Text fontSize={10.5} type="warning">
                  接口只能开启该项：保存后仍会保持开启，如需关闭请直接编辑 models.json
                </Text>
              ) : (
                '在请求头中携带密钥（部分网关需要）'
              )
            }
          >
            <Switch
              size="small"
              checked={draft.authHeader}
              onChange={(checked) => patch({ authHeader: checked })}
            />
          </Field>
        </div>

        <Field
          label="API Key"
          hint={
            draft.apiKeyRemove
              ? '保存后将删除文件中已配置的密钥'
              : `${apiKeySummary(stored)}；留空则保持已配置的密钥不变`
          }
        >
          <Flexbox horizontal gap={6} align="center">
            <Input.Password
              value={draft.apiKey}
              style={{ flex: 1 }}
              placeholder="留空则保持已配置的密钥不变"
              onChange={(event) => patch({ apiKey: event.target.value, apiKeyRemove: false })}
            />
            {stored.has && !draft.apiKeyRemove && (
              <Button
                type="link"
                size="small"
                danger
                onClick={() => patch({ apiKey: '', apiKeyRemove: true })}
              >
                清除密钥
              </Button>
            )}
          </Flexbox>
        </Field>

        {draft.apiKeyRemove && (
          <Alert
            type="warning"
            closable
            message="保存后将从 models.json 中删除该 provider 的密钥"
            onClose={() => patch({ apiKeyRemove: false })}
          />
        )}

        <ModelListEditor
          models={draft.models}
          errors={attempted ? errors.models : {}}
          onAdd={addModel}
          onChange={patchModel}
          onRemove={removeModel}
        />
      </Flexbox>
    </Modal>
  );
}

/* ------------------------------------------------------------------- asserts */

/**
 * Usage assert: `ModelsDrawer` renders `<ProviderEditor {...props} />` with
 * exactly these props, so the public contract cannot change silently.
 */
const sampleEditorProps: ProviderEditorProps = {
  open: true,
  existingIds: ['cmdc'],
  onClose: () => {},
  onSaved: () => {},
};

export type ProviderEditorPropsAssertion = typeof sampleEditorProps;
