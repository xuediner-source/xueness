(() => {
  const frame = document.getElementById("zcode-visualization");
  if (!(frame instanceof HTMLIFrameElement)) {
    return;
  }
  let viewportHeight = globalThis.innerHeight;
  const storageKey = `zcode:visualization-widget-state-v2:${JSON.stringify([
    globalThis.location.pathname,
    globalThis.location.search,
  ])}`;
  const parseState = (serializedState) => {
    if (
      typeof serializedState !== "string" ||
      new TextEncoder().encode(serializedState).length > 16 * 1024
    ) {
      throw new TypeError("Widget state must be a JSON object of at most 16 KiB");
    }
    /** @type {unknown} */
    const state = JSON.parse(serializedState);
    if (
      state == null ||
      typeof state !== "object" ||
      Array.isArray(state) ||
      ("imageIds" in state && (!Array.isArray(state.imageIds) || state.imageIds.length > 0))
    ) {
      throw new TypeError("Widget state must be a JSON object");
    }
    const storedState = { modelContent: null, privateContent: null, ...state };
    const canonicalState = JSON.stringify(storedState, (_key, /** @type {unknown} */ value) => {
      if (typeof value === "number" && !Number.isFinite(value)) {
        throw new TypeError("Widget state must contain finite numbers");
      }
      return value;
    });
    if (new TextEncoder().encode(canonicalState).length > 16 * 1024) {
      throw new TypeError("Widget state must be a JSON object of at most 16 KiB");
    }
    return storedState;
  };
  let storage = null;
  let state = null;
  try {
    const localStorage = globalThis.localStorage;
    const probeKey = `${storageKey}:probe`;
    localStorage.setItem(probeKey, "1");
    localStorage.removeItem(probeKey);
    storage = localStorage;
    const savedState = storage.getItem(storageKey);
    if (savedState != null) {
      try {
        state = parseState(savedState);
      } catch {
        // Invalid saved state does not disable future writes.
      }
    }
  } catch {
    storage = null;
  }

  // The page is served with `Content-Security-Policy: sandbox allow-scripts`, so
  // this document has an opaque origin and `localStorage` throws. When a host
  // embeds the page (the web UI), the host owns persistence and the reported
  // height; localStorage stays as the fallback for a page opened on its own.
  const hostWindow = globalThis.parent === globalThis ? null : globalThis.parent;
  let nextHostRequestId = 0;
  /** @type {Map<number, (reply: any) => void>} */
  const pendingHostRequests = new Map();
  const askHost = (message, timeoutMs) =>
    new Promise((resolve) => {
      if (hostWindow == null) {
        resolve(null);
        return;
      }
      const id = ++nextHostRequestId;
      const timer = globalThis.setTimeout(() => {
        pendingHostRequests.delete(id);
        resolve(null);
      }, timeoutMs);
      pendingHostRequests.set(id, (reply) => {
        globalThis.clearTimeout(timer);
        resolve(reply);
      });
      hostWindow.postMessage({ ...message, id }, "*");
    });
  globalThis.addEventListener("message", (event) => {
    if (hostWindow == null || event.source !== hostWindow) {
      return;
    }
    const data = event.data;
    if (typeof data !== "object" || data == null || typeof data.id !== "number") {
      return;
    }
    const pending = pendingHostRequests.get(data.id);
    if (pending != null) {
      pendingHostRequests.delete(data.id);
      pending(data);
    }
  });
  const statePersistence = hostWindow != null || storage != null ? "local" : "none";
  const readSavedState = async () => {
    if (hostWindow == null) {
      return state;
    }
    const reply = await askHost({ type: "xueness-visualization-state-read", key: storageKey }, 1_000);
    if (reply == null || typeof reply.state !== "string") {
      return state;
    }
    try {
      return parseState(reply.state);
    } catch {
      return state;
    }
  };
  const persistState = async (serializedState) => {
    if (hostWindow != null) {
      const reply = await askHost(
        { type: "xueness-visualization-state-write", key: storageKey, state: serializedState },
        5_000,
      );
      return reply != null && reply.ok === true;
    }
    if (storage == null) {
      return false;
    }
    try {
      storage.setItem(storageKey, JSON.stringify(parseState(serializedState)));
      return true;
    } catch {
      return false;
    }
  };
  // Until the fragment has measured itself the frame still holds the CSS
  // default (`calc(100vh - 2rem)`), which is not the content's height: report
  // only after the inner bridge's first `height` message.
  let measured = false;
  const reportHeight = () => {
    if (hostWindow == null || !measured) {
      return;
    }
    hostWindow.postMessage(
      {
        type: "xueness-visualization-height",
        height: Math.ceil(
          Math.max(
            document.body.scrollHeight,
            document.body.getBoundingClientRect().height,
          ),
        ),
      },
      "*",
    );
  };

  const channel = new MessageChannel();
  channel.port1.addEventListener("message", async (event) => {
    const data = event.data;
    if (typeof data !== "object" || data == null) {
      return;
    }
    if (data.type === "widget-state-write") {
      if (!Number.isSafeInteger(data.id) || data.id <= 0) {
        return;
      }
      let ok = false;
      try {
        parseState(data.state);
        ok = await persistState(data.state);
      } catch {
        // Invalid state, storage denial and quota limits return a failed receipt.
      }
      channel.port1.postMessage({
        type: "widget-state-result",
        id: data.id,
        ok,
      });
      return;
    }
    if (data.type === "height") {
      const height = data.height;
      if (
        typeof height === "number" &&
        Number.isFinite(height) &&
        height >= 0 &&
        height <= 10_000
      ) {
        frame.style.height = Math.ceil(height) + "px";
        measured = true;
        reportHeight();
      }
      return;
    }
    if (data.type === "scroll-to") {
      const top = data.top;
      if (
        typeof top === "number" &&
        Number.isFinite(top) &&
        top >= 0 &&
        globalThis.navigator.userActivation?.isActive === true
      ) {
        globalThis.scrollTo({
          top: Math.ceil(globalThis.scrollY + frame.getBoundingClientRect().top + top),
        });
      }
      return;
    }
    if (data.type === "open-external") {
      const rawHref = data.href;
      if (typeof rawHref !== "string") {
        return;
      }
      let href;
      try {
        const url = new URL(rawHref, document.baseURI);
        if (url.protocol !== "https:") {
          return;
        }
        href = url.href;
      } catch {
        return;
      }
      if (globalThis.navigator.userActivation?.isActive === true) {
        const anchor = document.createElement("a");
        anchor.href = href;
        anchor.rel = "noopener noreferrer";
        anchor.target = "_blank";
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      }
      return;
    }
    if (data.type === "follow-up") {
      const prompt = data.prompt;
      if (typeof prompt !== "string" || globalThis.navigator.userActivation?.isActive !== true) {
        return;
      }
      const title = data.title;
      globalThis.prompt(typeof title === "string" ? title : prompt, prompt);
    }
  });
  channel.port1.start();
  const srcdoc = frame.dataset.srcdoc;
  if (srcdoc == null) {
    return;
  }
  globalThis.addEventListener("resize", () => {
    if (hostWindow == null) {
      const height = Number.parseFloat(frame.style.height);
      if (!Number.isFinite(height) || height <= viewportHeight) {
        frame.style.removeProperty("height");
      }
    }
    viewportHeight = globalThis.innerHeight;
    channel.port1.postMessage({ type: "measure" });
  });
  frame.addEventListener(
    "load",
    () => {
      frame.contentWindow?.postMessage({ type: "zcode-visualization-initialize" }, "*", [
        channel.port2,
      ]);
      reportHeight();
    },
    { once: true },
  );
  new ResizeObserver(reportHeight).observe(document.body);
  void (async () => {
    const restored = await readSavedState();
    if (restored != null) {
      state = restored;
    }
    // Match the trusted bootstrap element, not the same text in an authored title.
    frame.srcdoc = srcdoc.replace(
      '<script type="application/json" id="zcode-visualization-widget-state">__ZCODE_VISUALIZATION_WIDGET_STATE__</script>',
      () =>
        '<script type="application/json" id="zcode-visualization-widget-state">' +
        JSON.stringify({ widgetState: state, statePersistence }).replaceAll("<", "\\u003c") +
        "</script>",
    );
    delete frame.dataset.srcdoc;
  })();
})();
