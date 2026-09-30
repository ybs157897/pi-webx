/**
 * Win32 folder-picker checks: the koffi COM sequencing, the child-process
 * driver, and the platform dispatch that reaches them, all against fakes, so
 * no lane needs a Windows host.
 *
 * The fake koffi mirrors the real library's pointer semantics — an address
 * decodes the bytes stored at that address, a Buffer decodes its own bytes —
 * because that is exactly where the ported string-reading path went wrong
 * upstream: copying the COM string's address into a scratch buffer before
 * decoding reads the pointer's own bytes and yields garbage. A real-koffi
 * parity check at the bottom pins that assumption on hosts that have koffi.
 * A real child process is spawned only on non-Windows hosts, where it can
 * prove the tsx + IPC wiring without putting a modal dialog in a commit gate.
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CLSID_FILE_OPEN_DIALOG,
  SLOT_GET_DISPLAY_NAME,
  SLOT_GET_RESULT,
  SLOT_RELEASE,
  SLOT_SET_FOLDER,
  SLOT_SET_OPTIONS,
  SLOT_SET_TITLE,
  SLOT_SHOW,
  closeThreadWindows,
  guidBytes,
  loadWin32DialogBindings,
  type Koffi,
} from '../server/directory-picker/win32-bindings';
import {
  DIALOG_TITLE,
  HRESULT_CANCELLED,
  runFolderDialog,
  type Win32DialogBindings,
} from '../server/directory-picker/win32-dialog';
import {
  pickWin32Directory,
  type Win32DialogInternals,
  type Win32PickOptions,
  type Win32WorkerLike,
} from '../server/directory-picker/win32-driver';
import type { Win32WorkerMessage } from '../server/directory-picker/win32-worker';
import { DirectoryPickerUnsupportedError, pickNativeDirectory } from '../server/directory-picker/native-picker';

/* --------------------------------------------------------------- the fakes */

/** Every out-parameter and side effect the bindings can produce, in call order. */
interface ComWorld {
  pointerSize: number;
  coInitHr: number;
  coCreateHr: number;
  showHr: number;
  getResultHr: number;
  getDisplayNameHr: number;
  shCreateItemHr: number;
  hasThreadDpi: boolean;
  supportedDpiContexts: number[];
  path: string;
  trace: string[];
  options: number[];
  titles: string[];
  folders: string[];
  str16Reads: string[];
  freed: bigint[];
  released: string[];
  posted: Array<{ hwnd: string; message: number }>;
  dpiContexts: number[];
  keyEvents: Array<{ vk: number; flags: number }>;
  registered: number;
  unregistered: number;
}

function comWorld(overrides: Partial<ComWorld> = {}): ComWorld {
  return {
    pointerSize: 8,
    coInitHr: 0, coCreateHr: 0, showHr: 0, getResultHr: 0, getDisplayNameHr: 0, shCreateItemHr: 0,
    hasThreadDpi: true, supportedDpiContexts: [-4],
    path: 'C:\\Users\\picked\\agent-workspace',
    trace: [], options: [], titles: [], folders: [], str16Reads: [], freed: [],
    released: [], posted: [], dpiContexts: [], keyEvents: [],
    registered: 0, unregistered: 0,
    ...overrides,
  };
}

const E_FAIL = 0x80004005 | 0;

/** A bump allocator whose blocks stay readable by address. */
class FakeMemory {
  private blocks: Array<{ start: bigint; bytes: Buffer }> = [];
  private next = 0x1_000n;

  alloc(bytes: Buffer): bigint {
    const start = this.next;
    this.next = (start + BigInt(bytes.length) + 0xfn) & ~0xfn;
    this.blocks.push({ start, bytes });
    return start;
  }

  /** Allocate at a fixed address, which is how the fake's COM objects are placed. */
  allocAt(start: bigint, bytes: Buffer): bigint {
    assert.ok(start >= this.next, `fake allocations overlap at 0x${start.toString(16)}`);
    this.next = (start + BigInt(bytes.length) + 0xfn) & ~0xfn;
    this.blocks.push({ start, bytes });
    return start;
  }

