import React, { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Brain, ChevronDown, RotateCcw, Zap } from "lucide-react";
import { t as tr } from "../../i18n";
import { isImeComposingEvent } from "../../xuenessShortcutDisplay";

/**
 * Codex-style reasoning effort slider.
 *
 * Original implementation; interaction reference: qjcnmd/dsh-reasoning-slider.
 * Visual language:
 * - One color per stop: blue -> violet gradient, more "powered" to the right.
 * - High stops light up a purple nebula + stardust particle layer.
 * - Off levels stay gray.
 * - Track 28px tall, knob is a full circle with diameter = track height.
 *
 * Data path: levels come from the provider's `reasoningLevels`; the value
 * flows through the existing `reasoning_effort` choice (undefined = default).
 * Stop 0 is always the default ("默认"); stops 1..n map to levels[0..n-1].
 */

/* ── Design constants (position-driven, stop-count independent) ── */

const SLIDER_BLUE: [number, number, number] = [77, 147, 248];
const SLIDER_VIOLET: [number, number, number] = [147, 51, 234];
const SLIDER_DEEP: [number, number, number] = [76, 29, 149];
const SLIDER_TEXT_VIOLET: [number, number, number] = [139, 92, 246];
const ENERGY_START = 1 / 3;
const ENERGY_END = 2 / 3;
const MAX_PARTICLES = 22;
/** Duration fallback; reduced-motion CSS disables the rendered animations. */
export const REASONING_SLIDER_REDUCED_MOTION_SLOWDOWN = 2.6;

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function mixColor(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  const k = clamp01(t);
  return [
    Math.round(a[0] + (b[0] - a[0]) * k),
    Math.round(a[1] + (b[1] - a[1]) * k),
    Math.round(a[2] + (b[2] - a[2]) * k),
  ];
}

