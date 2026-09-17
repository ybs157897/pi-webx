/**
 * One provider row of the models drawer: identity and base URL on the left;
 * credential dot, model count and the overflow menu on the right. Clicking the
 * row asks the drawer to open the editor, and both menu actions are reported
 * upward — the row itself never writes anything.
 */

import { ActionIcon, Block, Flexbox, Icon, Text, Tooltip } from '@lobehub/ui';
import { Dropdown, Tag, theme } from 'antd';
import type { MenuProps } from 'antd';
import { Ellipsis, Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { apiKeyTooltip } from '../../lib/modelsConfig';
import type { ApiKeyView, ProviderView } from '../../shared/models-config';

const TAG_STYLE = {
  fontSize: 10,
  lineHeight: '16px',
  marginInlineEnd: 0,
  paddingInline: 5,
} as const;

/** Green when a credential is configured, gray otherwise; the tooltip says how. */
function CredentialDot({ apiKey }: { apiKey: ApiKeyView }) {
  const { token } = theme.useToken();
  return (
    <Tooltip title={apiKeyTooltip(apiKey)}>
      <span
        aria-hidden
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

export interface ProviderRowProps {
  provider: ProviderView;
  onEdit: () => void;
  onDelete: () => void;
}

export function ProviderRow({ provider, onEdit, onDelete }: ProviderRowProps) {
  const { token } = theme.useToken();
  const [hovered, setHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const items: MenuProps['items'] = [
    { key: 'edit', label: '编辑', icon: <Icon icon={Pencil} size={13} /> },
    { type: 'divider' },
    { key: 'delete', label: '删除', danger: true, icon: <Icon icon={Trash2} size={13} /> },
  ];

  const handleMenuClick: NonNullable<MenuProps['onClick']> = ({ key, domEvent }) => {
    domEvent.stopPropagation();
    if (key === 'edit') onEdit();
    else onDelete();
  };

  return (
    <Block
      horizontal
      clickable
      align="center"
      gap={10}
      paddingBlock={8}
      paddingInline={10}
      variant="outlined"
      role="button"
      tabIndex={0}
      onClick={onEdit}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onEdit();
        }
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <Flexbox gap={2} allowShrink style={{ flex: 1, minWidth: 0 }}>
        <Flexbox horizontal align="center" gap={6} style={{ minWidth: 0 }}>
          <Text fontSize={13} weight={600} ellipsis noWrap style={{ minWidth: 0 }}>
            {provider.id}
          </Text>
          {provider.name !== undefined && provider.name.length > 0 && (
            <Text fontSize={11.5} type="secondary" ellipsis noWrap style={{ minWidth: 0 }}>
              {provider.name}
            </Text>
          )}
          <Tag style={TAG_STYLE}>{provider.api ?? '未指定 api'}</Tag>
        </Flexbox>
        {provider.baseUrl !== undefined && provider.baseUrl.length > 0 && (
          <div
            title={provider.baseUrl}
            style={{
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontFamily: token.fontFamilyCode,
              fontSize: 11,
              color: token.colorTextTertiary,
            }}
          >
            {provider.baseUrl}
          </div>
        )}
      </Flexbox>

      <Flexbox horizontal align="center" gap={8} style={{ flexShrink: 0 }}>
        <CredentialDot apiKey={provider.apiKey} />
        <Text fontSize={11} style={{ color: token.colorTextTertiary, whiteSpace: 'nowrap' }}>
          {`${provider.models.length} 个模型`}
        </Text>
        <Dropdown
          menu={{ items, onClick: handleMenuClick }}
          trigger={['click']}
          onOpenChange={(next) => setMenuOpen(next)}
        >
          <ActionIcon
            icon={Ellipsis}
            size="small"
            title="更多操作"
            onClick={(event) => event.stopPropagation()}
            style={{ opacity: hovered || menuOpen ? 1 : 0.55 }}
          />
        </Dropdown>
      </Flexbox>
    </Block>
  );
}

/* ------------------------------------------------------------------- asserts */

/**
 * Usage assert: `ModelsDrawer` renders `<ProviderRow {...props} />` with exactly
 * these props, so the row contract cannot change silently.
 */
const sampleRowProps: ProviderRowProps = {
  provider: {
    id: 'example',
    baseUrl: 'https://api.example.com/v1',
    api: 'openai-completions',
    apiKey: { has: true, source: 'env', preview: '$EXAMPLE_API_KEY' },
    models: [],
  },
  onEdit: () => {},
  onDelete: () => {},
};

export type ProviderRowPropsAssertion = typeof sampleRowProps;
