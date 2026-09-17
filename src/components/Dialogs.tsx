import { Flexbox, Text } from '@lobehub/ui';
import { Button, Input, Modal, Select, theme } from 'antd';
import { useEffect, useState } from 'react';

import type { PendingDialog } from '../lib/usePiSession';
import type { PiExtensionUiRequest } from '../shared/protocol';

const { TextArea } = Input;

/**
 * pi's extension UI sub-protocol. Dialog methods block the agent until the
 * client answers, so each one must either be responded to or cancelled —
 * `set_editor_text` and friends are handled by the session hook instead.
 */
function DialogBody({
  request,
  onRespond,
  onCancel,
}: {
  request: PiExtensionUiRequest;
  onRespond: (body: { value?: string; confirmed?: boolean }) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(request.method === 'editor' ? (request.prefill ?? '') : '');
  const [selected, setSelected] = useState<string | undefined>(request.options?.[0]);

  useEffect(() => {
    setValue(request.method === 'editor' ? (request.prefill ?? '') : '');
    setSelected(request.options?.[0]);
  }, [request]);

  switch (request.method) {
    case 'select':
      return (
        <Flexbox gap={12}>
          {request.title && <Text>{request.title}</Text>}
          <Select
            autoFocus
            value={selected}
            onChange={setSelected}
            style={{ width: '100%' }}
            options={(request.options ?? []).map((option) => ({ value: option, label: option }))}
          />
          <Flexbox horizontal justify="flex-end" gap={8}>
            <Button onClick={onCancel}>取消</Button>
            <Button
              type="primary"
              disabled={selected === undefined}
              onClick={() => {
                if (selected !== undefined) onRespond({ value: selected });
              }}
            >
              确定
            </Button>
          </Flexbox>
        </Flexbox>
      );

    case 'confirm':
      return (
        <Flexbox gap={16}>
          <Flexbox gap={4}>
            {request.title && <Text weight={600}>{request.title}</Text>}
            {request.message && <Text type="secondary">{request.message}</Text>}
          </Flexbox>
          <Flexbox horizontal justify="flex-end" gap={8}>
            <Button onClick={() => onRespond({ confirmed: false })}>否</Button>
            <Button type="primary" autoFocus onClick={() => onRespond({ confirmed: true })}>
              是
            </Button>
          </Flexbox>
        </Flexbox>
      );

    case 'editor':
      return (
        <Flexbox gap={12}>
          {request.title && <Text>{request.title}</Text>}
          <TextArea
            autoFocus
            value={value}
            onChange={(event) => setValue(event.target.value)}
            autoSize={{ minRows: 8, maxRows: 24 }}
          />
          <Flexbox horizontal justify="flex-end" gap={8}>
            <Button onClick={onCancel}>取消</Button>
            <Button type="primary" onClick={() => onRespond({ value })}>
              确定
            </Button>
          </Flexbox>
        </Flexbox>
      );

    case 'input':
    default:
      return (
        <Flexbox gap={12}>
          {request.title && <Text>{request.title}</Text>}
          <Input
            autoFocus
            value={value}
            placeholder={request.placeholder ?? ''}
            onChange={(event) => setValue(event.target.value)}
            onPressEnter={() => onRespond({ value })}
          />
          <Flexbox horizontal justify="flex-end" gap={8}>
            <Button onClick={onCancel}>取消</Button>
            <Button type="primary" onClick={() => onRespond({ value })}>
              确定
            </Button>
          </Flexbox>
        </Flexbox>
      );
  }
}

export function ExtensionDialogs({
  dialogs,
  onRespond,
}: {
  dialogs: PendingDialog[];
  onRespond: (
    id: string,
    body: { value?: string; confirmed?: boolean; cancelled?: boolean },
  ) => void;
}) {
  const { token } = theme.useToken();
  // pi blocks on the oldest request, so only that one is actionable.
  const current = dialogs[0];
  if (!current) return null;
  const { request } = current;

  const label =
    request.method === 'select'
      ? '选择'
      : request.method === 'confirm'
        ? '确认'
        : request.method === 'editor'
          ? '编辑内容'
          : '输入';

  return (
    <Modal
      open
      title={label}
      onCancel={() => onRespond(request.id, { cancelled: true })}
      footer={null}
      maskClosable={false}
      keyboard={false}
      width={request.method === 'editor' ? 720 : 480}
    >
      <DialogBody
        request={request}
        onRespond={(body) => onRespond(request.id, body)}
        onCancel={() => onRespond(request.id, { cancelled: true })}
      />
      {typeof request.timeout === 'number' && request.timeout > 0 && (
        <Text fontSize={11} type="secondary" style={{ marginTop: 12, color: token.colorTextQuaternary }}>
          {Math.round(request.timeout / 1000)} 秒未响应将自动取消
        </Text>
      )}
    </Modal>
  );
}
