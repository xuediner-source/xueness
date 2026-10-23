import { FILE_STALE_MESSAGE } from "./file-state.ts";

export class WorkspaceRevisionMismatchError extends Error {
  override name = "WorkspaceRevisionMismatchError";
  readonly code = "stale_file";

  constructor() {
    super(FILE_STALE_MESSAGE);
  }
}

export class WorkspaceFileTooLargeError extends Error {
  override name = "WorkspaceFileTooLargeError";
  readonly code = "file_too_large";
  readonly maxBytes: number;

  constructor(maxBytes: number) {
    super(`File content exceeds maximum allowed size (${maxBytes} bytes).`);
    this.maxBytes = maxBytes;
  }
}
