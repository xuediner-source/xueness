"""Session lease opens the lock, then checks the descriptor.

POSIX coverage uses real symlinks on this host and repeats it with the
platform mocked as macOS. Windows coverage mocks the handle helpers, because
``O_NOFOLLOW`` is 0 there and a path check cannot close the race.
"""
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from xueness.core import Store
from xueness import session_lease
from xueness.session_lease import lease


def _store(base: Path):
    state = base / 'state'
    workspace = base / 'workspace'
    workspace.mkdir()
    store = Store(state)
    session = store.new('lease', workspace)
    return store, session['id']


class PosixLeaseTests(unittest.TestCase):
    def test_macos_and_posix_open_relative_to_a_nofollow_directory(self):
        for platform_name in ('darwin', 'linux'):
            with self.subTest(platform=platform_name), tempfile.TemporaryDirectory() as temporary:
                base = Path(temporary)
                store, sid = _store(base)
                opened = []
                real_open = os.open

                def spy(path, flags, mode=0o777, dir_fd=None):
                    kwargs = {} if dir_fd is None else {'dir_fd': dir_fd}
                    fd = real_open(path, flags, mode, **kwargs)
                    opened.append((os.fspath(path), flags, dir_fd, fd))
                    return fd

                with mock.patch('sys.platform', platform_name), \
                        mock.patch.object(session_lease.os, 'open', side_effect=spy) as opener:
                    # The capability check is the opener's identity. A test
                    # double must be registered or the POSIX path fails closed.
                    allowed = set(os.supports_dir_fd)
                    allowed.add(opener)
                    with mock.patch.object(session_lease.os, 'supports_dir_fd', allowed):
                        with lease(store, sid):
                            self.assertTrue((store.directory / '.locks' / (sid + '.lock')).is_file())
                directory_open = opened[0]
                file_open = opened[1]
                self.assertEqual(directory_open[0], os.fspath(store.directory / '.locks'))
                self.assertTrue(directory_open[1] & os.O_NOFOLLOW)
                self.assertTrue(directory_open[1] & os.O_DIRECTORY)
                self.assertIsNone(directory_open[2])
                self.assertEqual(file_open[0], sid + '.lock')
                self.assertTrue(file_open[1] & os.O_NOFOLLOW)
                self.assertEqual(file_open[2], directory_open[3])
                for leaked in (directory_open[3], file_open[3]):
                    with self.assertRaises(OSError):
                        os.fstat(leaked)

    def test_symlink_directory_and_file_are_refused_after_open(self):
        for platform_name in ('darwin', 'linux'):
            with self.subTest(platform=platform_name), tempfile.TemporaryDirectory() as temporary:
                base = Path(temporary)
                store, sid = _store(base)
                outside = base / 'outside'
                outside.mkdir()
                # A journal save creates the real lock directory. Replace it
                # so this fixture is the symlink the opener must refuse.
                locks = store.directory / '.locks'
                if locks.exists() and not locks.is_symlink():
                    for child in locks.iterdir():
                        child.unlink()
                    locks.rmdir()
                locks.symlink_to(outside, target_is_directory=True)
                with mock.patch('sys.platform', platform_name):
                    with self.assertRaisesRegex(ValueError, 'invalid lock directory'):
                        with lease(store, sid):
                            self.fail('followed a lock-directory symlink')
                self.assertEqual(list(outside.iterdir()), [])

                (store.directory / '.locks').unlink()
                locks = store.directory / '.locks'
                locks.mkdir()
                secret = base / 'secret'
                secret.write_text('secret', encoding='utf-8')
                (locks / (sid + '.lock')).symlink_to(secret)
                with mock.patch('sys.platform', platform_name):
                    with self.assertRaisesRegex(ValueError, 'invalid session lock'):
                        with lease(store, sid):
                            self.fail('followed a lock-file symlink')
                self.assertEqual(secret.read_text(encoding='utf-8'), 'secret')
                held = os.open(secret, os.O_RDWR)
                try:
                    session_lease.fcntl.flock(held, session_lease.fcntl.LOCK_EX | session_lease.fcntl.LOCK_NB)
                finally:
                    os.close(held)

    def test_fstat_rejects_a_non_regular_file_after_open_succeeds(self):
        # Simulates a platform where the open follows a swapped node and only
        # the descriptor check remains. The fd must not stay open or be locked.
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            store, sid = _store(base)
            real_fstat = os.fstat
            leaked = []

            def fstat(fd):
                info = real_fstat(fd)
                if stat.S_ISREG(info.st_mode):
                    leaked.append(fd)
                    return os.stat_result((stat.S_IFIFO,) + tuple(info)[1:])
                return info

            with mock.patch('sys.platform', 'darwin'), \
                    mock.patch.object(session_lease.os, 'fstat', side_effect=fstat), \
                    mock.patch.object(session_lease.fcntl, 'flock') as flock:
                with self.assertRaisesRegex(ValueError, 'invalid session lock'):
                    with lease(store, sid):
                        self.fail('locked a non-regular descriptor')
            flock.assert_not_called()
            self.assertTrue(leaked)
            for fd in leaked:
                with self.assertRaises(OSError):
                    os.fstat(fd)

    def test_missing_nofollow_fails_closed_before_open(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            store, sid = _store(base)
            with mock.patch.object(session_lease.os, 'O_NOFOLLOW', 0), \
                    mock.patch.object(session_lease.os, 'open', side_effect=AssertionError('opened')):
                with self.assertRaisesRegex(OSError, 'without following a link'):
                    with lease(store, sid):
                        self.fail('opened a lock without O_NOFOLLOW')
            self.assertFalse((store.directory / '.locks' / (sid + '.lock')).exists())


class WindowsLeaseTests(unittest.TestCase):
    def _patches(self, attributes, fd):
        return (
            mock.patch.object(session_lease.os, 'name', 'nt'),
            mock.patch('sys.platform', 'win32'),
            mock.patch.object(session_lease, '_win32_open_directory', return_value=101),
            mock.patch.object(session_lease, '_win32_attributes', side_effect=attributes),
            mock.patch.object(session_lease, '_win32_create_relative', return_value=202),
            mock.patch.object(session_lease, '_win32_fd', return_value=fd),
            mock.patch.object(session_lease, '_close_handle') ,
        )

    def test_reparse_directory_is_refused_before_the_lock_file_is_created(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            store, sid = _store(base)
            outside = base / 'outside'
            outside.mkdir()
            patches = self._patches([session_lease._FILE_ATTRIBUTE_REPARSE_POINT
                                     | session_lease._FILE_ATTRIBUTE_DIRECTORY], None)
            with patches[0], patches[1], patches[2] as open_dir, patches[3], \
                    patches[4] as create, patches[5] as to_fd, patches[6] as close, \
                    mock.patch.object(session_lease.fcntl, 'flock') as flock:
                with self.assertRaisesRegex(ValueError, 'invalid lock directory'):
                    with lease(store, sid):
                        self.fail('leased through a reparse directory')
            open_dir.assert_called_once()
            create.assert_not_called()
            to_fd.assert_not_called()
            flock.assert_not_called()
            close.assert_called_once_with(101)
            self.assertEqual(list(outside.iterdir()), [])
            self.assertFalse((store.directory / '.locks' / (sid + '.lock')).exists())

    def test_reparse_lock_file_is_refused_from_the_opened_handle(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            store, sid = _store(base)
            attributes = [
                session_lease._FILE_ATTRIBUTE_DIRECTORY,
                session_lease._FILE_ATTRIBUTE_REPARSE_POINT,
            ]
            patches = self._patches(attributes, None)
            with patches[0], patches[1], patches[2], patches[3], patches[4] as create, \
                    patches[5] as to_fd, patches[6] as close, \
                    mock.patch.object(session_lease.fcntl, 'flock') as flock:
                with self.assertRaisesRegex(ValueError, 'invalid session lock'):
                    with lease(store, sid):
                        self.fail('leased a reparse lock file')
            create.assert_called_once_with(101, sid + '.lock')
            to_fd.assert_not_called()
            flock.assert_not_called()
            self.assertEqual([call.args[0] for call in close.call_args_list], [202, 101])

    def test_regular_handle_is_locked_and_a_non_regular_fstat_is_closed(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            store, sid = _store(base)
            held = os.open(base / 'held.lock', os.O_CREAT | os.O_RDWR, 0o600)
            attributes = [session_lease._FILE_ATTRIBUTE_DIRECTORY, 0x20]
            patches = self._patches(attributes, held)
            try:
                with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5], \
                        patches[6] as close, \
                        mock.patch.object(session_lease.fcntl, 'flock') as flock:
                    with lease(store, sid):
                        flock.assert_called_once()
                        self.assertEqual(flock.call_args.args[0], held)
                close.assert_called_once_with(101)
                with self.assertRaises(OSError):
                    os.fstat(held)
                held = None

                rejected = os.open(base / 'rejected.lock', os.O_CREAT | os.O_RDWR, 0o600)
                real_fstat = os.fstat

                def fstat(fd):
                    info = real_fstat(fd)
                    if fd == rejected:
                        return os.stat_result((stat.S_IFIFO,) + tuple(info)[1:])
                    return info

                patches = self._patches(
                    [session_lease._FILE_ATTRIBUTE_DIRECTORY, 0x20], rejected)
                with patches[0], patches[1], patches[2], patches[3], patches[4], patches[5], \
                        patches[6], mock.patch.object(session_lease.os, 'fstat', side_effect=fstat), \
                        mock.patch.object(session_lease.fcntl, 'flock') as flock:
                    with self.assertRaisesRegex(ValueError, 'invalid session lock'):
                        with lease(store, sid):
                            self.fail('locked a descriptor fstat rejected')
                flock.assert_not_called()
                with self.assertRaises(OSError):
                    os.fstat(rejected)
            finally:
                if held is not None:
                    os.close(held)


if __name__ == '__main__':
    unittest.main()
