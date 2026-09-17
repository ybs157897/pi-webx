/**
 * Model configuration drawer: pi's own `~/.pi/agent/models.json`, edited in
 * place through the bridge's models-config endpoints.
 *
 * Layout follows LobeChat's settings-models page in one drawer — one row per
 * provider (credential dot, model count, overflow menu) and a modal editor per
 * provider. Because pi watches that file, a successful write takes effect in the
 * pi CLI and in this UI at the same time, so every write reports upward through
 * `onChanged` and the body is re-rendered from the state the server returns.
 *
 * Keys never cross the wire: rows only ever describe *how* a credential is
 * supplied (`shell` / `$ENV` / stored / missing).
 */

import { ActionIcon, Alert, Flexbox, Text, Tooltip } from '@lobehub/ui';
import { App as AntApp, Button, Drawer, Empty, Modal, Spin, theme } from 'antd';
import type { ModalFuncProps } from 'antd';
import { Plus, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { errorMessage, modelsConfigApi, sortedProviders } from '../../lib/modelsConfig';
import type { ModelConfigResponse, ProviderView } from '../../shared/models-config';
import { ProviderEditor } from './ProviderEditor';
import { ProviderRow } from './ProviderRow';

/* ---------------------------------------------------------------- feedback */

/**
 * antd's context `modal`/`message` inherit the app theme; outside an `<App>` the
 * context default is an empty object, so fall back to the static Modal API.
 */
function useAntdFeedback(): {
  confirm: (config: ModalFuncProps) => void;
  notify: (content: ReactNode, kind: 'success' | 'error') => void;
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
      notify: (content: ReactNode, kind: 'success' | 'error') => {
        if (kind === 'error') message.error?.(content);
        else message.success?.(content);
      },
    };
  }, [app.message, app.modal]);
}

/* --------------------------------------------------------------- component */

export interface ModelsDrawerProps {
  open: boolean;
  onClose: () => void;
  /** called after every successful write so the parent can refresh pi state */
  onChanged?: () => void;
}

export function ModelsDrawer({ open, onClose, onChanged }: ModelsDrawerProps) {
  const { token } = theme.useToken();
  const { confirm, notify } = useAntdFeedback();

  const [config, setConfig] = useState<ModelConfigResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ key: string; provider?: ProviderView } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await modelsConfigApi.read();
      setConfig(next);
      setLoadError(null);
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, []);

  // The file is edited outside this drawer too (pi CLI, hand edits), so every
  // open starts from a fresh read; there is no cross-session cache to keep.
  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const providers = useMemo(() => sortedProviders(config), [config]);
  const providerIds = useMemo(() => providers.map((provider) => provider.id), [providers]);

  const applyWrite = useCallback(
    (next: ModelConfigResponse, note: string) => {
      setConfig(next);
      setLoadError(null);
      notify(note, 'success');
      onChanged?.();
    },
    [notify, onChanged],
  );

  const requestDelete = useCallback(
    (provider: ProviderView) => {
      confirm({
        title: '删除 provider',
        content: `确定要删除「${provider.id}」吗？它下面的 ${provider.models.length} 个模型会一并从 models.json 中移除。`,
        okText: '删除',
        okType: 'danger',
        cancelText: '取消',
        centered: true,
        onOk: async () => {
          try {
            const next = await modelsConfigApi.deleteProvider(provider.id);
            applyWrite(next, `已删除 provider「${provider.id}」`);
          } catch (error) {
            notify(errorMessage(error), 'error');
            await load();
          }
        },
      });
    },
    [applyWrite, confirm, load, notify],
  );

  const openEditor = useCallback((provider?: ProviderView) => {
    setEditor(provider === undefined ? { key: 'new' } : { key: provider.id, provider });
  }, []);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="模型配置"
      width={560}
      destroyOnHidden
      styles={{
        body: { display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' },
      }}
    >
      <Flexbox gap={12} style={{ flex: 1, minHeight: 0 }}>
        <Flexbox gap={4} style={{ flexShrink: 0 }}>
          <Flexbox horizontal align="center" gap={8}>
            <div
              title={config?.path ?? '~/.pi/agent/models.json'}
              style={{
                flex: 1,
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontFamily: token.fontFamilyCode,
                fontSize: 11.5,
                color: token.colorTextSecondary,
              }}
            >
              {config?.path ?? '~/.pi/agent/models.json'}
            </div>
            {config !== null && (
              <Tooltip title="每次写入成功后递增">
                <Text fontSize={10.5} style={{ color: token.colorTextQuaternary, whiteSpace: 'nowrap' }}>
                  {`修订 ${config.revision}`}
                </Text>
              </Tooltip>
            )}
            <ActionIcon
              icon={RefreshCw}
              size="small"
              spin={loading}
              title="重新读取 models.json"
              onClick={() => void load()}
            />
          </Flexbox>
          <Text fontSize={11.5} type="secondary" style={{ lineHeight: 1.6 }}>
            这是 pi 自己的模型配置文件（~/.pi/agent/models.json），pi CLI 与本界面共用，保存后即时生效。
          </Text>
        </Flexbox>

        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            overscrollBehavior: 'contain',
            paddingBlockEnd: 4,
          }}
        >
          {loadError !== null && (
            <Alert
              type="error"
              message="读取 models.json 失败"
              description={loadError}
              style={{ marginBlockEnd: 8 }}
            />
          )}

          {loading && config === null ? (
            <Flexbox align="center" justify="center" style={{ paddingBlock: 48 }}>
              <Spin />
            </Flexbox>
          ) : config === null ? (
            <Flexbox align="center" justify="center" gap={10} style={{ paddingBlock: 40 }}>
              <Text fontSize={11.5} type="secondary">
                读取失败，暂时无法显示 providers。
              </Text>
              <Button size="small" icon={<RefreshCw size={13} />} onClick={() => void load()}>
                重试
              </Button>
            </Flexbox>
          ) : providers.length === 0 ? (
            <Flexbox align="center" justify="center" gap={6} style={{ paddingBlock: 40 }}>
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有自定义模型" />
              <Text fontSize={11.5} style={{ color: token.colorTextQuaternary, textAlign: 'center' }}>
                models.json 里还没有 provider，点击下方「添加 provider」即可为 pi 增加自定义模型。
              </Text>
            </Flexbox>
          ) : (
            <Flexbox gap={8}>
              {providers.map((provider) => (
                <ProviderRow
                  key={provider.id}
                  provider={provider}
                  onEdit={() => openEditor(provider)}
                  onDelete={() => requestDelete(provider)}
                />
              ))}
            </Flexbox>
          )}
        </div>

        <Button
          block
          type="dashed"
          icon={<Plus size={14} />}
          style={{ flexShrink: 0 }}
          onClick={() => openEditor()}
        >
          添加 provider
        </Button>
      </Flexbox>

      {editor !== null && (
        <ProviderEditor
          key={editor.key}
          open
          {...(editor.provider !== undefined ? { provider: editor.provider } : {})}
          existingIds={providerIds}
          onClose={() => setEditor(null)}
          onSaved={(next, providerId) => {
            setEditor(null);
            applyWrite(next, `已保存 provider「${providerId}」`);
          }}
        />
      )}
    </Drawer>
  );
}

/* ------------------------------------------------------------------ asserts */

/**
 * Usage assert: the workspace shell renders `<ModelsDrawer {...props} />` with
 * exactly these props, so the public contract cannot change silently.
 */
const sampleDrawerProps: ModelsDrawerProps = {
  open: true,
  onClose: () => {},
  onChanged: () => {},
};

export type ModelsDrawerPropsAssertion = typeof sampleDrawerProps;
