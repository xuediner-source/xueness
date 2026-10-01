"""CLI-only SIGINT handling; the shared runtime owns journal settlement."""
import os
import signal
import threading


class RunInterrupt:
    """Defer Ctrl+C to a runtime boundary, except when reading an approval.

    A repeated Ctrl+C still requests a cooperative stop. It must not tear an
    already recorded tool-call group in half. Restore both the handler and the
    gate callback even if provider/plugin code fails.
    """

    def __init__(self, gate):
        self.gate = gate
        self.requested = False
        self.waiting_for_approval = False
        self.previous_handler = None
        self.previous_prompt = None
        self.installed = False

    def __enter__(self):
        self.previous_prompt = self.gate.approval_prompt
        self.gate.approval_prompt = self.approve
        if threading.current_thread() is threading.main_thread():
            self.previous_handler = signal.getsignal(signal.SIGINT)
            signal.signal(signal.SIGINT, self._interrupt)
            self.installed = True
        return self

    def __exit__(self, *exc):
        if self.installed:
            signal.signal(signal.SIGINT, self.previous_handler)
        self.gate.approval_prompt = self.previous_prompt

    def _interrupt(self, signum, frame):
        first = not self.requested
        self.requested = True
        if first:
            # Avoid re-entering Python's buffered stderr from a signal handler.
            try:
                os.write(2, "\n正在停止：等待当前请求或工具步骤结束，随后保存会话。\n".encode())
            except OSError:
                pass
        if self.waiting_for_approval:
            raise KeyboardInterrupt

    def should_stop(self):
        return self.requested

    def approve(self, label):
        if self.requested:
            return ""
        self.waiting_for_approval = True
        try:
            return (self.previous_prompt or input)(label)
        except (EOFError, KeyboardInterrupt):
            return ""
        finally:
            self.waiting_for_approval = False
