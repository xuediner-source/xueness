import { deferComposerAttachmentAbort, deferComposerAttachmentRelease } from './composerAttachmentCleanup';
import { registerComposerAttachmentInvalidator } from './composerAttachmentLifecycle';
import { COMPOSER_REF_LIMITS as LIMITS, isDurableImageMime, attachmentBaseName, attachmentMime, parseAttachmentRef, type AttachmentOrigin, type AttachmentRef, type ComposerAttachment } from "./composerAttachmentRef";
import { canonicalUploadOwner, uploadComposerAttachment, type UploadInput, type UploadOwner, type UploadTransport } from "./composerAttachmentUpload";

export type AttachmentUploadState = "queued" | "uploading" | "ready" | "failed";
export type AttachmentUploadItem = {
  id: string; name: string; mimeType: string; size: number; origin: AttachmentOrigin;
  state: AttachmentUploadState; uploadedBytes: number; progress: number; error?: string; ref?: AttachmentRef;
};
type Ephemeral = { file: File; uploadId: string; controller?: AbortController; pendingId?: string };
export type AttachmentUploadStoreOptions = {
  transport?: UploadTransport;
  upload?: (input: UploadInput) => Promise<AttachmentRef>;
};
const MEDIA = /^(image\/|video\/|application\/pdf$)/;

