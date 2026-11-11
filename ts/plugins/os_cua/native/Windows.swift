import AppKit
import ApplicationServices

let windowChanged = WorkerError("window_changed", "The window has closed, moved to another Space, or resized. Run os_windows again.")

struct DesktopWindow {
    let number: CGWindowID
    let pid: pid_t
    let bounds: CGRect
    let title: String
    let app: String

    // Bind the ID to the owning process and observed size. Moving the window is safe.
    var id: String { "\(pid):\(number):\(Int(bounds.width)):\(Int(bounds.height))" }

    func row(focused: Bool) -> [String: Any] {
        ["id": id, "bounds": rectRow(bounds), "title": title, "app": app, "focused": focused]
    }
}

func rectRow(_ rect: CGRect) -> [String: CGFloat] {
    ["x": rect.minX, "y": rect.minY, "w": rect.width, "h": rect.height]
}

func sameRect(_ left: CGRect, _ right: CGRect) -> Bool {
    abs(left.minX - right.minX) < 2 && abs(left.minY - right.minY) < 2
        && abs(left.width - right.width) < 2 && abs(left.height - right.height) < 2
}

func windowInfo() throws -> [[String: Any]] {
    guard let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
        throw WorkerError("no_desktop", "There is no interactive macOS desktop. Unlock the local desktop and retry.")
    }
    return rows
}

func infoBounds(_ row: [String: Any]) -> CGRect? {
    guard let raw = row[kCGWindowBounds as String] as? [String: Any] else { return nil }
    return CGRect(dictionaryRepresentation: raw as CFDictionary)
}

private func clipped(_ value: String?, limit: Int = 160) -> String {
    String(decoding: (value ?? "").utf16.prefix(limit), as: UTF16.self)
}

func visibleWindows() throws -> [DesktopWindow] {
    try windowInfo().compactMap { row in
        guard let layer = row[kCGWindowLayer as String] as? Int, layer == 0,
              let number = row[kCGWindowNumber as String] as? CGWindowID, number != kCGNullWindowID,
              let pid = row[kCGWindowOwnerPID as String] as? pid_t, pid > 0,
              let bounds = infoBounds(row), bounds.width > 0, bounds.height > 0,
              let app = row[kCGWindowOwnerName as String] as? String, !app.isEmpty else { return nil }
        return DesktopWindow(number: number, pid: pid, bounds: bounds,
                             title: clipped(row[kCGWindowName as String] as? String, limit: 300),
                             app: clipped(app, limit: 200))
    }
}

func targetWindow(_ id: String?) throws -> DesktopWindow {
    guard let id, !id.isEmpty else { throw WorkerError("invalid_request", "A windowId from os_windows is required.") }
    guard let window = try visibleWindows().first(where: { $0.id == id }) else { throw windowChanged }
    return window
}

func listWindows() throws -> [[String: Any]] {
    let windows = try visibleWindows()
    let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
    let focused = windows.first { $0.pid == front }?.id
    // Return one extra row so the tool can signal truncation.
    return windows.prefix(65).map { $0.row(focused: $0.id == focused) }
}

func requireAccessibility() throws {
    guard AXIsProcessTrusted() else {
        throw WorkerError("accessibility_permission", "Enable Accessibility for Xueness in macOS Privacy & Security and reopen Xueness if macOS requests it.")
    }
}

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}

func axElement(_ value: CFTypeRef?) -> AXUIElement? {
    guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}

private func axValue(_ element: AXUIElement, _ name: String) -> AXValue? {
    guard let value = attribute(element, name), CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    return (value as! AXValue)
}

private func axBounds(_ element: AXUIElement) -> CGRect? {
    guard let position = axValue(element, kAXPositionAttribute), let size = axValue(element, kAXSizeAttribute) else { return nil }
    var point = CGPoint.zero
    var extent = CGSize.zero
    guard AXValueGetValue(position, .cgPoint, &point), AXValueGetValue(size, .cgSize, &extent) else { return nil }
    return CGRect(origin: point, size: extent)
}

func accessibilityWindow(_ window: DesktopWindow) throws -> (app: AXUIElement, window: AXUIElement) {
    let app = AXUIElementCreateApplication(window.pid)
    AXUIElementSetMessagingTimeout(app, 0.25)
    let windows = attribute(app, kAXWindowsAttribute) as? [AXUIElement] ?? []
    let candidates = windows.filter { element in
        guard let bounds = axBounds(element) else { return false }
        return sameRect(bounds, window.bounds)
    }
    if candidates.count == 1, let match = candidates.first { return (app, match) }
    let titled = candidates.filter { attribute($0, kAXTitleAttribute) as? String == window.title }
    if !window.title.isEmpty, titled.count == 1, let match = titled.first { return (app, match) }
    throw WorkerError("window_unresolved", "Accessibility could not identify the exact window. Try another visible window.")
}

private func children(_ element: AXUIElement, limit: Int, truncated: inout Bool) -> [AXUIElement] {
    var count: CFIndex = 0
    let name = kAXChildrenAttribute as CFString
    guard AXUIElementGetAttributeValueCount(element, name, &count) == .success, count > 0 else { return [] }
    truncated = truncated || count > limit
    guard limit > 0 else { return [] }
    var values: CFArray?
    guard AXUIElementCopyAttributeValues(element, name, 0, min(count, limit), &values) == .success else { return [] }
    return values as? [AXUIElement] ?? []
}

func snapshot(windowId: String?) throws -> [String: Any] {
    try requireAccessibility()
    let target = try targetWindow(windowId)
    let (app, root) = try accessibilityWindow(target)
    let focused = NSWorkspace.shared.frontmostApplication?.processIdentifier == target.pid
        && axElement(attribute(app, kAXFocusedWindowAttribute)).map { CFEqual(root, $0) } == true
    var pending = [(element: root, depth: 0)]
    var nodes = [[String: Any]]()
    var truncated = false
    let limit = 100
    let deadline = ProcessInfo.processInfo.systemUptime + 4

    while let next = pending.popLast() {
        guard nodes.count < limit, ProcessInfo.processInfo.systemUptime < deadline else { truncated = true; break }
        let element = next.element
        let role = clipped(attribute(element, kAXRoleAttribute) as? String)
        let secure = attribute(element, kAXSubroleAttribute) as? String == kAXSecureTextFieldSubrole
        var node: [String: Any] = ["depth": next.depth, "role": role.isEmpty ? "AXUnknown" : role]
        if let enabled = attribute(element, kAXEnabledAttribute) as? Bool { node["enabled"] = enabled }
        // Static text is useful to text-only models. Editable values, including password values, are never read.
        if !secure {
            let label = [kAXTitleAttribute, kAXDescriptionAttribute] + (role == kAXStaticTextRole ? [kAXValueAttribute] : [])
            for key in label {
                let value = clipped(attribute(element, key) as? String)
                if !value.isEmpty { node["label"] = value; break }
            }
        }
        if let bounds = axBounds(element) {
            let clippedBounds = bounds.intersection(target.bounds)
            if !clippedBounds.isEmpty {
                node["point"] = ["x": Int(clippedBounds.midX - target.bounds.minX), "y": Int(clippedBounds.midY - target.bounds.minY)]
            }
        }
        nodes.append(node)
        if !secure {
            let room = next.depth < 12 ? max(0, limit - nodes.count - pending.count) : 0
            let childNodes = children(element, limit: room, truncated: &truncated)
            pending.append(contentsOf: childNodes.reversed().map { ($0, next.depth + 1) })
        }
    }
    return ["window": target.row(focused: focused), "nodes": nodes, "truncated": truncated]
}
