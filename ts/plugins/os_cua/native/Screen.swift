import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

@MainActor
func capture(windowId: String?) async throws -> [String: Any] {
    guard CGPreflightScreenCaptureAccess() else {
        throw WorkerError("screen_permission", "Enable Screen & System Audio Recording for Xueness in macOS Privacy & Security, then reopen Xueness.")
    }
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    let filter: SCContentFilter
    let bounds: CGRect
    if let windowId {
        let target = try targetWindow(windowId)
        guard let window = content.windows.first(where: {
            $0.windowID == target.number && $0.owningApplication?.processID == target.pid && sameRect($0.frame, target.bounds)
        }) else { throw windowChanged }
        filter = SCContentFilter(desktopIndependentWindow: window)
        bounds = window.frame
    } else {
        guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) else {
            throw WorkerError("no_desktop", "The main display is unavailable. Unlock the local desktop and retry.")
        }
        filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
        bounds = display.frame
    }

    let scale = min(1, 1536 / max(bounds.width, bounds.height))
    let config = SCStreamConfiguration()
    config.width = max(1, Int((bounds.width * scale).rounded()))
    config.height = max(1, Int((bounds.height * scale).rounded()))
    config.ignoreShadowsSingleWindow = true
    config.showsCursor = false
    let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
    if let windowId {
        let current = try targetWindow(windowId)
        guard sameRect(bounds, current.bounds) else { throw windowChanged }
    }
    for scale in [1.0, 0.75, 0.56, 0.42, 0.30] {
        guard let resized = scaledImage(image, by: scale), let png = encodePNG(resized) else { continue }
        if png.count <= 1_125_000 {
            return ["pngBase64": png.base64EncodedString(), "width": resized.width, "height": resized.height, "bounds": rectRow(bounds)]
        }
    }
    throw WorkerError("result_limit", "The screenshot exceeded its byte limit. Try capturing a smaller window.")
}

private func scaledImage(_ image: CGImage, by scale: Double) -> CGImage? {
    if scale == 1 { return image }
    let width = max(1, Int(Double(image.width) * scale))
    let height = max(1, Int(Double(image.height) * scale))
    guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
    context.interpolationQuality = .high
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    return context.makeImage()
}

private func encodePNG(_ image: CGImage) -> Data? {
    let data = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else { return nil }
    CGImageDestinationAddImage(destination, image, nil)
    return CGImageDestinationFinalize(destination) ? data as Data : nil
}
