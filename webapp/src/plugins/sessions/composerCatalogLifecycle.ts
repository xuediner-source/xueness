import { loadComposerCatalog, type ComposerCatalog } from '../../xuenessComposer';

type LoadOptions = {
  root?: string;
  sessionId?: string;
  onCatalog: (catalog: ComposerCatalog) => void;
  onError: (error: unknown) => void;
  onLoading: (loading: boolean) => void;
};

/** The latest workspace owns the result; superseded work never updates the UI. */
export function createComposerCatalogLoader({
  read = loadComposerCatalog,
  timeoutMs = 15000,
  schedule = (callback: () => void, delay: number): unknown => setTimeout(callback, delay),
  clear = (timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>),
} = {}) {
  let current: { controller: AbortController; timer?: unknown } | undefined;
  const cancel = () => {
    const previous = current;
    current = undefined;
    if (!previous) return;
    if (previous.timer !== undefined) clear(previous.timer);
    previous.controller.abort();
  };
  return {
    cancel,
    async load(options: LoadOptions): Promise<void> {
      cancel();
      const request = { controller: new AbortController(), timer: undefined as unknown };
      current = request;
      options.onLoading(true);
      request.timer = schedule(() => {
        if (current !== request) return;
        current = undefined;
        request.controller.abort();
        options.onError(new Error('工作区信息加载超时，请重试或选择其他工作区。'));
        options.onLoading(false);
      }, timeoutMs);
      try {
        const catalog = await read(options.root, options.sessionId, request.controller.signal);
        if (current === request) options.onCatalog(catalog);
      } catch (error) {
        if (current === request) options.onError(error);
      } finally {
        if (request.timer !== undefined) clear(request.timer);
        if (current === request) {
          current = undefined;
          options.onLoading(false);
        }
      }
    },
  };
}

/** Keep global choices available, but never offer context from the old folder. */
export function clearWorkspaceComposerCatalog(catalog: ComposerCatalog): ComposerCatalog {
  return { ...catalog, root: null, files: [], sessions: [], git: undefined, backgroundCount: undefined };
}
