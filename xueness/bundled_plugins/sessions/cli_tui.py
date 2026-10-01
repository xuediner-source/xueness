"""Small optional curses console for the existing chat loop."""
from __future__ import annotations

import curses
import io
import sys


class _ScreenStream(io.TextIOBase):
    def __init__(self, window, language="zh"):
        self.window = window
        self.language = language
        self.lines = [""]
        self.pending = ""
        self.input_line = ""
        self.prompt = ""
        self.result = None
        self._history = []
        self._redraw()

    @property
    def encoding(self):
        return "utf-8"

    def isatty(self):
        return True

    def writable(self):
        return True

    def readable(self):
        return True

    def write(self, value):
        value = str(value)
        parts = (self.pending + value).replace("\r", "").split("\n")
        if len(parts) > 1:
            self.lines.extend(parts[:-1])
        self.pending = parts[-1]
        self.lines = self.lines[-1000:]
        self._redraw()
        return len(value)

    def flush(self):
        self._redraw()

    def readline(self, size=-1):
        self.prompt = self.pending
        self.pending = ""
        self.input_line = ""
        self._redraw()
        while True:
            try:
                key = self.window.get_wch()
            except curses.error:
                continue
            if key in ("\n", "\r", curses.KEY_ENTER):
                value = self.input_line
                self._history.append(value)
                self.lines.append((self.prompt + value).rstrip())
                self.input_line = ""
                self._redraw()
                return value + "\n"
            if key in ("\x03",):
                raise KeyboardInterrupt
            if key in ("\x04",):
                return ""
            if key in ("\x7f", "\b", curses.KEY_BACKSPACE):
                self.input_line = self.input_line[:-1]
            elif key == curses.KEY_RESIZE:
                pass
            elif isinstance(key, str) and key.isprintable():
                self.input_line += key
            self._redraw()

    def _safe_addstr(self, y, x, value, width):
        if width <= 0:
            return
        try:
            self.window.addstr(y, x, value[:width])
        except curses.error:
            # A wide glyph at the lower-right terminal cell may be rejected.
            pass

    def _redraw(self):
        try:
            height, width = self.window.getmaxyx()
            self.window.erase()
            if height < 3 or width < 10:
                self.window.refresh()
                return
            title = "Xueness · 全屏聊天" if self.language == "zh" else "Xueness · Fullscreen chat"
            hints = "Ctrl+C 停止/退出 · Ctrl+D 结束输入" if self.language == "zh" else "Ctrl+C stops/exits · Ctrl+D ends input"
            self._safe_addstr(0, 0, title, width - 1)
            self._safe_addstr(1, 0, hints, width - 1)
            output = self.lines + ([self.pending] if self.pending else [])
            visible = output[-max(1, height - 4):]
            start = max(2, height - 2 - len(visible))
            for offset, line in enumerate(visible):
                self._safe_addstr(start + offset, 0, line, width - 1)
            prompt = self.prompt + self.input_line
            self._safe_addstr(height - 1, 0, prompt[-(width - 1):], width - 1)
            self.window.move(height - 1, min(len(prompt), width - 2))
            self.window.refresh()
        except curses.error:
            pass


class _Reader:
    def __init__(self, stream):
        self.stream = stream

    def readline(self, size=-1):
        return self.stream.readline(size)

    def isatty(self):
        return True


def run_fullscreen(callback, language="zh"):
    """Run a callable in a fullscreen console; return ``(used, result)``.

    The ordinary REPL can be used as the callback, preserving session leases,
    provider streaming, approvals and attachments through one code path.
    """
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        return False, None
    started = False
    original = (sys.stdin, sys.stdout, sys.stderr)

    def _run(window):
        nonlocal started
        started = True
        curses.cbreak()
        curses.noecho()
        window.keypad(True)
        stream = _ScreenStream(window, language)
        sys.stdin = _Reader(stream)
        sys.stdout = stream
        sys.stderr = stream
        try:
            stream.result = callback()
            return stream.result
        finally:
            sys.stdin, sys.stdout, sys.stderr = original
            curses.nocbreak()
            curses.echo()
            window.keypad(False)

    try:
        return True, curses.wrapper(_run)
    except (ImportError, curses.error, OSError):
        sys.stdin, sys.stdout, sys.stderr = original
        if started:
            raise
        return False, None
