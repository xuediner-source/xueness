import base64
import io
import json
import os
from pathlib import Path
import re
import tempfile
import threading
import time
import unittest
import zipfile
from contextlib import redirect_stdout, redirect_stderr
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

from xueness.core import Store, workspace_binary_preview
from xueness import cli, provider_config, providers_api, office_preview
from xueness.mcp_http import HttpMcpClient
from xueness.session_lease import lease
from xueness.terminals import Broker
from xueness.workflows import WorkflowStore
from xueness.operations_api import dispatch
from xueness.web import build_context


class ExtendedOperationsTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.state = self.root / 'state'
        self.store = Store(self.state)

    def command(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            result = cli.main(['--state', str(self.state), *argv])
        self.assertIn(result, (None, 0), err.getvalue())
        return out.getvalue()

    def test_cli_session_lifecycle_search_and_exclusive_lease(self):
        s = self.store.new('original', self.root)
        self.command('sessions', 'rename', s['id'], 'Renamed')
        self.command('sessions', 'pin', s['id'])
        items = json.loads(self.command('sessions', 'list', '--search', 'renamed'))['sessions']
        self.assertEqual(items[0]['id'], s['id'])
        self.assertTrue(items[0]['pinned'])
        with lease(self.store, s['id']):
            with self.assertRaises(BlockingIOError):
                with lease(self.store, s['id']):
                    pass
        self.command('sessions', 'archive', s['id'])
        self.assertEqual(json.loads(self.command('sessions', 'list'))['sessions'], [])
        self.assertEqual(len(json.loads(self.command('sessions', 'list', '--archived'))['sessions']), 1)
        self.command('sessions', 'restore', s['id'])
        self.assertEqual(self.store.load(s['id'])['title'], 'Renamed')

    def test_saved_profile_switches_runtime_model_without_echoing_key(self):
        with patch.dict(os.environ, {'TEST_PROFILE_KEY': 'private-test-key'}):
            output = self.command('providers', 'save', 'local', '--base-url', 'https://example.test/v1', '--model', 'model-a', '--key-env', 'TEST_PROFILE_KEY')
        self.assertNotIn('private-test-key', output)
        self.assertNotIn('private-test-key', self.command('providers', 'list'))
        provider = provider_config.resolve(self.state, 'local', 'model-b')
        self.assertEqual(provider.model, 'model-b')
        self.assertEqual(provider.key, 'private-test-key')
        with patch('xueness.cli._prompt', side_effect=['1', '/exit']):
            self.store.new('selection', self.root)
            self.command('chat', '--select')

    def office(self, name, members):
        p = self.root / name
        with zipfile.ZipFile(p, 'w') as z:
            for k, v in members.items(): z.writestr(k, v)
        return p

    def test_office_content_and_workspace_boundary(self):
        p = self.office('a.docx', {'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>&lt;script&gt;hello</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>'})
        r = office_preview.preview(p)
        self.assertEqual(r['sections'][0]['blocks'][0]['text'], '<script>hello')
        self.assertEqual(r['sections'][0]['blocks'][1]['table'], [['cell']])
        r = workspace_binary_preview(self.root, 'a.docx')
        self.assertEqual(r['office']['kind'], 'docx')
        with self.assertRaisesRegex(ValueError, 'not supported'):
            workspace_binary_preview(self.root, 'legacy.doc')
        with self.assertRaises((ValueError, PermissionError)): workspace_binary_preview(self.root, '../a.docx')
        p = self.office('a.pptx', {'ppt/slides/slide1.xml': '<a:p xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:r><a:t>Title</a:t></a:r><a:p><a:r><a:t>Slide content</a:t></a:r></a:p></a:p>'})
        self.assertIn('Slide content', json.dumps(office_preview.preview(p)))
        ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
        p = self.office('a.xlsx', {'xl/workbook.xml': f'<workbook xmlns="{ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" r:id="r1"/></sheets></workbook>', 'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>', 'xl/worksheets/sheet1.xml': f'<worksheet xmlns="{ns}"><sheetData><row><c r="A1" t="inlineStr"><is><t>hello</t></is></c><c r="C1"><v>42</v></c></row></sheetData></worksheet>'})
        self.assertEqual(office_preview.preview(p)['sections'][0]['blocks'][0]['table'], [['hello', '', '42']])
        p = self.office('bad.docx', {'word/document.xml': '<!DOCTYPE a [<!ENTITY x "bad">]><a>&x;</a>'})
        with self.assertRaises(ValueError): office_preview.preview(p)

    def test_office_preview_preserves_safe_rich_structure_and_embedded_images(self):
        png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/FZsAAAAASUVORK5CYII=')
        word_ns = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
        draw_ns = 'http://schemas.openxmlformats.org/drawingml/2006/main'
        rel_ns = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
        doc = f'''<w:document xmlns:w="{word_ns}" xmlns:a="{draw_ns}" xmlns:r="{rel_ns}"><w:body>
          <w:p><w:pPr><w:pStyle w:val="Heading1"/><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:color w:val="336699"/><w:sz w:val="32"/></w:rPr><w:t>Title</w:t></w:r></w:p>
          <w:p><w:r><w:drawing><a:blip r:embed="img1"/></w:drawing></w:r></w:p>
        </w:body></w:document>'''
        relationships = f'''<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
          <Relationship Id="img1" Type="image" Target="media/pixel.png"/>
          <Relationship Id="external" Type="image" Target="https://example.invalid/a.png" TargetMode="External"/>
        </Relationships>'''
        p = self.office('rich.docx', {
            'word/document.xml': doc,
            'word/_rels/document.xml.rels': relationships,
            'word/media/pixel.png': png,
        })
        result = office_preview.preview(p)
        paragraph, image = result['sections'][0]['blocks']
        self.assertEqual(paragraph['type'], 'paragraph')
        self.assertEqual(paragraph['style'], {'paragraphStyle': 'Heading1', 'align': 'center'})
        self.assertEqual(paragraph['runs'][0]['style'], {'bold': True, 'color': '#336699', 'fontSize': 16.0})
        self.assertEqual(image['images'][0]['mime'], 'image/png')
        self.assertTrue(image['images'][0]['dataUrl'].startswith('data:image/png;base64,'))
        self.assertEqual(result['imageCount'], 1)

    def test_office_full_document_repackages_without_external_or_active_parts(self):
        content_types = '''<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
          <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
          <Default Extension="xml" ContentType="application/xml"/>
          <Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/>
          <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
          <Override PartName="/word/chunk.html" ContentType="text/html"/>
          <Override PartName="/word/embeddings/oleObject1.bin" ContentType="application/vnd.openxmlformats-officedocument.oleObject"/>
        </Types>'''
        root_rels = '''<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
          <Relationship Id="doc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
        </Relationships>'''
        document = '''<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
          <w:body><w:p><w:r><w:t>Safe page</w:t></w:r></w:p><w:altChunk r:id="chunk"/><w:object><w:t>active object</w:t></w:object><w:sectPr/></w:body></w:document>'''
        rels = '''<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
          <Relationship Id="external" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.invalid/track" TargetMode="External"/>
          <Relationship Id="chunk" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk" Target="chunk.html"/>
          <Relationship Id="ole" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/oleObject" Target="embeddings/oleObject1.bin"/>
          <Relationship Id="activex" Type="http://schemas.microsoft.com/office/2006/relationships/activeXControl" Target="activeX/activeX1.bin"/>
          <Relationship Id="escape" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../../../../private/secret.png"/>
        </Relationships>'''
        path = self.office('safe-full.docx', {
            '[Content_Types].xml': content_types,
            '_rels/.rels': root_rels,
            'word/document.xml': document,
            'word/_rels/document.xml.rels': rels,
            'word/chunk.html': '<script>unsafe()</script>',
            'word/embeddings/oleObject1.bin': b'active payload',
            'word/activeX/activeX1.bin': b'active control payload',
            'private/secret.png': b'not an image',
            'word/vbaProject.bin': b'macro payload',
        })
        result = office_preview.preview(path)
        self.assertIn('fullDocument', result)
        package = base64.b64decode(result['fullDocument'])
        with zipfile.ZipFile(io.BytesIO(package)) as archive:
            names = set(archive.namelist())
            self.assertIn('word/document.xml', names)
            self.assertNotIn('word/chunk.html', names)
            self.assertNotIn('word/embeddings/oleObject1.bin', names)
            self.assertNotIn('word/activeX/activeX1.bin', names)
            self.assertNotIn('word/vbaProject.bin', names)
            safe_xml = archive.read('word/document.xml')
            safe_rels = archive.read('word/_rels/document.xml.rels')
            safe_types = archive.read('[Content_Types].xml')
            self.assertNotIn(b'altChunk', safe_xml)
            self.assertNotIn(b'object', safe_xml)
            self.assertNotIn(b'example.invalid', safe_rels)
            self.assertNotIn(b'chunk.html', safe_rels)
            self.assertNotIn(b'oleObject', safe_rels)
            self.assertNotIn(b'activex', safe_rels.lower())
            self.assertNotIn(b'private/secret', safe_rels)
            self.assertNotIn(b'macro', safe_types.lower())

    def test_office_full_document_rejects_entity_expansion_and_traversal(self):
        path = self.office('unsafe-full.docx', {
            '[Content_Types].xml': '<!DOCTYPE x [<!ENTITY e "unsafe">]><Types/>',
            '_rels/.rels': '<Relationships/>',
            'word/document.xml': '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>',
        })
        raw = path.read_bytes()
        self.assertIsNone(office_preview.sanitize_full_document(raw, '.docx'))
        # The legacy static DTO remains a valid fallback for packages whose
        # full-render sanitizer declines them; it still refuses entity XML
        # when that XML is on a parsed document path.

    def test_office_preview_preserves_slide_layout_and_spreadsheet_formats(self):
        p = self.office('rich.pptx', {
            'ppt/presentation.xml': '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldSz cx="9144000" cy="5143500"/></p:presentation>',
            'ppt/slides/slide1.xml': '''<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="1" name="Title"/></p:nvSpPr><p:spPr><a:xfrm><a:off x="914400" y="457200"/><a:ext cx="4572000" cy="914400"/></a:xfrm><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:spPr><p:txBody><a:p><a:r><a:rPr b="1" sz="3000"/><a:t>Slide title</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>''',
        })
        slide = office_preview.preview(p)['sections'][0]
        self.assertEqual(slide['layout'], {'width': 9144000, 'height': 5143500, 'unit': 'emu'})
        self.assertEqual(slide['blocks'][0]['position'], {'x': 914400, 'y': 457200, 'width': 4572000, 'height': 914400})
        self.assertEqual(slide['blocks'][0]['style']['fill'], '#FFFFFF')
        self.assertEqual(slide['blocks'][0]['runs'][0]['style']['fontSize'], 30.0)

        ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
        p = self.office('rich.xlsx', {
            'xl/workbook.xml': f'<workbook xmlns="{ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" r:id="r1"/></sheets></workbook>',
            'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>',
            'xl/styles.xml': f'<styleSheet xmlns="{ns}"><fonts count="1"><font><b/><sz val="14"/><color rgb="FF112233"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><cellXfs count="1"><xf fontId="0" fillId="0"><alignment horizontal="center"/></xf></cellXfs></styleSheet>',
            'xl/worksheets/sheet1.xml': f'<worksheet xmlns="{ns}"><cols><col min="1" max="1" width="24"/></cols><sheetData><row><c r="A1" t="inlineStr" s="0"><is><t>Header</t></is></c><c r="B1"><v>42</v></c></row></sheetData><mergeCells><mergeCell ref="A1:B1"/></mergeCells></worksheet>',
        })
        sheet = office_preview.preview(p)['sections'][0]['blocks'][0]
        self.assertEqual(sheet['cellStyles'][0][0], {'bold': True, 'fontSize': 14.0, 'color': '#112233', 'align': 'center'})
        self.assertEqual(sheet['columns'], [{'min': 1, 'max': 1, 'width': 24.0, 'hidden': False}])
        self.assertEqual(sheet['mergedRanges'], ['A1:B1'])

    def test_real_pty_input_resize_interrupt_and_cleanup(self):
        broker = Broker(); self.addCleanup(broker.close)
        term = broker.open(self.root, 'test')
        term.resize(90, 30)
        def wait_for(text):
            end = time.monotonic()+5
            output = ''
            while time.monotonic() < end:
                output = base64.b64decode(term.read(0)['data']).decode(errors='replace')
                if text in output: return output
                time.sleep(.03)
            self.fail('PTY did not return expected output: '+output)

        def wait_for_prompt_after(text):
            end = time.monotonic()+5
            output = ''
            while time.monotonic() < end:
                output = base64.b64decode(term.read(0)['data']).decode(errors='replace')
                plain = re.sub(r'\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\\\))', '', output)
                marker = plain.rfind(text)
                if marker >= 0 and re.search(r'(?:PS )?[A-Za-z]:\\[^>\r\n]*>', plain[marker+len(text):]):
                    return output
                time.sleep(.03)
            self.fail('PTY did not return to its prompt after interrupt: '+output)

        if os.name == 'nt':
            shell_name = Path(term.shell).name.casefold()
            if shell_name == 'cmd.exe':
                term.write('set ready=READY & call echo PTY_%%ready%%\r\n')
                wait_for('PTY_READY')
                term.write('echo SIZE_BEGIN & mode con & echo SIZE_END\r\n')
                output = wait_for('SIZE_END')
                size_report = output.split('SIZE_BEGIN', 1)[-1].split('SIZE_END', 1)[0]
                dimensions = re.findall(r'\b\d+\b', size_report)
                self.assertIn('30', dimensions)
                self.assertIn('90', dimensions)
                running = 'set status=RUNNING & call echo PTY_%%status%% & ping -n 31 127.0.0.1 >NUL\r\n'
                after_interrupt = 'set suffix=INTERRUPT & call echo AFTER_%%suffix%%\r\n'
            else:
                term.write("$r='PTY'; Write-Output ($r+'_READY')\r\n")
                wait_for('PTY_READY')
                term.write('Write-Output "SIZE=$($Host.UI.RawUI.WindowSize.Height)x$($Host.UI.RawUI.WindowSize.Width)"\r\n')
                wait_for('SIZE=30x90')
                running = "$r='PTY'; Write-Output ($r+'_RUNNING'); Start-Sleep -Seconds 30\r\n"
                after_interrupt = "$r='AFTER'; Write-Output ($r+'_INTERRUPT')\r\n"
        else:
            term.write("printf 'PTY_%s\\n' READY; stty size\n")
            wait_for('PTY_READY')
            output = wait_for('30 90')
            self.assertIn('30 90', output)
            running = "printf 'PTY_%s\\n' RUNNING; sleep 30\n"
            after_interrupt = "printf 'AFTER_%s\\n' INTERRUPT\n"

        term.write(running)
        wait_for('PTY_RUNNING')
        term.write('\x03')
        if os.name == 'nt':
            wait_for_prompt_after('PTY_RUNNING')
        term.write(after_interrupt)
        wait_for('AFTER_INTERRUPT')
        broker.close()
        if os.name == 'nt':
            self.assertFalse(term.proc.isalive())
        else:
            self.assertIsNotNone(term.proc.poll())
        self.assertTrue(term.closed)
        self.assertFalse(term.reader.is_alive())

    def test_workflow_api_approval_roots_and_subtask_snapshot(self):
        ctx = build_context(self.state, self.root/'runs', self.root, csrf='test')
        ctx['workspace_roots'] = [self.root]
        self.addCleanup(ctx['terminals'].close)
        ws = WorkflowStore(self.state)
        r = ws.create({'nodes': [{'id': 'a', 'argv': ['echo', 'hello']}]}, self.root)
        self.assertEqual(dispatch('POST', ['api','workflows',r['id'],'start'], {}, {}, ctx)[0], 400)
        hidden = ws.create({'nodes': [{'id': 'a', 'argv': ['echo', 'hello']}]}, Path.home())
        listed = dispatch('GET', ['api','workflows'], {}, {}, ctx)[1]['workflows']
        self.assertEqual([i['id'] for i in listed], [r['id']])
        self.assertEqual(dispatch('GET', ['api','workflows',hidden['id']], {}, {}, ctx)[0], 400)
        s = self.store.new('task', self.root); s['task_runs'] = [{'id':'child','status':'completed','startedAt':100}]; self.store.save(s)
        self.assertEqual(dispatch('GET', ['api','sessions',s['id'],'tasks'], {}, {}, ctx)[1]['tasks'], s['task_runs'])
        # Merging with live task registry
        ctx['task_registry'].record('task-live-1', parent_session=s['id'], agent='explorer', prompt='test prompt', root=self.root)
        tasks = dispatch('GET', ['api','sessions',s['id'],'tasks'], {}, {}, ctx)[1]['tasks']
        self.assertEqual(len(tasks), 2)
        self.assertEqual(tasks[0]['id'], 'child')
        self.assertEqual(tasks[1]['id'], 'task-live-1')
        self.assertEqual(tasks[1]['status'], 'running')
        # Live status overrides persisted status if same id
        s['task_runs'] = [{'id':'task-live-1','status':'pending','startedAt':50}]
        self.store.save(s)
        tasks_override = dispatch('GET', ['api','sessions',s['id'],'tasks'], {}, {}, ctx)[1]['tasks']
        self.assertEqual(len(tasks_override), 1)
        self.assertEqual(tasks_override[0]['status'], 'running')
        # Tolerates task_runs being None
        s['task_runs'] = None
        self.store.save(s)
        tasks_none = dispatch('GET', ['api','sessions',s['id'],'tasks'], {}, {}, ctx)[1]['tasks']
        self.assertEqual(len(tasks_none), 1)
        self.assertEqual(tasks_none[0]['id'], 'task-live-1')


class HttpMcpTests(unittest.TestCase):
    def test_json_and_sse_session_negotiation_and_tool_call(self):
        calls = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_POST(self):
                req = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                calls.append((req, dict(self.headers)))
                if 'id' not in req:
                    self.send_response(202); self.end_headers(); return
                if req['method'] == 'initialize':
                    result = {'protocolVersion': '2025-03-26', 'capabilities': {'tools': {}}, 'serverInfo': {'name': 'test', 'version':'1'}}
                elif req['method'] == 'tools/list': result = {'tools':[{'name':'echo','inputSchema':{'type':'object'}}]}
                else: result = {'content':[{'type':'text','text':'hello'}]}
                raw = json.dumps({'jsonrpc':'2.0','id':req['id'],'result':result})
                self.send_response(200); self.send_header('Mcp-Session-Id', 'session-one')
                self.send_header('Content-Type', 'text/event-stream' if req['method']=='tools/call' else 'application/json')
                self.end_headers(); self.wfile.write(('data: '+raw+'\n\n' if req['method']=='tools/call' else raw).encode())
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=server.serve_forever,daemon=True).start()
        self.addCleanup(server.server_close); self.addCleanup(server.shutdown)
        client = HttpMcpClient({'id':'test','transport':'http','url':f'http://127.0.0.1:{server.server_port}/mcp','allowLoopbackHttp':True}, cwd=Path.cwd())
        self.addCleanup(client.close)
        client.start(); self.assertIsNone(client.error)
        self.assertEqual(client.list_tools()[0]['name'], 'echo')
        self.assertTrue(client.call_tool('echo', {})['ok'])
        self.assertEqual(calls[-1][1]['Mcp-Session-Id'], 'session-one')
        self.assertEqual(calls[-1][1]['Mcp-Protocol-Version'], '2025-03-26')

    def test_http_requires_explicit_literal_loopback(self):
        for url in ('http://localhost/mcp', 'http://example.com/mcp', 'https://user:secret@example.com/mcp'):
            client = HttpMcpClient({'id':'bad','url':url,'allowLoopbackHttp':True}, cwd=Path.cwd())
            client.start()
            self.assertFalse(client.active)
            self.assertNotIn('secret', client.error)