function rgbOf(c: [number, number, number]): string {
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

/** Position -> fill color at the knob (right end of the gradient). */
export function reasoningSliderFillColor(pct: number): string {
  const t = clamp01(pct);
  if (t <= ENERGY_START) return rgbOf(SLIDER_BLUE);
  if (t <= ENERGY_END) {
    return rgbOf(mixColor(SLIDER_BLUE, SLIDER_VIOLET, (t - ENERGY_START) / (ENERGY_END - ENERGY_START)));
  }
  return rgbOf(mixColor(SLIDER_VIOLET, SLIDER_DEEP, (t - ENERGY_END) / (1 - ENERGY_END)));
}

/** Position -> fill layer background: left end always blue, right end follows position. */
export function reasoningSliderFillBackground(pct: number): string {
  return `linear-gradient(90deg, ${rgbOf(SLIDER_BLUE)}, ${reasoningSliderFillColor(pct)})`;
}

/** Position -> energy intensity 0..1 (nebula + particles). Zero before the second stop. */
export function reasoningSliderEnergy(pct: number): number {
  return clamp01((clamp01(pct) - ENERGY_START) / (1 - ENERGY_START));
}

/** Position -> particle speed multiplier (0.35x .. 2x). */
export function reasoningSliderSpeed(pct: number): number {
  return Math.min(2, Math.max(0.35, 3 * clamp01(pct) - 1));
}

/** Position -> visible particle count. */
export function reasoningSliderParticleCount(pct: number): number {
  return Math.round(reasoningSliderEnergy(pct) * MAX_PARTICLES);
}

/** Whether a level means "reasoning off" (kept gray, no energy tint). */
export function reasoningSliderIsOffLevel(level: string | undefined): boolean {
  if (!level) return false;
  const flat = level.replace(/\s+/g, "").toLowerCase();
  return flat === "off" || flat === "none" || flat === "关闭" || flat === "无" || flat === "disable" || flat === "disabled";
}

/** Position -> value label color. Returns "" for off levels (keep native gray). */
export function reasoningSliderValueColor(pct: number, level: string | undefined): string {
  if (reasoningSliderIsOffLevel(level)) return "";
  return rgbOf(mixColor(SLIDER_BLUE, SLIDER_TEXT_VIOLET, reasoningSliderEnergy(pct)));
}

/** Deterministic pseudo-random in [0, 1) for particle layout (stable across renders). */
function hash01(n: number, salt: number): number {
  let h = (n * 2654435761 + salt * 40503) >>> 0;
  h ^= h >>> 15;
  h = (h * 2246822519) >>> 0;
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

export interface ReasoningEffortSliderProps {
  /** Provider-declared reasoning levels (e.g. ["low", "medium", "high"]). */
  levels: string[];
  /** Current choice; undefined/"" means provider default. */
  value: string | undefined;
  /** Selected provider/model identity, so a delayed drag write cannot leak to a new model. */
  scopeKey?: string;
  disabled?: boolean;
  onPreview?: (value: string | null) => void;
  onChange: (value: string | undefined) => void;
}

export function normalizeReasoningLevels(levels: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const level of levels ?? []) {
    if (typeof level !== "string") continue;
    const value = level.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

export function reasoningEffortLabel(value: string | undefined): string {
  const labels: Record<string, string> = {
    none: "关闭思考", minimal: "极低", low: "低", medium: "中等",
    high: "高", xhigh: "极高", max: "最高",
  };
  return value ? tr(labels[value] ?? value) : tr("默认");
}

export function ReasoningEffortSlider({ levels, value, scopeKey, disabled, onChange, onPreview }: ReasoningEffortSliderProps) {
  // Stop 0 = default, stops 1..n = levels.
  const normalizedLevels = React.useMemo(() => normalizeReasoningLevels(levels), [levels]);
  const stops = React.useMemo(() => ["", ...normalizedLevels], [normalizedLevels]);
  const currentValue = value ?? "";
  let currentIndex = stops.indexOf(currentValue);
  if (currentIndex < 0) currentIndex = 0;
  const maxIndex = stops.length - 1;
  const pct = maxIndex > 0 ? currentIndex / maxIndex : 0;

  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [dragPct, setDragPct] = useState<number | null>(null);
  const pendingRef = useRef<string | undefined>(undefined);
  const currentValueRef = useRef(currentValue);
  const onChangeRef = useRef(onChange);
  const scopeSignature = JSON.stringify([scopeKey ?? null, stops, disabled === true]);
  const scopeRef = useRef(scopeSignature);
  const dragScopeRef = useRef(scopeSignature);
  const previousScopeRef = useRef(scopeSignature);
  currentValueRef.current = currentValue;
  onChangeRef.current = onChange;
  scopeRef.current = scopeSignature;
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(mq.matches);
    const onChangeMq = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mq.addEventListener("change", onChangeMq);
    return () => mq.removeEventListener("change", onChangeMq);
  }, []);

  const cancelPendingWrite = useCallback(() => {
    pendingRef.current = undefined;
  }, []);

  // A provider/model change invalidates pending writes from the old slider.
  useEffect(() => {
    if (previousScopeRef.current === scopeSignature) return;
    previousScopeRef.current = scopeSignature;
    cancelPendingWrite();
    setDragging(false);
    setDragPct(null);
  }, [scopeSignature, cancelPendingWrite]);

  // Clear pending writes on unmount.
  useEffect(() => {
    return cancelPendingWrite;
  }, [cancelPendingWrite]);

  const commitValue = useCallback((next: string | undefined) => onChangeRef.current(next), []);

  const previewValue = useCallback((next: string) => {
    pendingRef.current = next;
    onPreview?.(next);
  }, [onPreview]);

  const pctFromClientX = useCallback((clientX: number): number => {
    const el = trackRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    // Knob geometry: 14px inset on each side (knob radius).
    const inset = 18;
    const span = Math.max(1, rect.width - inset * 2);
    return clamp01((clientX - rect.left - inset) / span);
  }, []);

  const indexFromPct = useCallback((p: number): number => {
    return Math.round(clamp01(p) * maxIndex);
  }, [maxIndex]);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    e.preventDefault();
    e.currentTarget.focus();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragScopeRef.current = scopeRef.current;
    setDragging(true);
    const p = pctFromClientX(e.clientX);
    setDragPct(p);
    const idx = indexFromPct(p);
    previewValue(stops[idx]);
  }, [disabled, pctFromClientX, indexFromPct, stops, previewValue]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging || disabled || dragScopeRef.current !== scopeRef.current) return;
    const p = pctFromClientX(e.clientX);
    setDragPct(p);
    const idx = indexFromPct(p);
    previewValue(stops[idx]);
  }, [dragging, disabled, pctFromClientX, indexFromPct, stops, previewValue]);

  const endDrag = useCallback(() => {
    if (!dragging) return;
    setDragging(false);
    setDragPct(null);
    if (dragScopeRef.current !== scopeRef.current) {
      cancelPendingWrite();
      return;
    }
    // One choice update on release; dragging never starts network requests.
    const pending = pendingRef.current;
    cancelPendingWrite();
    if (!disabled && pending !== undefined && pending !== currentValueRef.current) {
      commitValue(pending === "" ? undefined : pending);
    }
    onPreview?.(null);
  }, [dragging, disabled, cancelPendingWrite, commitValue, onPreview]);

  const cancelDrag = useCallback(() => {
    cancelPendingWrite();
    setDragging(false);
    setDragPct(null);
    onPreview?.(null);
  }, [cancelPendingWrite, onPreview]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (disabled || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    let next = currentIndex;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") next = Math.min(maxIndex, currentIndex + 1);
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = Math.max(0, currentIndex - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = maxIndex;
    else return;
    e.preventDefault();
    e.stopPropagation();
    const v = stops[next];
    commitValue(v === "" ? undefined : v);
  }, [disabled, currentIndex, maxIndex, stops, commitValue]);

  // Live position while dragging; committed position otherwise.
  const shownPct = dragPct ?? pct;
  const shownIndex = dragPct !== null ? indexFromPct(dragPct) : currentIndex;
  const shownLevel = stops[shownIndex] ?? "";
  const shownLabel = reasoningEffortLabel(shownLevel);
  const energy = reasoningSliderEnergy(shownPct);
  const particleCount = reasoningSliderParticleCount(shownPct);
  const speed = reasoningSliderSpeed(shownPct) * (reducedMotion ? REASONING_SLIDER_REDUCED_MOTION_SLOWDOWN : 1);
  const valueColor = reasoningSliderValueColor(shownPct, shownLevel === "" ? undefined : shownLevel);
  const isOff = reasoningSliderIsOffLevel(shownLevel);

  // Reserve the thumb radius at each end so it never clips outside the track.
  const knobLeft = `calc(18px + ${shownPct} * (100% - 36px))`;
  const fillWidth = `calc(${(shownPct * 100).toFixed(2)}% )`;

  return (
    <div
      className="xn-reasoning-slider"
      data-testid="reasoning-effort-slider"
      data-dragging={dragging ? "true" : "false"}
    >
      <div
        ref={trackRef}
        className="xn-reasoning-slider__track"
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={tr("思考强度")}
        aria-valuemin={0}
        aria-valuemax={maxIndex}
        aria-valuenow={shownIndex}
        aria-valuetext={shownLabel}
        aria-orientation="horizontal"
        aria-disabled={disabled ? "true" : undefined}
        title={tr("思考强度")}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={cancelDrag}
        onLostPointerCapture={cancelDrag}
        onKeyDown={handleKeyDown}
      >
        <div className="xn-reasoning-slider__fill" style={{ width: fillWidth, background: isOff ? undefined : reasoningSliderFillBackground(shownPct) }} aria-hidden="true" />
        {!isOff && energy > 0 && (
          <div
            className="xn-reasoning-slider__energy"
            style={{ width: fillWidth, opacity: 0.16 + 0.34 * energy }}
            aria-hidden="true"
          />
        )}
        {!isOff && particleCount > 0 && (
          <div
            className="xn-reasoning-slider__stars"
            style={{ opacity: 0.6 + 0.4 * energy }}
            aria-hidden="true"
          >
            {Array.from({ length: particleCount }, (_, i) => {
              const leftPct = hash01(i, 7) * 100;
              const topPct = 8 + hash01(i, 13) * 84;
              const size = 1 + hash01(i, 29) * 2;
              const duration = (3 / speed) * (0.92 + hash01(i, 43) * 0.16);
              const delay = -hash01(i, 53) * duration;
              return (
                <span
                  key={i}
                  className="xn-reasoning-slider__star"
                  style={{
                    left: `${leftPct}%`,
                    top: `${topPct}%`,
                    width: size,
                    height: size,
                    animationDuration: `${duration.toFixed(2)}s`,
                    animationDelay: `${delay.toFixed(2)}s`,
                  }}
                />
              );
            })}
          </div>
        )}
        <div className="xn-reasoning-slider__ticks" aria-hidden="true">
          {stops.map((s, i) => (
            <span
              key={s === "" ? "__default" : s}
              className={"xn-reasoning-slider__tick" + (i <= shownIndex ? " xn-reasoning-slider__tick--reached" : "")}
              style={{ left: `calc(18px + ${(maxIndex > 0 ? i / maxIndex : 0)} * (100% - 36px))` }}
            />
          ))}
        </div>
        <div className="xn-reasoning-slider__knob" style={{ left: knobLeft }} aria-hidden="true" />
      </div>
      <span
        className="xn-reasoning-slider__value"
        data-testid="reasoning-effort-slider-value"
        style={valueColor ? { color: valueColor } : undefined}
        aria-hidden="true"
      >
        {shownLabel}
      </span>
    </div>
  );
}