  blockOf(address: bigint): { start: bigint; bytes: Buffer } {
    const block = this.blocks.find(candidate => address >= candidate.start
      && address < candidate.start + BigInt(candidate.bytes.length));
    assert.ok(block, `no fake allocation covers 0x${address.toString(16)}`);
    return block;
  }

  write(address: bigint, bytes: Buffer): void {
    const block = this.blockOf(address);
    bytes.copy(block.bytes, Number(address - block.start));
  }
}

/**
 * One vtable slot as the fake records it. `self` is the COM receiver; the rest
 * is declared `never[]` so a slot may narrow each argument it actually uses.
 */
type SlotImpl = (self: unknown, ...rest: never[]) => unknown;

/** One pointer cell, honouring the process's pointer width. */
const asBytes = (value: bigint, width: number): Buffer => {
  const bytes = Buffer.alloc(width);
  for (let i = 0; i < width; i += 1) bytes[i] = Number((value >> BigInt(8 * i)) & 0xffn);
  return bytes;
};

const fromBytes = (bytes: Buffer): bigint => {
  let value = 0n;
  for (let i = bytes.length - 1; i >= 0; i -= 1) value = (value << 8n) | BigInt(bytes[i] as number);
  return value;
};

/** Read the UTF-16 text starting at an address, up to its NUL. */
function readString16At(bytes: Buffer): string {
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    if (bytes.readUInt16LE(i) === 0) return bytes.subarray(0, i).toString('utf16le');
  }
  throw new Error('fake world: UTF-16 string is not NUL-terminated');
}

/** A COM object: a block whose first pointer is its vtable address. */
interface ComObject {
  address: bigint;
  vtable: Map<number, SlotImpl>;
}

/**
 * Build the in-memory COM world the koffi bindings drive. Both the dialog and
 * the shell items it produces expose only the slots the real port calls, so an
 * off-by-one vtable slot hits a missing slot instead of silently succeeding.
 */
