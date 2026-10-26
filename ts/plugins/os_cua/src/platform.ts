/**
 * Platform adaptation port for OS Computer Use (F12.03).
 *
 * The plugin never spawns screenshot or input helpers itself: a host wires an
 * `OsAdapterPort` per platform, and every tool call goes through it. Platforms
 * without a wired adapter are explicitly unavailable — the tools answer with a
 * stable "unavailable" result instead of pretending to act.
 */

/** A toplevel window as the adapter sees it; bounds are in virtual-screen pixels. */
export interface OsWindow {
  id: string;
  title: string;
  app: string;
  bounds: { x: number; y: number; w: number; h: number };
  focused: boolean;
}

/** One bounded interaction per call; there is no free-form script surface. */
export type OsInputAction =
  | { type: "click"; x: number; y: number; button?: "left" | "right" | "middle"; windowId?: string }
  | { type: "double_click"; x: number; y: number; windowId?: string }
  | { type: "scroll"; x: number; y: number; deltaY: number; windowId?: string }
  | { type: "key"; key: string; windowId?: string }
  | { type: "text"; text: string; windowId?: string };

export interface ScreenCapture {
  pngBase64: string;
  width: number;
  height: number;
}

/** What a platform adapter implements; `windowId` on input maps window-relative coordinates. */
export interface OsAdapterPort {
  platform: string;
  available: boolean;
  unavailableReason?: string;
  listWindows(): Promise<OsWindow[]>;
  captureScreen(options: { windowId?: string }): Promise<ScreenCapture>;
  performInput(action: OsInputAction): Promise<{ applied: boolean }>;
}

export interface AdapterAvailability {
  platform: string;
  available: boolean;
  unavailableReason?: string;
}

/** Platforms a bundled adapter could be wired for; the probe decides whether one actually is. */
export const ADAPTER_PLATFORMS: readonly string[] = ["darwin", "win32"];

const UNWIRED = "no OS computer-use adapter is wired for this platform";

/**
 * Resolve adapter availability for `platform`: supported platforms report
 * available only when `probe` confirms a wired adapter; everything else
 * (including plain Linux desktop hosts) is explicitly unavailable.
 */
export function platformAdapter(platform: string, probe?: () => boolean): AdapterAvailability {
  if (!ADAPTER_PLATFORMS.includes(platform)) return { platform, available: false, unavailableReason: UNWIRED };
  const wired = probe ? probe() : false;
  return wired ? { platform, available: true } : { platform, available: false, unavailableReason: UNWIRED };
}

/** The plugin's default adapter: nothing wired, so every call is explicitly unavailable. */
export function unwiredAdapter(platform: string): OsAdapterPort {
  const view = platformAdapter(platform);
  const refuse = (): never => {
    throw Object.assign(new Error(`OS computer-use is unavailable on ${platform}: ${view.unavailableReason}`), { code: "os_cua_unavailable" });
  };
  return { platform, available: false, unavailableReason: view.unavailableReason,
    async listWindows(): Promise<never> { return refuse(); },
    async captureScreen(): Promise<never> { return refuse(); },
    async performInput(): Promise<never> { return refuse(); } };
}