export interface ReasoningEffortPanelProps extends ReasoningEffortSliderProps {
  modelName: string;
  onConfigure: () => void;
}

export function ReasoningEffortPanel({ modelName, levels, value, onConfigure, ...sliderProps }: ReasoningEffortPanelProps) {
  const [preview, setPreview] = useState<string | null>(null);
  const supported = normalizeReasoningLevels(levels);
  const shownValue = preview !== null ? preview : value;
  const position = Math.max(0, ["", ...supported].indexOf(shownValue ?? "")) / Math.max(1, supported.length);
  const tint = shownValue ? reasoningSliderValueColor(position, shownValue) : undefined;
  return <>
    <div className="xn-effort-popover__heading">
      <Zap size={18} aria-hidden="true" />
      <strong aria-live="polite" data-testid="reasoning-effort-preview" style={tint ? { color: tint } : undefined}>{reasoningEffortLabel(shownValue)}</strong>
      <button type="button" aria-label={tr("恢复默认思考强度")} title={tr("恢复默认思考强度")}
        disabled={sliderProps.disabled || !value} onClick={() => { setPreview(null); sliderProps.onChange(undefined); }}>
        <RotateCcw size={17} aria-hidden="true" />
      </button>
    </div>
    <span className="xn-effort-popover__model">{modelName}</span>
    {supported.length > 0 ? <>
      <ReasoningEffortSlider {...sliderProps} levels={supported} value={value} onPreview={setPreview} />
      <div className="xn-effort-popover__scale" aria-hidden="true">
        <span>{tr("默认")}</span><span>{reasoningEffortLabel(supported.at(-1))}</span>
      </div>
      <p>{tr("拖动选择，松开生效。只使用此模型支持的档位。")}</p>
    </> : <div className="xn-effort-popover__empty">
      <p>{tr("此模型尚未声明可调推理档位，当前使用服务默认。")}</p>
      <button type="button" disabled={sliderProps.disabled} onClick={onConfigure}>{tr("配置模型推理档位")}</button>
    </div>}
  </>;
}

