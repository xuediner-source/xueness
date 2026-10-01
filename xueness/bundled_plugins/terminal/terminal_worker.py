"""Acquire the supplied slave PTY and execute a fixed shell profile."""
import fcntl
import os
import termios
import sys
if __package__:
    from .shells import resolve_shell
else:
    from shells import resolve_shell

if __name__ == '__main__':
    fcntl.ioctl(0, termios.TIOCSCTTY, 0)
    shell = resolve_shell(sys.argv[1] if len(sys.argv) == 2 else None)
    os.execv(shell, [shell, '-i'])
