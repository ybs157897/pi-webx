/**
 * koffi-backed Win32 bindings for the folder dialog: the COM vtable calls
 * behind {@link Win32DialogBindings} plus the cross-thread window closer the
 * driver uses to service aborts.
 *
 * Ported from deepseek-harness's `host/directory-picker-native`. koffi is not
 * imported here: the caller hands the module in, so loading this file on macOS
 * or Linux is free and only the win32 child process ever touches the native
 * library. The COM surface (`IFileOpenDialog` in pick-folders mode — the
 * Vista-and-later modern picker, not the legacy `SHBrowseForFolder` tree) is
 * frozen Windows ABI since Vista; vtable slots are byte offsets from the
 * object's first pointer, so they are 8 on x64/arm64 and 4 on ia32.
 *
 * Nothing goes through a shell: koffi calls the DLL exports directly, and a
 * directory whose name contains a quote, a space, or a `$` is just a string.
 */

/** koffi's default export, named so the signatures below read as types. */
export type Koffi = typeof import('koffi')['default'];
/** koffi's prototype record — what `koffi.proto()` hands back. */
type TypeObject = ReturnType<typeof import('koffi')['proto']>;

import { runFolderDialog, type Win32DialogBindings, type Win32FolderDialog } from './win32-dialog';

const COINIT_APARTMENTTHREADED = 0x2;
const CLSCTX_INPROC_SERVER = 0x1;
const SIGDN_FILESYSPATH = 0x80058000;
/**
 * Thread DPI awareness contexts, best first: per-monitor-v2 (Windows 10
 * 1703+), per-monitor (1607+), then system-aware. `SetThreadDpiAwarenessContext`
 * returns NULL for an unsupported context instead of throwing, so the caller
 * cascades to the best one the host accepts; DPI stays a cosmetic best-effort —
 * an unsupported host still gets the modern dialog.
 */
const DPI_AWARENESS_CONTEXTS = [-4, -3, -2];
const WM_CLOSE = 0x10;
/** `VK_MENU`: the synthesized Alt press's virtual key. */
const VK_MENU = 0x12;
/** `KEYEVENTF_KEYUP`: the synthesized Alt press's release flag. */
const KEYEVENTF_KEYUP = 0x2;

/** IFileOpenDialog vtable slots (IUnknown 0-2, IModalWindow 3, IFileDialog 4+). */
export const SLOT_RELEASE = 2;
export const SLOT_SHOW = 3;
export const SLOT_SET_FOLDER = 12;
export const SLOT_SET_OPTIONS = 9;
export const SLOT_SET_TITLE = 17;
export const SLOT_GET_RESULT = 20;
/** IShellItem vtable slot for `GetDisplayName`. */
export const SLOT_GET_DISPLAY_NAME = 5;

/** `CLSID_FileOpenDialog`. */
export const CLSID_FILE_OPEN_DIALOG = 'dc1c5a9c-e88a-4dde-a5a1-60f82a20aef7';
/** `IID_IFileOpenDialog`. */
const IID_IFILE_OPEN_DIALOG = 'd57c7288-d4ad-4768-be02-9d969532d960';
/** `IID_IShellItem`. */
const IID_ISHELLITEM = '43826d1e-e718-42ee-bc55-a1e261c37bfe';

/**
 * Encode a canonical GUID string as its 16 little-endian bytes.
 * @param text - the `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` form.
 * @returns the in-memory GUID bytes `CoCreateInstance` expects.
 */
export function guidBytes(text: string): Buffer {
  const match = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/i.exec(text) as RegExpExecArray;
  const bytes = Buffer.alloc(16);
  bytes.writeUInt32LE(parseInt(match[1] as string, 16), 0);
  bytes.writeUInt16LE(parseInt(match[2] as string, 16), 4);
  bytes.writeUInt16LE(parseInt(match[3] as string, 16), 6);
  Buffer.from((match[4] as string) + (match[5] as string), 'hex').copy(bytes, 8);
  return bytes;
}

/**
 * Read a COM string allocation as its UTF-16 text.
 *
 * koffi's `decode(ptr, 'str16')` reads the characters stored AT `ptr`, and an
 * `_Out_ void **` comes back as that native address — so the address decodes
 * directly. Copying the address into a scratch buffer first (as a natural
 * looking `decode(buffer, 'str16')` would) reads the pointer's own bytes and
 * hands back garbage, which is why this stays one call.
 * @param koffi - the loaded koffi binding.
 * @param address - the string address an `_Out_ void **` surfaced.
 * @returns the decoded string.
 */
