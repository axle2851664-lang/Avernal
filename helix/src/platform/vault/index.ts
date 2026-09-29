export type { ScanOptions } from './scan.js';

export { ROOT_GROUP, scanVault } from './scan.js';
export { existingCaptureSlugs, writeCapture } from './write.js';
export type { Note, NoteMeta, NotePatch } from './notepad.js';
export {
  NotepadError,
  listNotes,
  notePath,
  readNote,
  removeNote,
  searchNotes,
  updateNote,
} from './notepad.js';
