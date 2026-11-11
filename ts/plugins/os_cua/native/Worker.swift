import Foundation

struct WorkerError: Error {
    let code: String
    let message: String

    init(_ code: String, _ message: String) {
        self.code = "os_cua_" + code
        self.message = message
    }
}

struct Request: Decodable {
    let command: String
    let windowId: String?
    let action: InputAction?
}

@main struct Worker {
    @MainActor
    static func main() async {
        let response: [String: Any]
        do {
            var data = Data()
            while let chunk = try FileHandle.standardInput.read(upToCount: 8192), !chunk.isEmpty {
                data.append(chunk)
                if data.count > 65536 { throw WorkerError("invalid_request", "Request is too large.") }
            }
            let request = try JSONDecoder().decode(Request.self, from: data)
            let value: Any
            switch request.command {
            case "windows":
                value = try listWindows()
            case "screenshot":
                value = try await capture(windowId: request.windowId)
            case "snapshot":
                value = try snapshot(windowId: request.windowId)
            case "input":
                guard let action = request.action else { throw WorkerError("invalid_request", "An input action is required.") }
                try await perform(action)
                value = ["applied": true]
            default:
                throw WorkerError("invalid_request", "Unknown macOS computer-use command.")
            }
            response = ["ok": true, "value": value]
        } catch let error as WorkerError {
            response = ["ok": false, "code": error.code, "message": error.message]
        } catch {
            response = ["ok": false, "code": "os_cua_execution_failed", "message": "macOS did not complete the requested desktop action."]
        }
        do {
            let encoded = try JSONSerialization.data(withJSONObject: response)
            try FileHandle.standardOutput.write(contentsOf: encoded)
        } catch {
            exit(1)
        }
    }
}