function fakeKoffi(
  world: ComWorld,
  objects: { dialog: ComObject; selectionItem: ComObject; folderItem: ComObject },
): Koffi {
  const memory = new FakeMemory();
  const functions = new Map<bigint, (...args: unknown[]) => unknown>();
  const callbacks = new Map<bigint, (...args: unknown[]) => number>();
  const pathByItem = new Map<bigint, string>();
  const width = (): number => world.pointerSize;

  const readPointer = (address: bigint): bigint => {
    const block = memory.blockOf(address);
    return fromBytes(block.bytes.subarray(Number(address - block.start), Number(address - block.start) + width()));
  };
  const writePointer = (address: bigint, value: bigint): void => {
    memory.write(address, asBytes(value, width()));
  };
  const readCell = (buffer: Buffer): bigint => {
    assert.equal(buffer.length, width(), 'a pointer cell is exactly one pointer wide');
    return fromBytes(buffer);
  };
  const writeCell = (buffer: Buffer, value: bigint): void => {
    assert.equal(buffer.length, width(), 'a pointer cell is exactly one pointer wide');
    asBytes(value, width()).copy(buffer, 0);
  };

  const install = (object: ComObject): void => {
    const slots = [...object.vtable.keys()];
    assert.ok(slots.length > 0, 'an object needs at least one slot');
    const vtableBytes = Buffer.alloc(width() * (Math.max(...slots) + 1));
    for (const slot of slots) {
      const address = memory.alloc(Buffer.alloc(1));
      functions.set(address, object.vtable.get(slot) as (...args: unknown[]) => unknown);
      asBytes(address, width()).copy(vtableBytes, slot * width());
    }
    const vtable = memory.alloc(vtableBytes);
    memory.allocAt(object.address, Buffer.alloc(width()));
    writePointer(object.address, vtable);
  };

  const dialogSlots = new Map<number, SlotImpl>([
    [SLOT_SHOW, () => { world.trace.push('Show'); return world.showHr; }],
    [SLOT_RELEASE, () => { world.trace.push('Release dialog'); world.released.push('dialog'); return 0; }],
    [SLOT_SET_OPTIONS, (_self: unknown, options: unknown) => {
      world.options.push(options as number);
      world.trace.push('SetOptions');
      return 0;
    }],
    [SLOT_SET_FOLDER, (_self: unknown, item: unknown) => {
      const path = pathByItem.get(item as bigint);
      assert.ok(path !== undefined, 'SetFolder received an item this world never produced');
      world.folders.push(path);
      world.trace.push('SetFolder');
      return 0;
    }],
    [SLOT_SET_TITLE, (_self: unknown, title: unknown) => {
      world.titles.push(title as string);
      world.trace.push('SetTitle');
      return 0;
    }],
    [SLOT_GET_RESULT, (_self: unknown, out: Array<unknown>) => {
      world.trace.push('GetResult');
      if (world.getResultHr < 0) return world.getResultHr;
      out[0] = objects.selectionItem.address;
      return 0;
    }],
  ]);
  // The shell item GetResult hands back: a path to read, then release.
  const selectionSlots = new Map<number, SlotImpl>([
    [SLOT_RELEASE, () => { world.trace.push('Release item'); world.released.push('item'); return 0; }],
    [SLOT_GET_DISPLAY_NAME, (_self: unknown, form: unknown, out: Array<unknown>) => {
      world.trace.push('GetDisplayName');
      assert.equal(form, 0x80058000, 'GetDisplayName must ask for SIGDN_FILESYSPATH');
      if (world.getDisplayNameHr < 0) return world.getDisplayNameHr;
      out[0] = stringAddress;
      return 0;
    }],
  ]);

  // The shell item SHCreateItemFromParsingName produces for SetFolder.
  const folderSlots = new Map<number, SlotImpl>([
    [SLOT_RELEASE, () => { world.trace.push('Release folder item'); world.released.push('folder-item'); return 0; }],
  ]);

  // The COM string GetDisplayName hands out, allocated once per world.
  const stringAddress = memory.alloc(Buffer.from(`${world.path}\u0000`, 'utf16le'));

  objects.dialog.vtable = dialogSlots;
  objects.selectionItem.vtable = selectionSlots;
  objects.folderItem.vtable = folderSlots;
  install(objects.dialog);
  install(objects.selectionItem);
  install(objects.folderItem);

  return {
    load: (dll: string) => ({
      func: (_convention: string, name: string) => {
        switch (`${dll}:${name}`) {
          case 'ole32.dll:CoInitializeEx': return () => { world.trace.push('CoInitializeEx'); return world.coInitHr; };
          case 'ole32.dll:CoUninitialize': return () => { world.trace.push('CoUninitialize'); };
          case 'ole32.dll:CoCreateInstance': return (clsid: Buffer, _unknown: unknown, _context: number, iid: Buffer, out: Buffer) => {
            world.trace.push('CoCreateInstance');
            assert.equal(clsid.toString('hex'), guidBytes(CLSID_FILE_OPEN_DIALOG).toString('hex'),
              'CoCreateInstance must ask for CLSID_FileOpenDialog');
            assert.equal(iid.length, 16, 'the IID is a 16-byte GUID');
            if (world.coCreateHr < 0) return world.coCreateHr;
            writeCell(out, objects.dialog.address);
            return 0;
          };
          case 'ole32.dll:CoTaskMemFree': return (pointer: unknown) => {
            world.trace.push('CoTaskMemFree');
            world.freed.push(pointer as bigint);
          };
          case 'shell32.dll:SHCreateItemFromParsingName': return (path: string, _pbc: unknown, riid: Buffer, out: Buffer) => {
            world.trace.push('SHCreateItemFromParsingName');
            assert.equal(riid.length, 16, 'SHCreateItemFromParsingName takes a 16-byte IID');
            if (world.shCreateItemHr < 0) return world.shCreateItemHr;
            pathByItem.set(objects.folderItem.address, path);
            writeCell(out, objects.folderItem.address);
            return 0;
          };
          case 'kernel32.dll:GetCurrentThreadId': return () => 31_337;
          case 'user32.dll:keybd_event': return (vk: number, _scan: number, flags: number, _extra: unknown) => {
            world.keyEvents.push({ vk, flags });
            world.trace.push(flags === 0 ? 'alt-down' : 'alt-up');
          };
          case 'user32.dll:SetThreadDpiAwarenessContext': {
            if (!world.hasThreadDpi) throw new Error('SetThreadDpiAwarenessContext not found');
            return (context: number) => {
              world.dpiContexts.push(context);
              world.trace.push(`dpi:${context}`);
              return world.supportedDpiContexts.includes(context) ? { previous: 'context' } : null;
            };
          }
          case 'user32.dll:EnumThreadWindows': return (threadId: number, callback: bigint, _lparam: unknown) => {
            world.trace.push('EnumThreadWindows');
            const impl = callbacks.get(BigInt(callback));
            assert.ok(impl, 'EnumThreadWindows received an unregistered callback');
            assert.equal(threadId, 31_337, 'the driver closes the thread the dialog reported');
            impl('hwnd-1');
            impl('hwnd-2');
            return 1;
          };
          case 'user32.dll:PostMessageW': return (hwnd: unknown, message: number) => {
            world.posted.push({ hwnd: String(hwnd), message });
            return 1;
          };
          default: throw new Error(`unexpected native import ${dll}:${name}`);
        }
      },
    }),
    proto: (declaration: string) => ({ declaration }),
    pointer: (type: unknown) => type,
    sizeof: (type: string) => {
      assert.equal(type, 'void *');
      return world.pointerSize;
    },
    decode: (value: unknown, offsetOrType: unknown, type?: unknown): unknown => {
      if (typeof offsetOrType === 'number') {
        assert.equal(type, 'void *', 'the vtable read decodes exactly one pointer');
        assert.equal(offsetOrType % world.pointerSize, 0, `vtable offset ${offsetOrType} is not pointer-aligned`);
        return readPointer((value as bigint) + BigInt(offsetOrType));
      }
      assert.equal(type, undefined, 'the two-argument decode form carries no type');
      if (offsetOrType === 'void *') {
        return Buffer.isBuffer(value) ? readCell(value) : readPointer(value as bigint);
      }
      assert.equal(offsetOrType, 'str16', 'strings only ever decode as UTF-16');
      world.str16Reads.push(Buffer.isBuffer(value) ? 'buffer' : 'address');
      if (Buffer.isBuffer(value)) {
        // Real koffi decodes a Buffer's own bytes — the trap this fake exposes.
        return readString16At(value);
      }
      const block = memory.blockOf(value as bigint);
      return readString16At(block.bytes.subarray(Number((value as bigint) - block.start)));
    },
    call: (fn: unknown, _proto: unknown, ...args: unknown[]): unknown => {
      const impl = functions.get(fn as bigint);
      assert.ok(impl, `no fake function at 0x${(fn as bigint).toString(16)}`);
      return impl(...args);
    },
    register: (callback: (...args: unknown[]) => number, _type: unknown): bigint => {
      world.registered += 1;
      const address = 0x9000n + BigInt(world.registered);
      callbacks.set(address, callback);
      return address;
    },
    unregister: (callback: bigint): void => {
      world.unregistered += 1;
      callbacks.delete(BigInt(callback));
    },
  } as unknown as Koffi;
}

