/**
 * Searchable model browser ("pi 模型配置"): every model pi can run, grouped by
 * provider, with per-row actions to switch the running session onto a model or
 * to make it the default for newly created sessions.
 *
 * Purely presentational — both actions are reported upward through props, and
 * closing the drawer after a pick stays the parent's decision.
 */

import { Block, Flexbox, Text } from '@lobehub/ui';
import { Button, Drawer, Empty, Input, Spin, Tag, theme } from 'antd';
import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';

import { formatTokens } from '../lib/format';
import type { PiModel } from '../shared/protocol';
import { modelSelectionKey, sameModelSelection, type ModelSelection } from './ModelPicker';

export type { ModelSelection };

/* --------------------------------------------------------------------- helpers */

type ModelTag = { key: string; label: string; color?: string };

/** Capability hints pi reports per model; absent fields simply produce no tag. */
function modelTags(model: PiModel): ModelTag[] {
  const tags: ModelTag[] = [];

  const contextWindow = model.contextWindow;
  if (typeof contextWindow === 'number' && Number.isFinite(contextWindow) && contextWindow > 0) {
    tags.push({ key: 'context', label: `${formatTokens(contextWindow)} 上下文` });
  }

  const maxTokens = model.maxTokens;
  if (typeof maxTokens === 'number' && Number.isFinite(maxTokens) && maxTokens > 0) {
    tags.push({ key: 'max', label: `${formatTokens(maxTokens)} 输出` });
  }

  if (model.reasoning === true) tags.push({ key: 'reasoning', label: '推理', color: 'purple' });
  if (Array.isArray(model.input) && model.input.includes('image')) {
    tags.push({ key: 'image', label: '图像' });
  }

  return tags;
}

/* ------------------------------------------------------------------------- row */

const TAG_STYLE = {
  fontSize: 10,
  lineHeight: '16px',
  marginInlineEnd: 0,
  paddingInline: 5,
} as const;

interface ModelRowProps {
  model: PiModel;
  current: boolean;
  isDefault: boolean;
  onPick: (selection: ModelSelection) => void;
  onSetDefault: (selection: ModelSelection) => void;
}

/** One dense list item: identity on the left, actions on the right. */
function ModelRow({ model, current, isDefault, onPick, onSetDefault }: ModelRowProps) {
  const { token } = theme.useToken();
  const selection: ModelSelection = { provider: model.provider, id: model.id };
  const tags = modelTags(model);

  return (
    <Block
      horizontal
      clickable
      align="center"
      gap={12}
      paddingBlock={7}
      paddingInline={12}
      variant="borderless"
      onClick={() => onPick(selection)}
      style={{
        borderRadius: 0,
        borderLeft: `2px solid ${current ? token.colorPrimary : 'transparent'}`,
        background: current ? token.colorPrimaryBg : undefined,
      }}
    >
      <Flexbox gap={3} style={{ flex: 1, minWidth: 0 }}>
        <Flexbox horizontal align="center" gap={6} style={{ minWidth: 0 }}>
          <Text fontSize={13} weight={600} ellipsis style={{ minWidth: 0 }}>
            {model.name || model.id}
          </Text>
          {current && (
            <Tag color="processing" style={TAG_STYLE}>
              当前
            </Tag>
          )}
          {isDefault && (
            <Tag color="blue" style={TAG_STYLE}>
              默认
            </Tag>
          )}
        </Flexbox>

        <Flexbox horizontal align="center" gap={6} wrap="wrap" style={{ minWidth: 0 }}>
          <Text fontSize={11.5} type="secondary" style={{ fontFamily: token.fontFamilyCode }}>
            {model.id}
          </Text>
          {tags.map((tag) => (
            <Tag key={tag.key} color={tag.color} style={TAG_STYLE}>
              {tag.label}
            </Tag>
          ))}
        </Flexbox>
      </Flexbox>

      <Flexbox horizontal align="center" gap={2} style={{ flexShrink: 0 }}>
        <Button
          size="small"
          type="text"
          disabled={current}
          onClick={(event) => {
            event.stopPropagation();
            onPick(selection);
          }}
        >
          切换到此模型
        </Button>
        <Button
          size="small"
          type="text"
          disabled={isDefault}
          onClick={(event) => {
            event.stopPropagation();
            onSetDefault(selection);
          }}
        >
          设为默认
        </Button>
      </Flexbox>
    </Block>
  );
}

