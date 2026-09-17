import { Flexbox, Text } from '@lobehub/ui';
import { Button, Input, Modal, theme } from 'antd';
import { ChevronUp, Folder } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { api } from '../lib/api';

/** Minimal directory browser: directories only, no file reads. */
export function DirectoryPicker({
  open,
  initialPath,
  suggested,
  onClose,
  onSelect,
}: {
  open: boolean;
  initialPath: string;
  suggested: string[];
  onClose: () => void;
  onSelect: (path: string) => void;
}) {
  const { token } = theme.useToken();
  const [path, setPath] = useState(initialPath);
  const [input, setInput] = useState(initialPath);
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<{ name: string; path: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (target: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.fsList(target);
      setPath(result.path);
      setInput(result.path);
      setParent(result.parent);
      setEntries(result.entries);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void load(initialPath);
  }, [open, initialPath, load]);

  return (
    <Modal
      open={open}
      title="选择工作目录"
      onCancel={onClose}
      width={620}
      footer={
        <Flexbox horizontal justify="flex-end" gap={8}>
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" onClick={() => onSelect(path)}>
            使用此目录
          </Button>
        </Flexbox>
      }
    >
      <Flexbox gap={12}>
        <Flexbox horizontal gap={8}>
          <Input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onPressEnter={() => void load(input)}
            placeholder="/absolute/path"
          />
          <Button onClick={() => void load(input)} loading={loading}>
            前往
          </Button>
        </Flexbox>

        {suggested.length > 0 && (
          <Flexbox horizontal gap={6} wrap="wrap">
            {suggested.slice(0, 8).map((candidate) => (
              <Button key={candidate} size="small" onClick={() => void load(candidate)}>
                {candidate.replace(/^\/Users\/[^/]+/, '~')}
              </Button>
            ))}
          </Flexbox>
        )}

        {error !== null && (
          <Text fontSize={12} style={{ color: token.colorError }}>
            {error}
          </Text>
        )}

        <div
          style={{
            height: 280,
            overflowY: 'auto',
            border: `1px solid ${token.colorBorderSecondary}`,
            borderRadius: token.borderRadius,
          }}
        >
          {parent !== null && (
            <div
              onClick={() => void load(parent)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 10px',
                cursor: 'pointer',
                fontSize: 12.5,
                borderBottom: `1px solid ${token.colorBorderSecondary}`,
              }}
            >
              <ChevronUp size={13} />
              ..
            </div>
          )}
          {entries.length === 0 && !loading && (
            <div style={{ padding: 12 }}>
              <Text fontSize={12} type="secondary">
                此目录下没有子目录
              </Text>
            </div>
          )}
          {entries.map((entry) => (
            <div
              key={entry.path}
              onClick={() => void load(entry.path)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 10px',
                cursor: 'pointer',
                fontSize: 12.5,
                color: token.colorText,
              }}
            >
              <Folder size={13} style={{ color: token.colorTextTertiary, flexShrink: 0 }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {entry.name}
              </span>
            </div>
          ))}
        </div>
      </Flexbox>
    </Modal>
  );
}
