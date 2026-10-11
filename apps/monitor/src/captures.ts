import { constants } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { TextDecoder } from 'node:util';
import {
  captureLimits as bounds,
  isCaptureRequest,
  isFileCapture,
  isWatchedPath,
  type CaptureBaseline,
  type CaptureRequest,
  type FileCapture,
  type CaptureMetricSample,
} from '../../../packages/contracts/private/file-capture.js';
import { MonitorError } from './types.js';

export interface WatchedFiles {
  configs: string[];
  logs: string[];
}
export interface Observation {
  text: string | null;
  incomplete: boolean;
  identity: string | null;
  size: number;
  observedSize: number;
}
const decoder = new TextDecoder('utf-8', { fatal: true });

/** Walk each directory by a held descriptor. NOFOLLOW on the final file alone
 * would still let a learner replace an ancestor with a link to Monitor secrets.
 * Linux /proc/self/fd keeps each opened parent stable during a rename race. */
export async function readWatchedFile(
  root: string,
  path: string,
  offset = 0,
  deadline = performance.now() + bounds.maximumReadMs,
): Promise<Observation> {
  if (!isWatchedPath(path) || !root.startsWith('/') || !Number.isSafeInteger(offset) || offset < 0)
    throw new MonitorError('invalid_config');
  const handles: FileHandle[] = [];
  const checkDeadline = () => {
    if (!Number.isFinite(deadline) || performance.now() >= deadline) throw new MonitorError('monitor_failed');
  };
  try {
    checkDeadline();
    let parent = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    handles.push(parent);
    const parts = path.slice(1).split('/');
    for (const part of parts.slice(0, -1)) {
      checkDeadline();
      parent = await open(
        `/proc/self/fd/${parent.fd}/${part}`,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      handles.push(parent);
    }
    checkDeadline();
    const file = await open(
      `/proc/self/fd/${parent.fd}/${parts.at(-1)!}`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    handles.push(file);
    checkDeadline();
    const stat = await file.stat();
    checkDeadline();
    if (!stat.isFile()) return { text: null, incomplete: true, identity: null, size: 0, observedSize: 0 };
    const position = offset > stat.size ? 0 : offset;
    const bytes = Buffer.alloc(bounds.maximumFileBytes + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, position);
    checkDeadline();
    let text: string;
    try {
      text = decoder.decode(bytes.subarray(0, Math.min(bytesRead, bounds.maximumFileBytes)));
    } catch {
      return {
        text: null,
        incomplete: true,
        identity: `${stat.dev}:${stat.ino}`,
        size: stat.size,
        observedSize: stat.size,
      };
    }
    return {
      text,
      incomplete: bytesRead > bounds.maximumFileBytes,
      identity: `${stat.dev}:${stat.ino}`,
      size: position + Math.min(bytesRead, bounds.maximumFileBytes),
      observedSize: stat.size,
    };
  } catch {
    return { text: null, incomplete: true, identity: null, size: 0, observedSize: 0 };
  } finally {
    for (const file of handles.reverse()) await file.close();
  }
}

/** Serialized interval observations. Captures never block or own terminal input. */
export class FileCaptures {
  private readonly watched: WatchedFiles;
  private tail: Promise<unknown> = Promise.resolve();
  private baselineResult: CaptureBaseline | undefined;
  private previousAt: string | undefined;
  private configs = new Map<string, Observation>();
  private logs = new Map<string, Observation>();
  private receipts = new Map<string, FileCapture>();
  private retainedBytes = 0;
  constructor(
    watched: WatchedFiles,
    private readonly root: string = bounds.root,
    private readonly now = () => new Date().toISOString(),
    private readonly metric = (): CaptureMetricSample | null => null,
  ) {
    const paths = [...watched.configs, ...watched.logs];
    if (paths.length > bounds.maximumPaths || new Set(paths).size !== paths.length || !paths.every(isWatchedPath))
      throw new MonitorError('invalid_config');
    this.watched = structuredClone(watched);
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(operation);
    this.tail = next.catch(() => undefined);
    return next;
  }
  baseline(): Promise<CaptureBaseline> {
    return this.serial(async () => {
      if (this.baselineResult) return structuredClone(this.baselineResult);
      const baselineAt = this.now();
      const deadline = performance.now() + bounds.maximumReadMs;
      let incomplete = false;
      for (const path of this.watched.configs) {
        const value = await readWatchedFile(this.root, path, 0, deadline);
        this.configs.set(path, value);
        incomplete ||= value.incomplete;
      }
      for (const path of this.watched.logs) {
        const value = await readWatchedFile(this.root, path, 0, deadline);
        // Existing log history is not a missing post-read interval. Start new-log
        // capture at the observed end, rather than replaying a truncated prefix.
        this.logs.set(path, { ...value, size: value.observedSize });
        incomplete ||= value.identity === null;
      }
      this.previousAt = baselineAt;
      this.baselineResult = { baselineAt, incomplete };
      return structuredClone(this.baselineResult);
    });
  }
  capture(request: CaptureRequest): Promise<FileCapture> {
    if (!isCaptureRequest(request)) throw new MonitorError('invalid_boundary');
    request = { ...request };
    return this.serial(async () => {
      if (!this.baselineResult || !this.previousAt) throw new MonitorError('invalid_boundary');
      const saved = this.receipts.get(request.commandId);
      if (saved) {
        if (saved.commandSeq !== request.commandSeq) throw new MonitorError('invalid_boundary');
        return structuredClone(saved);
      }
      if (this.receipts.size >= bounds.maximumCaptures || this.retainedBytes >= bounds.maximumRetainedBytes)
        throw new MonitorError('record_limit');
      const startedAt = this.now();
      const deadline = performance.now() + bounds.maximumReadMs;
      const nextConfigs = new Map(this.configs);
      const nextLogs = new Map(this.logs);
      const result: FileCapture = {
        schemaVersion: 1,
        ...request,
        sequence: this.receipts.size + 1,
        baselineAt: this.previousAt,
        startedAt,
        completedAt: startedAt,
        files: [],
        logs: [],
        metrics: null,
        incomplete: this.baselineResult.incomplete,
      };
      for (const path of this.watched.configs) {
        const before = this.configs.get(path)!;
        const after = await readWatchedFile(this.root, path, 0, deadline);
        if (before.text !== after.text) result.files.push({ path, before: before.text, after: after.text });
        result.incomplete ||= after.incomplete;
        nextConfigs.set(path, after);
      }
      for (const path of this.watched.logs) {
        const before = this.logs.get(path)!;
        let after = await readWatchedFile(this.root, path, before.size, deadline);
        if (after.identity !== before.identity) {
          // Rotation can remove unread lines. Keep the new file, but do not
          // claim that the interval is complete.
          result.incomplete = true;
          after = await readWatchedFile(this.root, path, 0, deadline);
        }
        if (after.observedSize < before.size) result.incomplete = true;
        const lines = (after.text ?? '').split('\n');
        if (lines.at(-1) === '') lines.pop();
        if (lines.length > bounds.maximumLogLines) result.incomplete = true;
        if (lines.length) result.logs.push({ path, lines: lines.slice(0, bounds.maximumLogLines) });
        result.incomplete ||= after.incomplete;
        nextLogs.set(path, after);
      }
      try {
        result.metrics = structuredClone(this.metric());
      } catch {
        result.incomplete = true;
      }
      result.incomplete ||= result.metrics === null;
      result.completedAt = this.now();
      // Retain bounded before/after blocks, not an unbounded diff algorithm. A
      // renderer can display these blocks as a diff without changing attribution.
      while (Buffer.byteLength(JSON.stringify(result)) > bounds.maximumBytes) {
        result.incomplete = true;
        if (result.logs.length) result.logs.pop();
        else if (result.files.length) result.files.pop();
        else throw new MonitorError('monitor_failed');
      }
      if (this.retainedBytes + Buffer.byteLength(JSON.stringify(result)) > bounds.maximumRetainedBytes)
        throw new MonitorError('record_limit');
      if (!isFileCapture(result)) throw new MonitorError('monitor_failed');
      this.configs = nextConfigs;
      this.logs = nextLogs;
      this.receipts.set(request.commandId, result);
      this.retainedBytes += Buffer.byteLength(JSON.stringify(result));
      this.previousAt = startedAt;
      return structuredClone(result);
    });
  }
}