/** The dialog child process the driver talks to. */
class FakeWorker extends EventEmitter implements Win32WorkerLike {
  killed = false;
  unrefCount = 0;

  on(event: 'message' | 'error' | 'exit', listener: (value: never) => void): this {
    super.on(event, listener as unknown as (...args: unknown[]) => void);
    return this;
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }

  unref(): void {
    this.unrefCount += 1;
  }

  post(message: Win32WorkerMessage): void {
    this.emit('message', message);
  }
}

interface Harness {
  worker: FakeWorker;
  closed: number[];
  internals: Win32DialogInternals;
}

function harness(overrides: Partial<Win32DialogInternals> = {}): Harness {
  const worker = new FakeWorker();
  const closed: number[] = [];
  return {
    worker,
    closed,
    internals: {
      spawnWorker: () => worker,
      closeThreadWindows: async (threadId: number) => { closed.push(threadId); },
      closeRetryMs: 1,
      ...overrides,
    },
  };
}

const live = (): AbortSignal => new AbortController().signal;

async function bindingsFor(world: ComWorld): Promise<Win32DialogBindings> {
  const objects = {
    dialog: { address: 0x2_0000n, vtable: new Map() },
    selectionItem: { address: 0x3_0000n, vtable: new Map() },
    folderItem: { address: 0x4_0000n, vtable: new Map() },
  };
  return await loadWin32DialogBindings(fakeKoffi(world, objects));
}