class OnDemandSkillTests(unittest.TestCase):
    def test_catalog_does_not_inject_bodies_and_reads_are_bounded_and_gated(self):
        from xueness import skills
        from xueness.core import Gate, run
        from xueness.plugins import activate
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); directory = root/'resources'/'skills'; directory.mkdir(parents=True)
            (directory/'sample.json').write_text(json.dumps({'id':'sample','name':'Sample','description':'catalog description','body':'private body marker'+'x'*18000}))
            self.assertNotIn('private body marker', skills.catalog(root))
            self.assertLess(len(skills.read_skill(root, 'sample')['content']), 15000)
            self.assertFalse(skills.read_skill(root, '../../sample')['ok'])
            class Provider:
                def complete(self, messages, tools):
                    self.tools = tools
                    self.prompt = messages
                    return {'content':'', 'tool_calls':[{'id':'skill-call','type':'function','function':{'name':'skill_read','arguments':'{"id":"sample"}'}}]}
            store = Store(root/'sessions'); session=store.new('read skill',root); session['skill_catalog']=True
            with activate(['skills'], root, root, session) as ext:
                provider = Provider()
                result=run(session,store,provider,Gate(root,mode='plan'),max_steps=1,**ext.kwargs)
                self.assertTrue(result['results']['skill-call']['ok'])
                self.assertIn('skill_read',[t['function']['name'] for t in provider.tools])
                # The injected catalog appears before the model result, with no body.
                self.assertNotIn('private body marker', provider.prompt[1]['content'])
                session=store.new('denied skill',root)
                result=run(session,store,Provider(),Gate(root,disallow=['skill_read']),max_steps=1,**ext.kwargs)
                self.assertEqual(result['results']['skill-call']['error'],'denied')
            (directory/'sample.json').write_text(json.dumps({'id':'sample','name':'Sample','enabled':False,'body':'hidden'}))
            self.assertFalse(skills.read_skill(root, 'sample')['ok'])