function readString16(koffi: Koffi, address: unknown): string {
  return koffi.decode(address, 'str16') as string;
}

/** Load koffi from the running process' packages. */
export async function importKoffi(): Promise<Koffi> {
  return (await import('koffi')).default;
}

/**
 * Load koffi and expose the dialog bindings for this thread.
 * @param koffi - the koffi module (injected so tests can fake the DLL layer).
 * @returns the bindings {@link runFolderDialog} sequences against.
 */
export async function loadWin32DialogBindings(koffi: Koffi): Promise<Win32DialogBindings> {
  const ole32 = koffi.load('ole32.dll');
  const shell32 = koffi.load('shell32.dll');
  const user32 = koffi.load('user32.dll');
  const kernel32 = koffi.load('kernel32.dll');

  // Vtable slots and out-pointers are pointer-width offsets: 8 on x64/arm64,
  // 4 on ia32 — koffi reports the running process's width.
  const pointerSize = koffi.sizeof('void *');
  const coInitializeEx = ole32.func('__stdcall', 'CoInitializeEx', 'int32', ['void *', 'uint32']);
  const coUninitialize = ole32.func('__stdcall', 'CoUninitialize', 'void', []);
  const coCreateInstance = ole32.func('__stdcall', 'CoCreateInstance', 'int32', ['void *', 'void *', 'uint32', 'void *', 'void *']);
  const coTaskMemFree = ole32.func('__stdcall', 'CoTaskMemFree', 'void', ['void *']);
  const shCreateItemFromParsingName = shell32.func('__stdcall', 'SHCreateItemFromParsingName', 'int32', ['str16', 'void *', 'void *', 'void *']);
  const getCurrentThreadId = kernel32.func('__stdcall', 'GetCurrentThreadId', 'uint32', []);
  const keybdEvent = user32.func('__stdcall', 'keybd_event', 'void', ['uint8', 'uint8', 'uint32', 'uintptr']);

  const protoShow = koffi.proto('int32 __stdcall PwDialogShow(void *self, void *owner)');
  const protoSetOptions = koffi.proto('int32 __stdcall PwDialogSetOptions(void *self, uint32 options)');
  const protoSetFolder = koffi.proto('int32 __stdcall PwDialogSetFolder(void *self, void *item)');
  const protoSetTitle = koffi.proto('int32 __stdcall PwDialogSetTitle(void *self, str16 title)');
  const protoGetResult = koffi.proto('int32 __stdcall PwDialogGetResult(void *self, _Out_ void **item)');
  const protoGetDisplayName = koffi.proto('int32 __stdcall PwItemGetDisplayName(void *self, int32 form, _Out_ void **name)');
  const protoRelease = koffi.proto('uint32 __stdcall PwComRelease(void *self)');

  /** Bind vtable slot `slot` of COM object `self` to a caller through `proto`. */
  const method = (self: unknown, slot: number, proto: TypeObject): ((...args: unknown[]) => number) => {
    const vtable = koffi.decode(self, 'void *');
    const fn = koffi.decode(vtable, slot * pointerSize, 'void *');
    return (...args: unknown[]) => koffi.call(fn, proto, self, ...args) as number;
  };

  /**
   * Turn a filesystem path into the `IShellItem` `SetFolder` wants, or null
   * when the shell refuses the path (a mapped-but-disconnected drive, say).
   */
  const createShellItem = (directory: string): unknown => {
    const riid = Buffer.from(guidBytes(IID_ISHELLITEM));
    const out = Buffer.alloc(pointerSize);
    const created = shCreateItemFromParsingName(directory, null, riid, out) as number;
    if (created < 0) throw new Error(`SHCreateItemFromParsingName("${directory}") failed: HRESULT 0x${(created >>> 0).toString(16)}`);
    return koffi.decode(out, 'void *');
  };

  return {
    setThreadDpiAwareness: () => {
      let setContext;
      try {
        setContext = user32.func('__stdcall', 'SetThreadDpiAwarenessContext', 'void *', ['intptr']);
      } catch {
        // Symbol absent (pre-1607 Windows): no per-thread DPI control exists.
        // Proceed anyway — the cost is a blurry dialog above 100 % scaling on
        // museum hosts, and the modern picker still beats dropping to a
        // cosmetic concern.
        return;
      }
      for (const context of DPI_AWARENESS_CONTEXTS) {
        if (setContext(context) !== null) return;
      }
      // Unreachable in practice (SYSTEM_AWARE is accepted wherever the symbol
      // exists); if a host ever refuses everything, the dialog still works —
      // just without a DPI opt-in.
    },
    coInitializeSta: () => coInitializeEx(null, COINIT_APARTMENTTHREADED) as number,
    coUninitialize: () => {
      coUninitialize();
    },
    currentThreadId: () => getCurrentThreadId() as number,
    pressAltForForeground: () => {
      keybdEvent(VK_MENU, 0, 0, 0);
      keybdEvent(VK_MENU, 0, KEYEVENTF_KEYUP, 0);
    },
    createFolderDialog: (): Win32FolderDialog => {
      const out = Buffer.alloc(pointerSize);
      const created = coCreateInstance(
        Buffer.from(guidBytes(CLSID_FILE_OPEN_DIALOG)),
        null,
        CLSCTX_INPROC_SERVER,
        Buffer.from(guidBytes(IID_IFILE_OPEN_DIALOG)),
        out,
      ) as number;
      if (created < 0) throw new Error(`CoCreateInstance(FileOpenDialog) failed: HRESULT 0x${(created >>> 0).toString(16)}`);
      const dialog = koffi.decode(out, 'void *');
      return {
        setOptions: options => method(dialog, SLOT_SET_OPTIONS, protoSetOptions)(options),
        setFolder: directory => {
          let item: unknown;
          try {
            item = createShellItem(directory);
          } catch {
            // A shell that refuses the starting directory costs the location,
            // not the picker: the dialog opens at its own default instead.
            return;
          }
          try {
            method(dialog, SLOT_SET_FOLDER, protoSetFolder)(item);
          } finally {
            method(item, SLOT_RELEASE, protoRelease)();
          }
        },
        setTitle: title => method(dialog, SLOT_SET_TITLE, protoSetTitle)(title),
        show: () => method(dialog, SLOT_SHOW, protoShow)(null),
        resultPath: () => {
          const itemOut: unknown[] = [null];
          const gotItem = method(dialog, SLOT_GET_RESULT, protoGetResult)(itemOut);
          if (gotItem < 0) return { hr: gotItem };
          const item = itemOut[0];
          try {
            const nameOut: unknown[] = [null];
            const gotName = method(item, SLOT_GET_DISPLAY_NAME, protoGetDisplayName)(SIGDN_FILESYSPATH, nameOut);
            if (gotName < 0) return { hr: gotName, what: 'GetDisplayName' };
            const path = readString16(koffi, nameOut[0]);
            coTaskMemFree(nameOut[0]);
            return { hr: gotName, path };
          } finally {
            method(item, SLOT_RELEASE, protoRelease)();
          }
        },
        release: () => {
          method(dialog, SLOT_RELEASE, protoRelease)();
        },
      };
    },
  };
}

/**
 * Post `WM_CLOSE` to every window of a native thread — the driver's abort
 * lever against a child blocked inside `Show`, after which `Show` returns
 * `HRESULT_CANCELLED`, which the dialog sequencing treats as a cancellation.
 * @param koffi - the koffi module (injected so tests can fake the DLL layer).
 * @param threadId - the dialog thread's native id (from the `showing` notice).
 */
export async function closeThreadWindows(koffi: Koffi, threadId: number): Promise<void> {
  const user32 = koffi.load('user32.dll');
  const enumThreadWindows = user32.func('__stdcall', 'EnumThreadWindows', 'int', ['uint32', 'void *', 'intptr']);
  const postMessageW = user32.func('__stdcall', 'PostMessageW', 'int', ['void *', 'uint32', 'uintptr', 'intptr']);
  const protoEnumProc = koffi.proto('int __stdcall PwEnumThreadWndProc(void *hwnd, intptr lparam)');
  const callback = koffi.register((hwnd: unknown) => {
    postMessageW(hwnd, WM_CLOSE, 0, 0);
    return 1;
  }, koffi.pointer(protoEnumProc));
  try {
    enumThreadWindows(threadId, callback, 0);
  } finally {
    koffi.unregister(callback);
  }
}
