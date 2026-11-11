import AppKit
import ApplicationServices

struct InputAction: Decodable {
    let type: String
    let windowId: String?
    let x: Int?
    let y: Int?
    let button: String?
    let deltaY: Int?
    let key: String?
    let modifiers: [String]?
    let text: String?
}

private let invalidInput = WorkerError("invalid_request", "Invalid macOS input action.")
private let noEvent = WorkerError("execution_failed", "macOS could not create the input event.")
private let keyCodes: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
    "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
    "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25,
    "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33,
    "i": 34, "p": 35, "enter": 36, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41,
    "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "tab": 48, "space": 49,
    "`": 50, "backspace": 51, "esc": 53, "escape": 53, "home": 115, "pageup": 116,
    "delete": 117, "end": 119, "pagedown": 121, "left": 123, "right": 124, "down": 125, "up": 126,
]
private let modifierFlags: [String: CGEventFlags] = ["cmd": .maskCommand, "ctrl": .maskControl, "alt": .maskAlternate, "shift": .maskShift]

private func keyboardPair(source: CGEventSource, code: CGKeyCode, flags: CGEventFlags, text: [UInt16]? = nil) throws -> [CGEvent] {
    try [true, false].map { down in
        guard let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down) else { throw noEvent }
        event.flags = flags
        if let text { event.keyboardSetUnicodeString(stringLength: text.count, unicodeString: text) }
        return event
    }
}

private func keyboardEvents(_ action: InputAction, source: CGEventSource) throws -> [CGEvent] {
    if action.type == "key" {
        guard let key = action.key, let code = keyCodes[key.lowercased()] else {
            throw WorkerError("invalid_request", "Use a named or ANSI key for key input. Use text for Unicode characters.")
        }
        var flags = CGEventFlags()
        let modifiers = action.modifiers ?? []
        guard Set(modifiers).count == modifiers.count else { throw invalidInput }
        for modifier in modifiers {
            guard let flag = modifierFlags[modifier] else { throw invalidInput }
            flags.insert(flag)
        }
        return try keyboardPair(source: source, code: code, flags: flags)
    }

    guard let text = action.text, !text.isEmpty, !text.contains("\0"), text.utf16.count <= 5000 else { throw invalidInput }
    let utf16 = Array(text.utf16)
    var events = [CGEvent]()
    var start = 0
    while start < utf16.count {
        var end = min(start + 16, utf16.count)
        if end < utf16.count && (0xD800...0xDBFF).contains(utf16[end - 1]) { end -= 1 }
        events += try keyboardPair(source: source, code: 0, flags: [], text: Array(utf16[start..<end]))
        start = end
    }
    return events
}

private func pointerEvents(_ action: InputAction, source: CGEventSource, point: CGPoint) throws -> [CGEvent] {
    if action.type == "scroll" {
        guard let delta = action.deltaY, (-10000...10000).contains(delta) else { throw invalidInput }
        guard let event = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 1,
                                  wheel1: Int32(-delta), wheel2: 0, wheel3: 0) else { throw noEvent }
        event.location = point
        event.flags = []
        return [event]
    }
    guard action.type == "click" || action.type == "double_click" else { throw invalidInput }
    let kinds: (CGMouseButton, CGEventType, CGEventType)
    switch action.button ?? "left" {
    case "left": kinds = (.left, .leftMouseDown, .leftMouseUp)
    case "right": kinds = (.right, .rightMouseDown, .rightMouseUp)
    case "middle": kinds = (.center, .otherMouseDown, .otherMouseUp)
    default: throw invalidInput
    }
    return try (1...(action.type == "double_click" ? 2 : 1)).flatMap { count in
        try [kinds.1, kinds.2].map { kind in
            guard let event = CGEvent(mouseEventSource: source, mouseType: kind, mouseCursorPosition: point, mouseButton: kinds.0) else { throw noEvent }
            event.setIntegerValueField(.mouseEventClickState, value: Int64(count))
            event.flags = []
            return event
        }
    }
}

private func isFocused(pid: pid_t, app: AXUIElement, window: AXUIElement) -> Bool {
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
          let focused = axElement(attribute(app, kAXFocusedWindowAttribute)) else { return false }
    return CFEqual(window, focused)
}

@MainActor
private func focus(_ target: DesktopWindow, app: AXUIElement, window: AXUIElement) async throws {
    if isFocused(pid: target.pid, app: app, window: window) { return }
    AXUIElementSetAttributeValue(app, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
    AXUIElementPerformAction(window, kAXRaiseAction as CFString)
    AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
    for _ in 0..<8 {
        if isFocused(pid: target.pid, app: app, window: window) { return }
        try await Task.sleep(for: .milliseconds(60))
    }
    throw WorkerError("window_not_focused", "The target window could not be focused. Check for a modal dialog or choose another visible window.")
}

private func requireUncovered(_ point: CGPoint, window: AXUIElement) throws {
    var display = CGDirectDisplayID()
    var count: UInt32 = 0
    guard CGGetDisplaysWithPoint(point, 1, &display, &count) == .success, count > 0 else {
        throw WorkerError("point_offscreen", "That point is outside the active displays.")
    }
    let system = AXUIElementCreateSystemWide()
    AXUIElementSetMessagingTimeout(system, 0.25)
    var hit: AXUIElement?
    guard AXUIElementCopyElementAtPosition(system, Float(point.x), Float(point.y), &hit) == .success, let hit else {
        throw WorkerError("point_unresolved", "macOS could not identify the element at that point.")
    }
    let hitWindow = axElement(attribute(hit, kAXWindowAttribute))
    guard CFEqual(hit, window) || hitWindow.map({ CFEqual($0, window) }) == true else {
        throw WorkerError("point_covered", "The point is covered or belongs to another window. Inspect the target again.")
    }
}

@MainActor
func perform(_ action: InputAction) async throws {
    try requireAccessibility()
    guard CGPreflightPostEventAccess() else {
        throw WorkerError("accessibility_permission", "macOS is blocking synthetic input. Check Accessibility for Xueness in Privacy & Security.")
    }
    let target = try targetWindow(action.windowId)
    guard let source = CGEventSource(stateID: .hidSystemState) else { throw noEvent }
    let keyboard = action.type == "key" || action.type == "text"
    var events = keyboard ? try keyboardEvents(action, source: source) : []
    if !keyboard {
        guard let x = action.x, let y = action.y, x >= 0, y >= 0, x < Int(target.bounds.width), y < Int(target.bounds.height) else {
            throw WorkerError("point_outside_window", "The pointer coordinates are outside the target window.")
        }
    }
    let (app, window) = try accessibilityWindow(target)
    try await focus(target, app: app, window: window)
    let current = try targetWindow(action.windowId)
    if !keyboard, let x = action.x, let y = action.y {
        let point = CGPoint(x: current.bounds.minX + CGFloat(x), y: current.bounds.minY + CGFloat(y))
        try requireUncovered(point, window: window)
        events = try pointerEvents(action, source: source, point: point)
    }
    guard isFocused(pid: current.pid, app: app, window: window) else {
        throw WorkerError("window_not_focused", "The target window lost focus before input. Observe the desktop again.")
    }
    for event in events {
        if keyboard { event.postToPid(current.pid) }
        else { event.post(tap: .cghidEventTap) }
    }
    // Let WindowServer drain the queued key or pointer pairs before this one-shot process exits.
    try await Task.sleep(for: .milliseconds(90))
}