/* ------------------------------------------------------- GUIDs and ABI slots */

assert.deepEqual([...guidBytes(CLSID_FILE_OPEN_DIALOG)],
  [0x9c, 0x5a, 0x1c, 0xdc, 0x8a, 0xe8, 0xde, 0x4d, 0xa5, 0xa1, 0x60, 0xf8, 0x2a, 0x20, 0xae, 0xf7],
  'CLSID_FileOpenDialog encodes little-endian');
assert.equal(guidBytes('43826d1e-e718-42ee-bc55-a1e261c37bfe').toString('hex'), '1e6d824318e7ee42bc55a1e261c37bfe',
  'IID_IShellItem keeps its four byte groups in order');
assert.deepEqual(
  [SLOT_SHOW, SLOT_RELEASE, SLOT_GET_DISPLAY_NAME, SLOT_SET_OPTIONS, SLOT_SET_FOLDER, SLOT_SET_TITLE, SLOT_GET_RESULT],
  [3, 2, 5, 9, 12, 17, 20],
  'the IFileDialog and IShellItem vtable slots are frozen Windows ABI');
assert.equal(HRESULT_CANCELLED, -2147023673, 'HRESULT_FROM_WIN32(ERROR_CANCELLED)');
assert.equal(DIALOG_TITLE, 'Select Workspace Directory');

/* ------------------------------------------------- COM sequencing over fakes */

{
  const world = comWorld();
  const bindings = await bindingsFor(world);
  const shown: number[] = [];
  const path = runFolderDialog(bindings, DIALOG_TITLE, 'C:\\Users\\yin\\work', (threadId) => { shown.push(threadId); });

  assert.equal(path, world.path);
  assert.deepEqual(shown, [31_337], 'the dialog thread id is reported before Show blocks');
  assert.deepEqual(world.options, [0x20 | 0x40 | 0x8], 'SetOptions must pick folders, force a filesystem path, and never change cwd');
  assert.deepEqual(world.folders, ['C:\\Users\\yin\\work'], 'SetFolder opens where the agent config said');
  assert.deepEqual(world.titles, [DIALOG_TITLE]);
  assert.deepEqual(world.keyEvents, [{ vk: 0x12, flags: 0 }, { vk: 0x12, flags: 0x2 }], 'one Alt press, down then up, just before Show');
  assert.deepEqual(world.dpiContexts, [-4], 'per-monitor-v2 is the first context tried');
  assert.deepEqual(world.str16Reads, ['address'], 'the COM string is read from its own address');
  assert.equal(world.freed.length, 1, 'the shell string is handed back to the COM allocator');
  assert.deepEqual(world.released, ['folder-item', 'item', 'dialog'],
    'the shell items and the dialog are all released');
  assert.deepEqual(world.trace.slice(-4), ['CoTaskMemFree', 'Release item', 'Release dialog', 'CoUninitialize'],
    'the string is freed, the objects released, and the apartment uninitialized');
  assert.ok(world.trace.indexOf('Show') < world.trace.indexOf('GetResult'), 'the result is read only after Show returns');
  assert.equal(world.trace.filter(entry => entry === 'CoUninitialize').length, 1, 'exactly one CoUninitialize');
}

