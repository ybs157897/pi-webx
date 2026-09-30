/**
 * The native directory chooser behind `POST /api/workspace/pick`.
 *
 * The original path (`server/directory-picker.ts`) became this barrel so the
 * route keeps importing `./directory-picker` unchanged, mirroring
 * `server/agent-definitions/`.
 */

export {
  DirectoryPickerUnsupportedError,
  pickNativeDirectory,
  type DirectoryCommandRunner,
  type DirectoryPickerInternals,
  type PickNativeDirectoryOptions,
} from './native-picker';