class ModelTransportTests(unittest.TestCase):
    def test_selected_profile_and_override_reach_actual_http_request(self):
        received=[]
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args): pass
            def do_POST(self):
                payload=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                received.append((payload,self.headers.get('Authorization')))
                self.send_response(200); self.send_header('Content-Type','application/json'); self.end_headers()
                self.wfile.write(json.dumps({'choices':[{'message':{'role':'assistant','content':'{"summary":"test","evidence":[]}'}}]}).encode())
        remote=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        threading.Thread(target=remote.serve_forever,daemon=True).start()
        self.addCleanup(remote.server_close);self.addCleanup(remote.shutdown)
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ,{'XUENESS_ALLOW_LOOPBACK_HTTP':'1'}):
            state=Path(tmp)
            status,_=providers_api.dispatch('POST',['api','providers'],{}, {'id':'chosen','name':'Chosen','baseUrl':f'http://127.0.0.1:{remote.server_port}/v1','model':'default','apiKey':'test-secret'}, {'state_dir':state})
            self.assertEqual(status,200)
            out=io.StringIO()
            with redirect_stdout(out),redirect_stderr(io.StringIO()):
                cli.main(['--state',str(state),'run','--prompt','hello','--root',str(state/'workspace'),'--provider-id','chosen','--model','overridden','--steps','1','--output-format','json'])
            self.assertEqual(received[0][0]['model'],'overridden')
            self.assertEqual(received[0][1],'Bearer test-secret')
            self.assertNotIn('test-secret',out.getvalue())
            saved=Store(state).list()[0]
            journal=Store(state).load(saved['id'])
            self.assertEqual(journal['model_selection'],{'provider_id':'chosen','model':'overridden'})
            self.assertNotIn('test-secret',json.dumps(journal))

class ParentStopTests(unittest.TestCase):
    def test_parent_stop_propagates_into_active_subagent(self):
        from xueness.core import Gate, run
        from xueness.task_registry import TaskRegistry
        stopped = threading.Event()
        class Provider:
            calls = 0
            def complete(self, messages, tools):
                self.calls += 1
                if self.calls == 1:
                    return {'content':'','tool_calls':[{'id':'delegate','type':'function','function':{'name':'task','arguments':'{"prompt":"read workspace"}'}}]}
                stopped.set()
                return {'content':'ignored after stop'}
        with tempfile.TemporaryDirectory() as tmp:
            store=Store(Path(tmp)/'state'); s=store.new('parent',Path(tmp)); registry=TaskRegistry(); provider=Provider()
            result=run(s,store,provider,Gate(Path(tmp)),max_steps=3,subagents=[],registry=registry,should_stop=stopped.is_set)
            self.assertEqual(result['status'],'stopped')
            self.assertEqual(result['task_runs'][0]['status'],'cancelled')
            # Parent and child requests can overlap; neither may start another
            # request after observing cancellation at a boundary.
            self.assertIn(provider.calls, (2, 3))
