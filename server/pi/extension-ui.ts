/** Browser UI transport. A child receives scoped dialogs, never host session controls. */
import { randomUUID } from 'node:crypto';
import type { ExtensionUIContext, ExtensionUIDialogOptions, ExtensionWidgetOptions } from '@earendil-works/pi-coding-agent';
import type { PiExtensionUiRequest, PiExtensionUiResponse, SubagentUiOrigin } from '../../src/shared/protocol';

export interface PendingExtensionDialog {
  request: PiExtensionUiRequest;
  createdAt: number;
  respond(response: PiExtensionUiResponse): void;
}

export interface ExtensionUiOwner {
  readonly pendingDialogs: Map<string, PendingExtensionDialog>;
  isAlive(): boolean;
  publish(request: PiExtensionUiRequest): void;
}

export interface ExtensionUiScope {
  readonly context: ExtensionUIContext;
  dispose(): void;
}

export function createExtensionUiScope(
  owner: ExtensionUiOwner,
  scope?: { origin: SubagentUiOrigin; signal: AbortSignal },
): ExtensionUiScope {
  let disposed = false;
  const dialogs = new Set<string>();
  const statuses = new Set<string>();
  const widgets = new Set<string>();
  const keyFor = (key: string): string => scope === undefined ? key : `subagent:${scope.origin.runId}:${key}`;
  const publish = (payload: Partial<PiExtensionUiRequest>): void => {
    owner.publish({ type: 'extension_ui_request', id: randomUUID(), ...payload,
      ...(scope === undefined ? {} : { origin: scope.origin }) } as PiExtensionUiRequest);
  };
  const active = (): boolean => !disposed && owner.isAlive() && scope?.signal.aborted !== true;
  const emit = (payload: Partial<PiExtensionUiRequest>): void => { if (active()) publish(payload); };
  const label = (text: string): string => scope === undefined ? text : `[${scope.origin.agentName}] ${text}`;

  const ask = (
    method: 'select' | 'confirm' | 'input' | 'editor', payload: Partial<PiExtensionUiRequest>,
    options?: ExtensionUIDialogOptions, fallback?: string | boolean,
  ): Promise<string | boolean | undefined> => {
    if (!active()) return Promise.reject(new Error('会话已关闭或子智能体已停止，不能发起交互。'));
    const signal = options?.signal && scope?.signal
      ? AbortSignal.any([options.signal, scope.signal]) : options?.signal ?? scope?.signal;
    const id = randomUUID();
    const request = {
      type: 'extension_ui_request', id, method, ...payload,
      ...(payload.title === undefined ? {} : { title: label(payload.title) }),
      ...(options?.timeout === undefined ? {} : { timeout: options.timeout }),
      ...(scope === undefined ? {} : { origin: scope.origin }),
    } as PiExtensionUiRequest;
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (value: string | boolean | undefined, cancelled = false, failure?: unknown): void => {
        if (settled) return;
        settled = true;
        dialogs.delete(id);
        owner.pendingDialogs.delete(id);
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        try { publish({ id, method: 'close_dialog' }); } catch { /* The subscriber may already be gone. */ }
        // A cancelled child interaction must never look like a user decision.
        if (failure !== undefined) reject(failure);
        else if (cancelled && (scope !== undefined || method === 'select')) {
          reject(signal?.reason ?? new Error('用户取消了交互'));
        } else resolve(value);
      };
      const onAbort = (): void => settle(fallback, true);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) { onAbort(); return; }
      if (options?.timeout !== undefined && options.timeout > 0) {
        timer = setTimeout(() => settle(fallback, true), options.timeout);
      }
      dialogs.add(id);
      owner.pendingDialogs.set(id, {
        request, createdAt: Date.now(),
        respond: (response) => {
          if (response.cancelled) settle(fallback, true);
          else if (method === 'confirm') settle(response.confirmed === true);
          else settle(response.value);
        },
      });
      try { owner.publish(request); }
      catch (error) { settle(fallback, true, error); }
    });
  };
  const terminalOnly = (): void => undefined;
  const editComposer = (text: string): void => {
    if (scope !== undefined) throw new Error('子智能体不能修改父会话输入框。');
    emit({ method: 'set_editor_text', text });
  };
  const context = {
    select: (title: string, options: string[], opts?: ExtensionUIDialogOptions) => ask('select', { title, options: [...options] }, opts),
    confirm: async (title: string, message: string, opts?: ExtensionUIDialogOptions) => (await ask('confirm', { title, message }, opts, false)) === true,
    input: (title: string, placeholder?: string, opts?: ExtensionUIDialogOptions) => ask('input', { title, placeholder }, opts),
    editor: (title: string, prefill?: string) => ask('editor', { title, prefill }),
    notify: (message: string, notifyType?: 'info' | 'warning' | 'error') => emit({ method: 'notify', message: label(message), notifyType }),
    setStatus: (key: string, statusText?: string) => {
      const statusKey = keyFor(key); statuses.add(statusKey);
      emit({ method: 'setStatus', statusKey, statusText });
    },
    setWidget: (key: string, content: unknown, options?: ExtensionWidgetOptions) => {
      if (content !== undefined && !Array.isArray(content)) return;
      const widgetKey = keyFor(key); widgets.add(widgetKey);
      emit({ method: 'setWidget', widgetKey, widgetLines: content as string[] | undefined, widgetPlacement: options?.placement });
    },
    setEditorText: editComposer, pasteToEditor: editComposer, getEditorText: () => '',
    onTerminalInput: () => terminalOnly,
    addAutocompleteProvider: terminalOnly, setWorkingMessage: terminalOnly,
    setWorkingVisible: terminalOnly, setWorkingIndicator: terminalOnly,
    setHiddenThinkingLabel: terminalOnly, setFooter: terminalOnly, setHeader: terminalOnly,
    setTitle: terminalOnly, setEditorComponent: terminalOnly,
    custom: () => Promise.reject(new Error('this host has no terminal UI')),
  } as unknown as ExtensionUIContext;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    scope?.signal.removeEventListener('abort', dispose);
    for (const id of [...dialogs]) owner.pendingDialogs.get(id)?.respond({ type: 'extension_ui_response', id, cancelled: true });
    for (const statusKey of statuses) {
      try { publish({ method: 'setStatus', statusKey }); } catch { /* Best-effort teardown. */ }
    }
    for (const widgetKey of widgets) {
      try { publish({ method: 'setWidget', widgetKey }); } catch { /* Best-effort teardown. */ }
    }
  };
  scope?.signal.addEventListener('abort', dispose, { once: true });
  if (scope?.signal.aborted) dispose();
  return { context, dispose };
}
