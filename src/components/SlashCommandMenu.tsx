/**
 * The composer's `/` control — dsh's `指令` button, and the command menu behind
 * it.
 *
 * The list comes from the bridge's `get_commands`, which returns pi's merged
 * command table: extension commands (`/plan`, `/todos`, …), prompt templates and
 * skills. Nothing here executes anything: picking an entry inserts `/name ` into
 * the composer, because pi already dispatches extension commands and expands
 * skill and template commands when the text is submitted as a prompt.
 *
 * Grouping mirrors where each command came from, so a user can tell the
 * difference between a command their own extension registered and a skill.
 */

import { Popover, theme } from 'antd';
import { useState } from 'react';

import type { PiSlashCommand } from '../shared/protocol';

/** Source labels, keyed by pi's own `source` values. */
const SOURCE_LABELS: Record<string, string> = {
  extension: '扩展',
  prompt: '提示词模板',
  skill: '技能',
};

export interface SlashCommandMenuProps {
  commands: PiSlashCommand[];
  disabled?: boolean;
  /** Insert `/name ` at the caret and focus the composer. */
  onPick: (command: PiSlashCommand) => void;
}

export function SlashCommandMenu({ commands, disabled = false, onPick }: SlashCommandMenuProps) {
  const { token } = theme.useToken();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const matches = commands.filter((command) => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return true;
    return `${command.name} ${command.description ?? ''}`.toLowerCase().includes(needle);
  });

  const content = (
    <div style={{ width: 300 }} onKeyDown={(event) => { if (event.key === 'Escape') setOpen(false); }}>
      <div style={{ padding: '2px 4px 6px' }}>
        <input
          autoFocus
          value={query}
          placeholder="搜索指令…"
          aria-label="搜索指令"
          onChange={(event) => { setQuery(event.target.value) }}
          style={{
            width: '100%',
            padding: '4px 8px',
            border: `1px solid ${token.colorBorder}`,
            borderRadius: token.borderRadius,
            background: token.colorBgContainer,
            color: token.colorText,
            fontSize: 12,
            outline: 'none',
          }}
        />
      </div>
      <div style={{ maxHeight: 280, overflowY: 'auto', overscrollBehavior: 'contain' }}>
        {matches.length === 0 ? (
          <p style={{ padding: '12px 8px', fontSize: 12, color: token.colorTextTertiary, margin: 0 }}>
            {commands.length === 0 ? '这个会话还没有可用指令' : '没有匹配的指令'}
          </p>
        ) : (
          matches.map((command) => (
            <button
              key={command.name}
              type="button"
              onClick={() => {
                onPick(command);
                setOpen(false);
              }}
              style={{
                display: 'block',
                width: '100%',
                padding: '6px 8px',
                borderStyle: 'none',
                borderRadius: token.borderRadius,
                background: 'transparent',
                color: 'inherit',
                fontFamily: 'inherit',
                textAlign: 'start',
                cursor: 'pointer',
              }}
            >
              <span style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0 }}>
                <span style={{ fontSize: 13, fontFamily: token.fontFamilyCode }}>
                  /{command.name}
                </span>
                {command.source !== undefined && (
                  <span style={{ fontSize: 10.5, color: token.colorTextQuaternary, flexShrink: 0 }}>
                    {SOURCE_LABELS[command.source] ?? command.source}
                  </span>
                )}
              </span>
              {command.description !== undefined && command.description.length > 0 && (
                <span
                  style={{
                    display: 'block',
                    marginTop: 1,
                    fontSize: 11,
                    color: token.colorTextTertiary,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {command.description}
                </span>
              )}
            </button>
          ))
        )}
      </div>
    </div>
  );

  return (
    <Popover
      trigger="click"
      placement="topLeft"
      arrow={false}
      destroyOnHidden
      open={open && !disabled}
      onOpenChange={(next) => {
        if (disabled) return;
        if (next) setQuery('');
        setOpen(next);
      }}
      content={content}
      styles={{ container: { padding: 8 }, content: { padding: 0 } }}
    >
      <button
        type="button"
        disabled={disabled}
        aria-label="指令"
        title="指令"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 4,
          height: 24,
          paddingInline: 6,
          borderStyle: 'none',
          borderRadius: token.borderRadius,
          background: 'transparent',
          color: open ? token.colorText : token.colorTextSecondary,
          fontFamily: token.fontFamilyCode,
          fontSize: 14,
          lineHeight: 1,
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.5 : 1,
        }}
      >
        /
      </button>
    </Popover>
  );
}
