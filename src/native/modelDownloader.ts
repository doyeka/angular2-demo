import * as FS from 'expo-file-system/legacy';
import { type ModelEntry, modelUrl } from '../core/llm/models';

const DIR = `${FS.documentDirectory}models/`;
const pathFor = (m: ModelEntry) => `${DIR}${m.file}`;
const resumePath = (m: ModelEntry) => `${DIR}${m.file}.resume.json`;

export type DownloadState =
  | { status: 'absent' }
  | { status: 'downloading'; written: number; total: number }
  | { status: 'paused'; written: number; total: number }
  | { status: 'ready'; path: string }
  | { status: 'error'; message: string };

export async function modelState(m: ModelEntry): Promise<DownloadState> {
  const info = await FS.getInfoAsync(pathFor(m));
  if (info.exists && info.size === m.sizeBytes) return { status: 'ready', path: pathFor(m) };
  const resume = await FS.getInfoAsync(resumePath(m));
  if (resume.exists) return { status: 'paused', written: info.exists ? info.size : 0, total: m.sizeBytes };
  return { status: 'absent' };
}

/**
 * Resumable download (multi-GB over flaky mobile links). Resume data is
 * persisted next to the file so a killed app continues where it stopped.
 * Integrity: exact byte size from the registry is checked on completion.
 */
export class ModelDownload {
  private task: FS.DownloadResumable | null = null;
  private m: ModelEntry;
  private onState: (s: DownloadState) => void;

  constructor(m: ModelEntry, onState: (s: DownloadState) => void) {
    this.m = m;
    this.onState = onState;
  }

  async start(): Promise<void> {
    await FS.makeDirectoryAsync(DIR, { intermediates: true }).catch(() => {});
    const saved = await FS.readAsStringAsync(resumePath(this.m)).catch(() => null);
    const cb = (p: FS.DownloadProgressData) =>
      this.onState({ status: 'downloading', written: p.totalBytesWritten, total: p.totalBytesExpectedToWrite || this.m.sizeBytes });
    this.task = FS.createDownloadResumable(modelUrl(this.m), pathFor(this.m), {}, cb, saved ? JSON.parse(saved).resumeData : undefined);
    try {
      const res = saved ? await this.task.resumeAsync() : await this.task.downloadAsync();
      if (!res) return; // paused
      const info = await FS.getInfoAsync(pathFor(this.m));
      if (!info.exists || info.size !== this.m.sizeBytes) {
        await FS.deleteAsync(pathFor(this.m), { idempotent: true });
        throw new Error(`Size mismatch: got ${info.exists ? info.size : 0}, expected ${this.m.sizeBytes}`);
      }
      await FS.deleteAsync(resumePath(this.m), { idempotent: true });
      this.onState({ status: 'ready', path: pathFor(this.m) });
    } catch (e) {
      this.onState({ status: 'error', message: (e as Error).message });
    }
  }

  async pause(): Promise<void> {
    if (!this.task) return;
    const snap = await this.task.pauseAsync();
    await FS.writeAsStringAsync(resumePath(this.m), JSON.stringify(snap));
    const info = await FS.getInfoAsync(pathFor(this.m));
    this.onState({ status: 'paused', written: info.exists ? info.size : 0, total: this.m.sizeBytes });
  }
}

export async function deleteModel(m: ModelEntry): Promise<void> {
  await FS.deleteAsync(pathFor(m), { idempotent: true });
  await FS.deleteAsync(resumePath(m), { idempotent: true });
}