{
  // A dismissed dialog is a null, not a failure, and still cleans up.
  const world = comWorld({ showHr: HRESULT_CANCELLED });
  const bindings = await bindingsFor(world);
  assert.equal(runFolderDialog(bindings, DIALOG_TITLE, null, () => undefined), null);
  assert.deepEqual(world.folders, [], 'no initial directory means no SetFolder');
  assert.deepEqual(world.released, ['dialog']);
  assert.equal(world.trace.at(-1), 'CoUninitialize');
}

for (const failure of [
  { world: comWorld({ showHr: E_FAIL }), what: 'Show' },
  { world: comWorld({ getResultHr: E_FAIL }), what: 'GetResult' },
  { world: comWorld({ getDisplayNameHr: E_FAIL }), what: 'GetDisplayName' },
  { world: comWorld({ coInitHr: E_FAIL }), what: 'CoInitializeEx' },
]) {
  const bindings = await bindingsFor(failure.world);
  assert.throws(() => runFolderDialog(bindings, DIALOG_TITLE, null, () => undefined),
    new RegExp(`${failure.what} failed: HRESULT 0x80004005`), `${failure.what} failures carry the HRESULT`);
  if (failure.what !== 'CoInitializeEx') {
    assert.ok(failure.world.released.includes('dialog'), 'a dialog created before the failure is still released');
    assert.equal(failure.world.trace.at(-1), 'CoUninitialize', 'the apartment is uninitialized on every path');
  } else {
    // COM requires the pairing only for a successful (including S_FALSE) init,
    // and the throw happens before the try that owns the finally.
    assert.equal(failure.world.trace.filter(entry => entry === 'CoUninitialize').length, 0,
      'a failed CoInitializeEx is never paired with a CoUninitialize');
  }
}

{
  // A shell that refuses the starting directory must not cost the picker.
  const world = comWorld({ shCreateItemHr: 0x80070043 | 0 });
  const bindings = await bindingsFor(world);
  assert.equal(runFolderDialog(bindings, DIALOG_TITLE, 'Z:\\unmapped', () => undefined), world.path);
  assert.deepEqual(world.folders, [], 'a failed SetFolder is dropped');
  assert.ok(world.trace.indexOf('SetOptions') < world.trace.indexOf('SetTitle'));
}

{
  // ia32 has four-byte pointers: slots are byte offsets, not slot numbers.
  const world = comWorld({ pointerSize: 4 });
  const bindings = await bindingsFor(world);
  assert.equal(runFolderDialog(bindings, DIALOG_TITLE, 'C:\\work', () => undefined), world.path);
  assert.deepEqual(world.folders, ['C:\\work']);
}

{
  // Pre-1607 hosts lack the DPI API; the modern picker still runs.
  const world = comWorld({ hasThreadDpi: false });
  const bindings = await bindingsFor(world);
  assert.equal(runFolderDialog(bindings, DIALOG_TITLE, null, () => undefined), world.path);
  assert.deepEqual(world.dpiContexts, []);
}

{
  // A host that only accepts system DPI awareness cascades down to it.
  const world = comWorld({ supportedDpiContexts: [-2] });
  const bindings = await bindingsFor(world);
  runFolderDialog(bindings, DIALOG_TITLE, null, () => undefined);
  assert.deepEqual(world.dpiContexts, [-4, -3, -2]);
}

/* ---------------------------------------------------------- the abort lever */

{
  const world = comWorld();
  const objects = {
    dialog: { address: 0x2_0000n, vtable: new Map() },
    selectionItem: { address: 0x3_0000n, vtable: new Map() },
    folderItem: { address: 0x4_0000n, vtable: new Map() },
  };
  await closeThreadWindows(fakeKoffi(world, objects), 31_337);
  assert.deepEqual(world.posted, [
    { hwnd: 'hwnd-1', message: 0x10 },
    { hwnd: 'hwnd-2', message: 0x10 },
  ], 'every window of the dialog thread receives WM_CLOSE');
  assert.deepEqual([world.registered, world.unregistered], [1, 1], 'the enum callback is unregistered');
}

/* ----------------------------------------------------------------- driver */