/** Visible even with unknown metadata, so a missing declaration is explainable. */
export function ReasoningEffortControl(props: ReasoningEffortPanelProps) {
  const [open, setOpen] = useState(false);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const id = useId();
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const scope = JSON.stringify([props.scopeKey, props.levels]);
  useEffect(() => { setOpen(false); }, [scope, props.disabled]);
  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const panel = panelRef.current;
      if (!panel) return;
      const rect = panel.getBoundingClientRect();
      const dx = rect.left < 16 ? 16 - rect.left : rect.right > innerWidth - 16 ? innerWidth - 16 - rect.right : 0;
      const dy = rect.top < 16 ? 16 - rect.top : rect.bottom > innerHeight - 16 ? innerHeight - 16 - rect.bottom : 0;
      // Read the rendered transform. Multiple layout/resize callbacks before a
      // React commit must calculate the same absolute offset, never accumulate.
      if (Math.abs(dx) > .5 || Math.abs(dy) > .5) {
        const transform = new DOMMatrixReadOnly(getComputedStyle(panel).transform);
        setOffset({ x: transform.m41 + dx, y: transform.m42 + dy });
      }
    };
    position();
    window.addEventListener("resize", position);
    const observer = new ResizeObserver(position);
    if (panelRef.current) observer.observe(panelRef.current);
    return () => { window.removeEventListener("resize", position); observer.disconnect(); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const leaveFocus = (event: FocusEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", leaveFocus);
    panelRef.current?.querySelector<HTMLElement>('[role="slider"], button:not(:disabled)')?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", leaveFocus);
    };
  }, [open]);
  return <div className="xn-effort-control" ref={wrapRef} onKeyDown={event => {
    if (event.key !== "Escape" || isImeComposingEvent(event) || !open) return;
    event.preventDefault(); event.stopPropagation(); setOpen(false); triggerRef.current?.focus();
  }}>
    <button type="button" className="xn-effort-control__trigger" ref={triggerRef}
      data-testid="reasoning-effort-trigger" aria-label={tr("思考强度")}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      title={tr("思考强度")} disabled={props.disabled}
      onClick={() => setOpen(current => !current)}>
      <Brain size={16} aria-hidden="true" /><span>{reasoningEffortLabel(props.value)}</span>
      <ChevronDown size={12} aria-hidden="true" />
    </button>
    {open && <div className="xn-effort-popover" role="dialog" aria-label={tr("思考强度")} id={id}
      data-testid="reasoning-effort-popover" ref={panelRef} style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}>
      <ReasoningEffortPanel {...props} onConfigure={() => { setOpen(false); props.onConfigure(); }} />
    </div>}
  </div>;
}

export default ReasoningEffortSlider;
