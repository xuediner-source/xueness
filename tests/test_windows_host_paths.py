"""Host regressions for Windows folder browsing and session read state."""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from xueness.core import Store
from xueness.bundled_plugins.files import directory_api
from xueness.bundled_plugins.sessions.session_management import mark_viewed


class WindowsHostPathsTests(unittest.TestCase):
    def test_windows_path_requires_both_drive_and_root(self):
        with patch.object(directory_api.os, 'name', 'nt'):
            self.assertTrue(directory_api.fully_qualified('E:\\models'))
            self.assertTrue(directory_api.fully_qualified('E:/models'))
            for value in ('E:models', '\\models', '/models', 'models'):
                self.assertFalse(directory_api.fully_qualified(value))

    def test_actual_host_directory_browse_and_creation_stay_in_root(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            child = directory_api.create_child((root,), str(root), 'project')
            listing = directory_api.list_level((root,), str(root))
            self.assertEqual(listing['entries'][0]['path'], child)
            self.assertEqual(listing['entries'][0]['name'], 'project')

    def test_session_read_state_without_fchmod_is_saved_without_open_temp_file(self):
        with tempfile.TemporaryDirectory() as temporary, patch.dict(os.__dict__):
            os.__dict__.pop('fchmod', None)
            root = Path(temporary)
            store = Store(root / 'state')
            session = store.new('test', root)
            mark_viewed(store, session['id'])
            directory = root / 'state/.xueness-session-read'
            records = list(directory.glob('*.json'))
            self.assertEqual(len(records), 1)
            self.assertIn('readThroughMtimeNs', json.loads(records[0].read_text('utf-8')))
            self.assertEqual(list(directory.glob('.*')), [])


if __name__ == '__main__':
    unittest.main()