/** File and request lifetimes belong to the canonical draft, never to a mounted pane. */
export class ComposerAttachmentUploadStore {
  readonly owner: UploadOwner;
  private items: readonly AttachmentUploadItem[] = [];
  private listeners = new Set<() => void>();
  private ephemeral = new Map<string, Ephemeral>();
  private enabled = false;
  private generation: string | number = 0;
  private active = 0;
  private epoch = 0;
  private cleanupControllers = new Set<AbortController>();
  private disposalGuard: (id: string) => boolean = () => true;
  setDisposalGuard(guard: (id: string) => boolean): void { this.disposalGuard = guard; }
  constructor(owner: UploadOwner, private options: AttachmentUploadStoreOptions = {}) {
    this.owner = Object.freeze({ ...owner });
  }
  setTransport(transport?: UploadTransport): void { this.options.transport = transport; }
  getSnapshot = (): readonly AttachmentUploadItem[] => this.items;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); this.evictIfUnused(); };
  };
  private emit(): void { for (const listener of this.listeners) listener(); }
  private evictIfUnused(): void {
    // Disabled, empty and unobserved only. A ready ref or retained File may still belong to recovery.
    if (this.enabled || this.active || this.items.length || this.listeners.size || this.ephemeral.size
        || this.cleanupControllers.size) return;
    const key = canonicalUploadOwner(this.owner);
    if (stores.get(key) === this) stores.delete(key);
  }
  private patch(id: string, patch: Partial<AttachmentUploadItem>): void {
    this.items = this.items.map(item => item.id === id ? { ...item, ...patch } : item);
    this.emit();
  }
  setContext(context: { enabled: boolean; generation: string | number }): void {
    if (this.enabled === context.enabled && this.generation === context.generation) { this.evictIfUnused(); return; }
    const invalidated = this.enabled && (!context.enabled || this.generation !== context.generation);
    this.enabled = context.enabled;
    this.generation = context.generation;
    if (invalidated) {
      this.epoch++;
      for (const runtime of this.ephemeral.values()) runtime.controller?.abort();
      for (const controller of this.cleanupControllers) controller.abort();
      this.cleanupControllers.clear();
      this.items = this.items.map(item => item.state === "queued" || item.state === "uploading"
        ? { ...item, state: "failed", error: "Upload paused. Retry when this draft is active." } : item);
      this.emit();
    }
    this.pump();
    this.evictIfUnused();
  }
  enqueue(files: readonly File[], origin: Exclude<AttachmentOrigin, "workspace"> = "file"): { accepted: number; rejected: string[] } {
    const rejected: string[] = [];
    if (!this.enabled) return { accepted: 0, rejected: ["Attachment uploads are disabled."] };
    const limits = this.options.transport?.attachmentLimits;
    let accepted = 0;
    let total = this.items.reduce((sum, item) => sum + item.size, 0);
    let nonImageCount = this.items.filter(item => !isDurableImageMime(item.mimeType)).length;
    let nonImageMediaBytes = this.items.reduce((sum, item) => sum + (!isDurableImageMime(item.mimeType) && MEDIA.test(item.mimeType) ? item.size : 0), 0);
    const next = [...this.items];
    for (const file of files) {
      const mimeType = attachmentMime(file.name, file.type);
      if (!mimeType) { rejected.push("Unsupported attachment type."); continue; }
      const image = isDurableImageMime(mimeType);
      const media = MEDIA.test(mimeType);
      if (next.length >= Math.min(limits?.count ?? LIMITS.count, LIMITS.count) || !Number.isSafeInteger(file.size) || file.size < 0
          || file.size > (image ? Math.min(limits?.imageBytes ?? LIMITS.imageBytes, LIMITS.imageBytes) : media ? LIMITS.mediaBytes : LIMITS.textBytes)
          || (!image && nonImageCount >= LIMITS.nonImageCount)
          || (!image && media && nonImageMediaBytes + file.size > LIMITS.nonImageMediaBytes)
          || total + file.size > Math.min(limits?.totalBytes ?? LIMITS.totalBytes, LIMITS.totalBytes)) {
        rejected.push("Attachment limit exceeded (8 total; images 20 MiB each, 64 MiB total; up to 4 other files, PDF/video 2 MiB each and 4 MiB combined, text 64 KiB)."); continue;
      }
      const id = crypto.randomUUID();
      this.ephemeral.set(id, { file, uploadId: id });
      next.push({ id, name: attachmentBaseName(file.name), mimeType, size: file.size, origin,
        state: "queued", uploadedBytes: 0, progress: 0 });
      total += file.size;
      if (!image) nonImageCount++;
      if (!image && media) nonImageMediaBytes += file.size;
      accepted++;
    }
    this.items = next;
    this.emit();
    this.pump();
    return { accepted, rejected };
  }
  retry(id: string): void {
    const item = this.items.find(candidate => candidate.id === id);
    const runtime = this.ephemeral.get(id);
    if (!this.enabled || item?.state !== "failed" || !runtime || runtime.controller) return;
    this.patch(id, { state: "queued", error: undefined });
    this.pump();
  }
  remove(id: string): void {
    const runtime = this.ephemeral.get(id);
    const item = this.items.find(candidate => candidate.id === id);
    runtime?.controller?.abort();
    this.ephemeral.delete(id);
    this.items = this.items.filter(candidate => candidate.id !== id);
    this.emit();
    // Never release committed references here: pending submissions and recovery may still own them.
    if (runtime?.pendingId && item?.state !== "ready") {
      deferComposerAttachmentAbort(this.owner, runtime.pendingId, () => this.disposalGuard(runtime.pendingId!), this.options.transport);
    }
    this.pump();
    this.evictIfUnused();
  }
  getFile(id: string): File | undefined { return this.ephemeral.get(id)?.file; }
  isEnabled(): boolean { return this.enabled; }
  hasUnready(): boolean { return this.items.some(item => item.state !== "ready"); }
  readyAttachments(): ComposerAttachment[] {
    return this.items.flatMap(item => item.state === "ready" && item.ref
      ? [{ name: item.ref.name, mimeType: item.ref.mimeType, data: "", ref: item.ref }] : []);
  }
  /** Reconcile only committed refs; this never releases server data held by ACK/recovery. */
  syncReadyRefs(refs: readonly AttachmentRef[]): void {
    const valid = refs.map(parseAttachmentRef).filter((ref): ref is AttachmentRef => ref !== null);
    const ids = new Set(valid.map(ref => ref.id));
    const next = this.items.filter(item => item.state !== "ready" || (item.ref && ids.has(item.ref.id)));
    for (const ref of valid) {
      if (next.some(item => item.ref?.id === ref.id)) continue;
      next.push({ id: ref.id, name: ref.name, mimeType: ref.mimeType, size: ref.size, origin: ref.origin,
        state: "ready", uploadedBytes: ref.size, progress: 100, ref });
    }
    if (next.length === this.items.length && next.every((item, index) => item === this.items[index])) return;
    this.items = next;
    this.emit();
    this.evictIfUnused();
  }
  /** Explicit owner invalidation, unlike an ordinary pane unmount. No HTTP cleanup on disable. */
  invalidate(): void { this.setContext({ enabled: false, generation: this.generation }); }
  private pump(): void {
    if (!this.enabled) return;
    while (this.active < 2) {
      const item = this.items.find(candidate => candidate.state === "queued");
      if (!item) break;
      const runtime = this.ephemeral.get(item.id);
      if (!runtime) { this.patch(item.id, { state: "failed", error: "Please reattach this file." }); continue; }
      this.active++;
      runtime.controller = new AbortController();
      const controller = runtime.controller;
      const epoch = this.epoch;
      const generation = this.generation;
      const current = () => this.enabled && this.epoch === epoch && this.generation === generation
        && this.ephemeral.get(item.id) === runtime && !controller.signal.aborted;
      this.patch(item.id, { state: "uploading", error: undefined });
      void (this.options.upload ?? uploadComposerAttachment)({ owner: this.owner, file: runtime.file,
        origin: item.origin === "workspace" ? "file" : item.origin, uploadId: runtime.uploadId,
        signal: controller.signal, isCurrent: current, transport: this.options.transport,
        onProgress: progress => {
          if (!current()) return;
          runtime.pendingId = progress.ref.id;
          this.patch(item.id, { uploadedBytes: progress.uploadedBytes,
            progress: item.size ? Math.min(99, Math.floor(progress.uploadedBytes / item.size * 100)) : 0 });
        },
      }).then(ref => {
        if (!current()) {
          if (!this.items.some(candidate => candidate.id === item.id)) {
            deferComposerAttachmentRelease(this.owner, ref.id, () => this.disposalGuard(ref.id), this.options.transport);
          }
          return;
        }
        this.ephemeral.delete(item.id);
        this.patch(item.id, { state: "ready", ref, progress: 100, uploadedBytes: item.size });
      }).catch(error => {
        if (!current()) return;
        this.patch(item.id, { state: "failed", error: error instanceof Error ? error.message : "Attachment upload failed." });
      }).finally(() => {
        if (runtime.controller === controller) runtime.controller = undefined;
        this.active--;
        this.pump();
        this.evictIfUnused();
      });
    }
  }
}

const stores = new Map<string, ComposerAttachmentUploadStore>();
export function getComposerAttachmentUploadStore(owner: UploadOwner, transport?: UploadTransport): ComposerAttachmentUploadStore {
  const key = canonicalUploadOwner(owner);
  let store = stores.get(key);
  if (!store) { store = new ComposerAttachmentUploadStore(owner, { transport }); stores.set(key, store); }
  if (transport) store.setTransport(transport);
  return store;
}
export function invalidateComposerAttachmentUploads(): void {
  for (const store of stores.values()) store.invalidate();
}

registerComposerAttachmentInvalidator(invalidateComposerAttachmentUploads);