{
  const first = harness();
  const picked = pickWin32Directory({ initial: null, signal: live() }, first.internals);
  first.worker.post({ kind: 'showing', threadId: 7 });
  first.worker.post({ kind: 'done', path: 'C:\\picked' });
  assert.equal(await picked, 'C:\\picked');
  assert.deepEqual(first.closed, [], 'a pick the user answered never touches the abort path');

  const second = harness();
  const cancelled = pickWin32Directory({ initial: null, signal: live() }, second.internals);
  second.worker.post({ kind: 'done', path: null });
  assert.equal(await cancelled, null, 'a dismissed dialog is a null');
}

{
  const failing = harness();
  const failingPick = pickWin32Directory({ signal: live() }, failing.internals);
  failing.worker.post({ kind: 'error', message: 'CoCreateInstance failed: HRESULT 0x80040111' });
  await assert.rejects(failingPick, /win32 folder dialog failed: CoCreateInstance failed/, 'the child failure is wrapped, not swallowed');

  const dying = harness();
  const dyingPick = pickWin32Directory({ signal: live() }, dying.internals);
  dying.worker.emit('exit', 1);
  await assert.rejects(dyingPick, /child exited before reporting a result/);

  const broken = harness();
  const brokenPick = pickWin32Directory({ signal: live() }, broken.internals);
  broken.worker.emit('error', new Error('MODULE_NOT_FOUND: koffi'));
  await assert.rejects(brokenPick, /MODULE_NOT_FOUND: koffi/, 'a spawn failure surfaces as-is');
}

{
  // Abort while the dialog is up: close its window and let it unwind.
  const controller = new AbortController();
  const active = harness();
  const aborted = pickWin32Directory({ signal: controller.signal }, active.internals);
  active.worker.post({ kind: 'showing', threadId: 4242 });
  controller.abort();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(active.closed.length > 1, `WM_CLOSE is re-posted while the child unwinds (got ${active.closed.length})`);
  assert.ok(active.closed.every(threadId => threadId === 4242), 'only the dialog thread is closed');
  active.worker.post({ kind: 'done', path: null });
  await assert.rejects(aborted, /aborted/, 'a pick cancelled by the caller never reports a path');
  assert.equal(active.worker.unrefCount, 1, 'the child is unreffed once the pick settles');
}

{
  // Abort before `showing`: no window exists yet, so the kill backstop ends it.
  const controller = new AbortController();
  const early = harness();
  const aborted = pickWin32Directory({ signal: controller.signal }, early.internals);
  controller.abort();
  await assert.rejects(aborted, /dialog unresponsive; child killed/);
  assert.equal(early.worker.killed, true, 'the child is force-killed rather than left on screen');
  assert.deepEqual(early.closed, [], 'nothing is closed before a thread id exists');
}

{
  await assert.rejects(pickWin32Directory({ signal: AbortSignal.abort() }, harness().internals),
    /aborted/, 'a caller that already went away never spawns a child');
}

/* ---------------------------------------------------------------- dispatch */

{
  const seen: Array<{ command: string; args: readonly string[] }> = [];
  const run = async (command: string, args: readonly string[]): Promise<string> => {
    seen.push({ command, args });
    return '/Users/yin/work\n';
  };
  assert.equal(await pickNativeDirectory({ initial: process.cwd(), signal: live() }, { platform: 'darwin', run }),
    '/Users/yin/work');
  assert.equal(seen[0]?.command, 'osascript');
  assert.ok(seen[0]?.args[1]?.includes(`default location POSIX file "${process.cwd()}"`),
    'darwin opens the chooser at the current directory');

  const cancelled = async (): Promise<string> => {
    // Node reports osascript's dismissal as exit 1 with the text on stderr.
    throw Object.assign(new Error('Command failed'), { code: 1, stderr: 'execution error: User canceled. (-128)' });
  };
  assert.equal(await pickNativeDirectory({ signal: live() }, { platform: 'darwin', run: cancelled }), null,
    'a dismissed AppleScript chooser is a null');

  assert.equal(await pickNativeDirectory({ signal: live() }, { platform: 'linux', run }), '/Users/yin/work');
  await assert.rejects(pickNativeDirectory({ signal: live() }, {
    platform: 'linux',
    run: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
  }), (error: unknown) => error instanceof DirectoryPickerUnsupportedError && error.message.includes('linux'),
    'a Linux host with neither zenity nor kdialog reports that it has no picker');
  await assert.rejects(pickNativeDirectory({ signal: live() }, { platform: 'freebsd' }),
    (error: unknown) => error instanceof DirectoryPickerUnsupportedError && error.message.includes('freebsd'),
    'unknown platforms refuse rather than pretend');
}

