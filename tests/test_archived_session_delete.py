"""Archived deletion uses isolated journals and never invokes a model."""
import hashlib
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest.mock import patch

from tests.fs_link_helpers import make_directory_junction, make_symlink
from xueness import plugin_runtime, web
from xueness.bundled_plugins.sessions import session_management
from xueness.session_lease import lease


class ArchivedSessionDeleteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.workspace = self.base / 'workspace'
        self.workspace.mkdir()
        self.ctx = web.build_context(self.base / 'state', self.base / 'runs', self.workspace,
                                     allow_real=False, csrf='isolated-test-csrf')
        self.store = self.ctx['store']
        self.server = web.create_server(0, self.ctx)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.origin = f'http://127.0.0.1:{self.server.server_address[1]}'

    def request(self, method, path, data=None, *, csrf=True, origin=None):
        headers = {'Content-Type': 'application/json', 'Origin': origin or self.origin}
        if csrf:
            headers['X-CSRF-Token'] = 'isolated-test-csrf'
        request = urllib.request.Request(self.origin + path, method=method, headers=headers,
                                         data=None if data is None else json.dumps(data).encode())
        try:
            with urllib.request.urlopen(request, timeout=10) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            return error.code, json.loads(error.read())

    def archived(self, task='Archived fixture'):
        session = self.store.new(task, self.workspace)
        sid = session['id']
        with lease(self.store, sid):
            session_management.archive(self.store, sid)
        entry = next(item for item in session_management.list_archived(self.store) if item['id'] == sid)
        return session, entry, self.store.directory / 'deleted-sessions' / f'{sid}.json'

    def delete(self, entry, **kwargs):
        return self.request('DELETE', '/api/sessions/archived/' + entry['id'],
                            {'confirmed': True, 'expectedRevision': entry['revision']}, **kwargs)

    def test_delete_removes_only_selected_archive_and_recovery_copies(self):
        session, entry, source = self.archived()
        sid = session['id']
        with lease(self.store, sid):
            session_management.restore(self.store, sid)
            session_management.archive(self.store, sid)
        entry = next(item for item in session_management.list_archived(self.store) if item['id'] == sid)
        live_backup = Path(str(self.store._path(sid)) + '.bak')
        archive_backup = Path(str(source) + '.bak')
        self.assertTrue(live_backup.exists())
        self.assertTrue(archive_backup.exists())
        other, _, other_path = self.archived('Keep other archive')
        active = self.store.new('Keep active conversation', self.workspace)
        workspace_file = self.workspace / 'keep.txt'
        workspace_file.write_bytes(b'workspace output')
        evidence = self.base / 'runs' / 'keep.jsonl'
        evidence.write_bytes(b'run evidence')
        before = {path: path.read_bytes() for path in (other_path, self.store._path(active['id']), workspace_file, evidence)}
        code, payload = self.delete(entry)
        self.assertEqual((code, payload), (200, {'id': sid, 'deleted': True, 'permanent': True}))
        for path in (source, live_backup, archive_backup):
            self.assertFalse(path.exists())
        for path, contents in before.items():
            self.assertEqual(path.read_bytes(), contents)
        self.assertTrue((self.store.directory / '.locks' / f'{sid}.lock').is_file())
        self.assertEqual([item['id'] for item in session_management.list_archived(self.store)], [other['id']])
        self.assertEqual(self.request('POST', f'/api/sessions/{sid}/restore', {})[0], 400)
        self.assertEqual(self.delete(entry)[0], 404)

    def test_explicit_boolean_confirmation_and_valid_revision_required(self):
        _, entry, source = self.archived()
        before = source.read_bytes()
        bodies = [{}, {'confirmed': False, 'expectedRevision': entry['revision']},
                  {'confirmed': 1, 'expectedRevision': entry['revision']},
                  {'confirmed': 'true', 'expectedRevision': entry['revision']},
                  {'confirmed': True}, {'confirmed': True, 'expectedRevision': 'bad'},
                  {'confirmed': True, 'expectedRevision': entry['revision'], 'root': str(self.workspace)}]
        for body in bodies:
            with self.subTest(body=body):
                self.assertEqual(self.request('DELETE', '/api/sessions/archived/' + entry['id'], body)[0], 400)
                self.assertEqual(source.read_bytes(), before)

    def test_stale_revision_after_restore_and_rearchive_is_rejected(self):
        _, entry, source = self.archived()
        with lease(self.store, entry['id']):
            session_management.restore(self.store, entry['id'])
            session_management.archive(self.store, entry['id'])
        before = source.read_bytes()
        self.assertEqual(self.delete(entry)[0], 409)
        self.assertEqual(source.read_bytes(), before)
        fresh = session_management.list_archived(self.store)[0]
        self.assertNotEqual(fresh['revision'], entry['revision'])
        self.assertEqual(self.delete(fresh)[0], 200)

    def test_live_and_archive_collision_cannot_delete_either_record(self):
        session, entry, source = self.archived()
        self.store.save(session)
        live = self.store._path(session['id'])
        before = [source.read_bytes(), live.read_bytes()]
        self.assertEqual(self.delete(entry)[0], 409)
        self.assertEqual([source.read_bytes(), live.read_bytes()], before)

    def test_live_only_session_is_never_permanently_deleted(self):
        session = self.store.new('Keep live', self.workspace)
        path = self.store._path(session['id'])
        before = path.read_bytes()
        self.assertEqual(self.delete({'id': session['id'], 'revision': hashlib.sha256(before).hexdigest()})[0], 404)
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(self.request('DELETE', '/api/sessions/' + session['id'], {})[0], 200)
        self.assertEqual(self.request('POST', '/api/sessions/' + session['id'] + '/restore', {})[0], 200)

    def test_running_and_cross_process_lease_reject_deletion(self):
        _, entry, source = self.archived()
        before = source.read_bytes()
        self.ctx['running'].add(entry['id'])
        self.assertEqual(self.delete(entry)[0], 409)
        self.ctx['running'].discard(entry['id'])
        with lease(self.store, entry['id']):
            self.assertEqual(self.delete(entry)[0], 409)
        self.assertEqual(source.read_bytes(), before)
        self.assertEqual(self.delete(entry)[0], 200)

    def test_csrf_origin_and_disabled_sessions_block_mutation(self):
        _, entry, source = self.archived()
        before = source.read_bytes()
        self.assertEqual(self.delete(entry, csrf=False)[0], 403)
        self.assertEqual(self.delete(entry, origin='https://untrusted.invalid')[0], 403)
        plugin_runtime.set_enabled(self.store.directory, 'sessions', False)
        self.assertEqual(self.delete(entry)[0], 403)
        self.assertEqual(source.read_bytes(), before)
        plugin_runtime.set_enabled(self.store.directory, 'sessions', True)
        self.assertEqual(self.delete(entry)[0], 200)

    def test_backup_cleanup_failure_keeps_archive_retryable(self):
        _, entry, source = self.archived()
        before = source.read_bytes()
        backup = Path(str(self.store._path(entry['id'])) + '.bak')
        unlink = Path.unlink
        def fail_backup(path, *args, **kwargs):
            if path == backup:
                raise PermissionError('isolated cleanup failure')
            return unlink(path, *args, **kwargs)
        with patch.object(Path, 'unlink', fail_backup):
            self.assertEqual(self.delete(entry)[0], 500)
        self.assertEqual(source.read_bytes(), before)
        self.assertEqual(self.delete(entry)[0], 200)

    def test_mismatched_archive_or_backup_identity_is_rejected_before_deletion(self):
        _, entry, source = self.archived()
        backup = Path(str(self.store._path(entry['id'])) + '.bak')
        before = source.read_bytes()
        backup.write_text(json.dumps({'id': 'a' * 32}), encoding='utf-8')
        self.assertEqual(self.delete(entry)[0], 400)
        self.assertEqual(source.read_bytes(), before)
        value = json.loads(before)
        value['id'] = 'b' * 32
        source.write_text(json.dumps(value), encoding='utf-8')
        entry['revision'] = hashlib.sha256(source.read_bytes()).hexdigest()
        self.assertEqual(self.delete(entry)[0], 400)
        self.assertTrue(source.exists())
        self.assertEqual(session_management.list_archived(self.store), [])

    def test_archived_file_symlink_cannot_delete_external_file(self):
        _, entry, source = self.archived()
        external = self.base / 'external.json'
        external.write_bytes(source.read_bytes())
        source.unlink()
        make_symlink(source, external)
        before = external.read_bytes()
        self.assertEqual(self.delete(entry)[0], 400)
        self.assertEqual(external.read_bytes(), before)

    def test_backup_symlink_cannot_delete_external_file_or_primary_archive(self):
        _, entry, source = self.archived()
        external = self.base / 'external.json'
        external.write_bytes(source.read_bytes())
        backup = Path(str(self.store._path(entry['id'])) + '.bak')
        backup.unlink()
        make_symlink(backup, external)
        before = source.read_bytes()
        self.assertEqual(self.delete(entry)[0], 400)
        self.assertEqual(source.read_bytes(), before)
        self.assertEqual(external.read_bytes(), before)

    def test_archive_directory_junction_cannot_redirect_deletion(self):
        _, entry, source = self.archived()
        external = self.base / 'external-archive'
        source.parent.rename(external)
        make_directory_junction(source.parent, external)
        before = (external / source.name).read_bytes()
        self.assertEqual(self.delete(entry)[0], 400)
        self.assertEqual((external / source.name).read_bytes(), before)

    def test_invalid_identifier_cannot_escape_archive_directory(self):
        _, entry, source = self.archived()
        before = source.read_bytes()
        for sid in ('../keep', 'z' * 32, entry['id'] + '.json'):
            with self.subTest(sid=sid), self.assertRaises(ValueError):
                session_management.delete_archived(self.store, sid, entry['revision'])
        self.assertEqual(source.read_bytes(), before)


if __name__ == '__main__':
    unittest.main()