/* ------------------------------------------------------------------- component */

export interface ModelDrawerProps {
  open: boolean;
  models: PiModel[];
  current: ModelSelection | null;
  /** persisted default applied to newly created sessions */
  defaultModel: ModelSelection | null;
  loading?: boolean;
  onClose: () => void;
  onPick: (selection: ModelSelection) => void;
  onSetDefault: (selection: ModelSelection) => void;
}

export function ModelDrawer({
  open,
  models,
  current,
  defaultModel,
  loading = false,
  onClose,
  onPick,
  onSetDefault,
}: ModelDrawerProps) {
  const { token } = theme.useToken();
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return models;
    return models.filter((model) =>
      [model.name, model.provider, model.id].some(
        (field) => typeof field === 'string' && field.toLowerCase().includes(needle),
      ),
    );
  }, [models, query]);

  // Counts are small enough to render every row; the body scrolls instead.
  const sections = useMemo(() => {
    const byProvider = new Map<string, PiModel[]>();
    for (const model of filtered) {
      const list = byProvider.get(model.provider);
      if (list) list.push(model);
      else byProvider.set(model.provider, [model]);
    }

    return Array.from(byProvider.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([provider, list]) => ({
        provider,
        models: [...list].sort((left, right) =>
          (left.name || left.id).localeCompare(right.name || right.id),
        ),
      }));
  }, [filtered]);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title="模型库"
      placement="right"
      width={520}
      // Remounts the body on close so the search box starts clean next time.
      destroyOnHidden
      styles={{
        body: {
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          padding: 0,
          overflow: 'hidden',
        },
      }}
    >
      <Flexbox
        gap={6}
        paddingBlock={10}
        paddingInline={16}
        style={{ borderBottom: `1px solid ${token.colorBorderSecondary}` }}
      >
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="按名称、提供商或 ID 搜索"
          allowClear
          prefix={<Search size={13} style={{ color: token.colorTextTertiary }} />}
        />
        <Text fontSize={11} type="secondary">
          {`${filtered.length} / ${models.length} 个模型`}
        </Text>
      </Flexbox>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain' }}>
        {loading ? (
          <Flexbox align="center" justify="center" paddingBlock={48}>
            <Spin />
          </Flexbox>
        ) : sections.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            style={{ paddingBlock: 48 }}
            description={
              <Text fontSize={12} type="secondary">
                {models.length === 0 ? '暂无可用模型' : '没有匹配的模型'}
              </Text>
            }
          />
        ) : (
          sections.map((section) => (
            <div key={section.provider}>
              <Flexbox
                horizontal
                align="center"
                justify="space-between"
                paddingBlock={5}
                paddingInline={12}
                style={{
                  position: 'sticky',
                  top: 0,
                  zIndex: 1,
                  background: token.colorBgElevated,
                  borderBottom: `1px solid ${token.colorBorderSecondary}`,
                }}
              >
                <Text
                  fontSize={10.5}
                  weight={600}
                  type="secondary"
                  style={{ letterSpacing: 0.6, textTransform: 'uppercase' }}
                >
                  {section.provider}
                </Text>
                <Text fontSize={10.5} type="secondary">
                  {section.models.length}
                </Text>
              </Flexbox>

              {section.models.map((model) => (
                <ModelRow
                  key={modelSelectionKey(model)}
                  model={model}
                  current={sameModelSelection(current, model)}
                  isDefault={sameModelSelection(defaultModel, model)}
                  onPick={onPick}
                  onSetDefault={onSetDefault}
                />
              ))}
            </div>
          ))
        )}
      </div>
    </Drawer>
  );
}

/* ------------------------------------------------------- type-level smoke check */

/**
 * Not shipped behaviour, only intent: if this sample stops compiling, the public
 * prop contract changed. Kept as executable documentation in place of a test rig.
 */
const modelDrawerPropsSample: ModelDrawerProps = {
  open: true,
  models: [],
  current: null,
  defaultModel: null,
  onClose: () => {},
  onPick: () => {},
  onSetDefault: () => {},
};

export type ModelDrawerPropsAssertion = typeof modelDrawerPropsSample;