{
  const seen: Array<Win32PickOptions> = [];
  assert.equal(await pickNativeDirectory({ signal: live() }, {
    platform: 'win32',
    pickWin32Dialog: async (options) => { seen.push(options); return 'C:\\Users\\yin\\work'; },
  }), 'C:\\Users\\yin\\work');
  assert.equal(seen[0]?.initial, undefined, 'a non-directory initial path is not forwarded to the dialog');

  assert.equal(await pickNativeDirectory({ initial: process.cwd(), signal: live() }, {
    platform: 'win32',
    pickWin32Dialog: async (options) => options.initial ?? null,
  }), process.cwd(), 'an existing directory is forwarded to the dialog');

  await assert.rejects(pickNativeDirectory({ signal: live() }, {
    platform: 'win32',
    pickWin32Dialog: async () => { throw new Error('win32 folder dialog failed: koffi missing'); },
  }), /win32 folder dialog failed/, 'a win32 picker failure is not rewritten into an unsupported platform');
}

/* ------------------------------------------------- real child-process wiring */

const realChildRuns = process.platform !== 'win32';
if (!realChildRuns) {
  // The real dialog is modal: opening it here would block a commit gate. The
  // lanes above own the protocol; Windows hosts run the picker for real.
  console.log('skip real win32 dialog on the Windows lane (a modal chooser must not gate a commit)');
} else {
  const root = mkdtempSync(join(tmpdir(), 'pi-webx-win32-picker-'));
  try {
    const settled = await Promise.race([
      pickWin32Directory({ initial: root, signal: live() }).then(
        (path: string | null) => ({ message: `resolved ${String(path)}` }),
        (error: unknown) => ({ message: error instanceof Error ? error.message : String(error) }),
      ),
      new Promise<{ message: string }>(resolve => setTimeout(() => resolve({ message: 'TIMEOUT' }), 60_000)),
    ]);
    assert.match(settled.message, /win32 folder dialog failed/, 'the child reports why it cannot open a Windows dialog');
    assert.ok(!settled.message.includes('TIMEOUT'), 'the pick settles instead of hanging');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------- real koffi parity */

{
  // Pin the semantics the port depends on: an address decodes the bytes stored
  // there, while a Buffer decodes its own bytes. A port that copies the string
  // address into a scratch buffer first reads the pointer itself instead.
  let koffi: Koffi | undefined;
  try {
    koffi = (await import('koffi')).default;
  } catch {
    console.log('skip koffi string parity check (koffi is not installed)');
  }
  if (koffi !== undefined) {
    const address = koffi.alloc('uint16', 16);
    koffi.encode(address, 'str16', 'C:\\Users\\picked\\agent-workspace');
    assert.equal(koffi.decode(address, 'str16'), 'C:\\Users\\picked\\agent-workspace',
      'koffi decodes a string from the address it points at');
    const scratch = Buffer.alloc(koffi.sizeof('void *'));
    scratch.writeBigUInt64LE(BigInt(address as bigint));
    assert.notEqual(koffi.decode(scratch, 'str16'), 'C:\\Users\\picked\\agent-workspace',
      'decoding a scratch buffer holding the address reads the pointer itself, not the string');
  }
}

console.log('ok   win32 directory picker: GUIDs and vtable slots, COM sequencing, WM_CLOSE abort service, platform dispatch'
  + (realChildRuns ? ', real child-process wiring and koffi string parity' : ' and koffi string parity'));
