"""Stage 5 sub-agent tests.

Covers the contract in docs/stage5-contract.md, section "三、子智能体
（``xueness/subagents.py``）": loading filters (empty/missing directory,
``enabled: false``, non-string/blank ``id``/``name``, broken JSON), stable
ascending id order, symlink refusal at both entry and directory level,
``select`` by id / by name / miss / non-string, ``build_system_prompt``
composition + key precedence + clipping to ``PROMPT_MAX_CHARS``, the
``task_tool_schema`` shape, and the read-only guarantee (file tree snapshot
identical before/after, and a symlink target outside the state dir never read).
"""
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from tests.fs_link_helpers import make_directory_boundary_link, make_symlink
from xueness.subagents import (PROMPT_MAX_CHARS, SUBAGENT_DENIED_TOOL_NAMES, TASK_TOOL_NAME,
                               TRUNCATION_SUFFIX, agent_tool_allowlist,
                               build_system_prompt,
                               load, provider_for_agent,
                               provider_with_agent_tools, select, task_tool_schema)


class SubagentsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.state_dir = self.root / "state"
        self.subagents_dir = self.state_dir / "resources" / "subagents"
        self.subagents_dir.mkdir(parents=True)

    def tearDown(self):
        self.temp.cleanup()

    def write_agent(self, filename: str, payload) -> Path:
        path = self.subagents_dir / filename
        if isinstance(payload, str):
            path.write_text(payload, encoding="utf-8")
        else:
            path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        return path

    def snapshot(self) -> dict:
        """path -> (mtime_ns, size) for the whole state dir, symlinks included."""
        out = {}
        for base, dirs, files in os.walk(self.state_dir, followlinks=False):
            for name in list(dirs) + list(files):
                path = Path(base) / name
                try:
                    stat = path.lstat()
                except OSError:
                    continue
                out[str(path)] = (stat.st_mtime_ns, stat.st_size)
        return out

    # --- empty --------------------------------------------------------------

    def test_empty_directory_returns_empty_list(self):
        self.assertEqual(load(self.state_dir), [])

    def test_missing_directory_returns_empty_list(self):
        shutil.rmtree(self.subagents_dir)
        self.assertEqual(load(self.state_dir), [])

    def test_missing_state_dir_returns_empty_list(self):
        shutil.rmtree(self.state_dir)
        self.assertEqual(load(self.state_dir), [])

    # --- happy path ---------------------------------------------------------

    def test_single_agent_is_returned(self):
        self.write_agent("a.json", {
            "id": "a", "name": "Researcher",
            "description": "Digs things up", "systemPrompt": "Be terse.",
        })
        agents = load(self.state_dir)
        self.assertEqual(len(agents), 1)
        self.assertEqual(agents[0]["id"], "a")
        self.assertEqual(agents[0]["name"], "Researcher")

    def test_extra_fields_are_preserved(self):
        self.write_agent("a.json", {"id": "a", "name": "A", "model": "m-1", "tools": ["read"]})
        agents = load(self.state_dir)
        self.assertEqual(agents[0]["model"], "m-1")
        self.assertEqual(agents[0]["tools"], ["read"])

    def test_tool_allowlist_distinguishes_inherit_from_explicit_empty(self):
        self.assertIsNone(agent_tool_allowlist({}))
        self.assertIsNone(agent_tool_allowlist({"tools": None}))
        self.assertEqual(agent_tool_allowlist({"tools": []}), frozenset())
        self.assertIsNone(agent_tool_allowlist({"tools": ["*"]}))
        self.assertEqual(agent_tool_allowlist({"tools": ["read", "unknown", 7]}),
                         frozenset({"read"}))

    def test_provider_override_resolves_saved_profile_model_and_effort(self):
        parent = object()
        selected = object()
        with patch("xueness.bundled_plugins.providers.provider_config.resolve",
                   return_value=selected) as resolve:
            result = provider_for_agent(
                {"providerId": "fast", "model": "custom-2", "reasoningEffort": "high"},
                parent,
                self.state_dir,
                {"provider_id": "main", "model": "main-model"},
            )
        self.assertIs(result, selected)
        resolve.assert_called_once_with(self.state_dir, "fast", "custom-2",
                                        reasoning_effort="high")

    def test_no_provider_override_reuses_parent_provider(self):
        parent = object()
        self.assertIs(provider_for_agent({"name": "Reader"}, parent, self.state_dir), parent)

    def test_configured_parent_adapter_is_copied_for_an_overlapping_child(self):
        from xueness.bundled_plugins.providers.provider import OpenAICompatible

        parent = object.__new__(OpenAICompatible)
        parent.model = "fixture-model"
        parent.compatibility = {"stream": True}
        parent.lightweight_options = {"requestDeadlineSeconds": 20}
        parent.capabilities = {"image"}
        child = provider_for_agent({"name": "Reader"}, parent, self.state_dir)

        self.assertIsNot(child, parent)
        self.assertEqual(child.model, parent.model)
        self.assertIsNot(child.compatibility, parent.compatibility)
        self.assertIsNot(child.lightweight_options, parent.lightweight_options)
        self.assertIsNot(child.capabilities, parent.capabilities)

    def test_model_only_override_keeps_the_parent_profile(self):
        parent = object()
        selected = object()
        with patch("xueness.bundled_plugins.providers.provider_config.resolve",
                   return_value=selected) as resolve:
            result = provider_for_agent(
                {"model": "custom-2"}, parent, self.state_dir,
                {"provider_id": "main", "model": "main-model"},
            )
        self.assertIs(result, selected)
        resolve.assert_called_once_with(self.state_dir, "main", "custom-2",
                                        reasoning_effort=None)

    def test_tool_filtered_provider_advertises_only_allowlisted_schemas(self):
        class Provider:
            model = "fixture-model"

            def __init__(self):
                self.seen = None

            def complete(self, messages, tools):
                self.seen = tools
                return {"content": "ok"}

        provider = Provider()
        wrapped = provider_with_agent_tools(provider, {"tools": ["read"]})
        schemas = [
            {"type": "function", "function": {"name": name}}
            for name in ("read", "write")
        ]
        wrapped.complete([], schemas)
        self.assertEqual([item["function"]["name"] for item in provider.seen], ["read"])
        self.assertEqual(wrapped.model, "fixture-model")
        wrapped.request_deadline = 42.0
        self.assertEqual(provider.request_deadline, 42.0)

    def test_inherited_explicit_all_and_custom_schemas_never_advertise_workflow_mutators(self):
        class Provider:
            def __init__(self):
                self.seen = None

            def complete(self, messages, tools):
                self.seen = tools
                return {"content": "ok"}

        schemas = [
            {"type": "function", "function": {"name": name}}
            for name in ("workflow_create", "workflow_amend", "workflow_status",
                         "background_status", "background_logs", "todo_write", "read")
        ]
        for agent in ({}, {"tools": ["*"]},
                      {"tools": ["workflow_create", "workflow_amend", "workflow_status",
                                 "background_status", "background_logs", "todo_write"]}):
            with self.subTest(agent=agent):
                provider = Provider()
                provider_with_agent_tools(provider, agent).complete([], schemas)
                names = [item["function"]["name"] for item in provider.seen]
                self.assertTrue(SUBAGENT_DENIED_TOOL_NAMES.isdisjoint(names))
                for retained in ("workflow_status", "background_status", "background_logs",
                                 "todo_write"):
                    self.assertIn(retained, names)

    def test_subagent_run_uses_configured_provider_and_tool_boundary(self):
        from xueness.core import Gate, _run_subagent

        parent = object()
        selected = object()
        agent = {"id": "reader", "name": "Reader", "providerId": "fast",
                 "model": "custom-2", "reasoningEffort": "high", "tools": ["read"]}
        def complete_child(child, *_args, **_kwargs):
            child["status"] = "completed"
            child["completion"] = {"summary": "done"}

        with patch("xueness.core.run", side_effect=complete_child) as child_run, patch(
            "xueness.bundled_plugins.providers.provider_config.resolve",
            return_value=selected,
        ) as resolve:
            result = _run_subagent(
                Gate(self.root), parent, [agent], "Inspect one file", "reader",
                depth=0, max_depth=1, state_dir=self.state_dir,
                parent_model_selection={"provider_id": "main", "model": "main-model"},
            )

        self.assertTrue(result["ok"])
        resolve.assert_called_once_with(self.state_dir, "fast", "custom-2",
                                        reasoning_effort="high")
        args, kwargs = child_run.call_args
        self.assertIs(args[2]._provider, selected)
        self.assertEqual(args[3].allowed_tool_names, frozenset({"read"}))
        self.assertEqual(args[3].disallow, frozenset())
        self.assertEqual(kwargs["policy_state_dir"], self.state_dir)
        self.assertEqual(kwargs["max_wall_seconds"], 120)

    def test_explicit_unknown_agent_does_not_fall_back_to_a_generic_child(self):
        from xueness.core import Gate, _run_subagent
        from xueness.task_registry import TaskRegistry

        with patch("xueness.core.run") as child_run:
            result = _run_subagent(
                Gate(self.root), object(), [], "Inspect one file", "missing",
                depth=0, max_depth=1, state_dir=self.state_dir,
                registry=TaskRegistry(),
            )

        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "sub-agent not found")
        child_run.assert_not_called()

    def test_async_runner_finishes_pre_recorded_task_with_child_terminal_status(self):
        from xueness.bundled_plugins.subagents.runner import run_subagent
        from xueness.core import Gate
        from xueness.task_registry import FAILED, TaskRegistry

        registry = TaskRegistry()
        registry.record("task-pre-recorded", parent_session="parent", agent=None,
                        prompt="inspect", root=self.root)
        original_started_at = registry.get("task-pre-recorded")["startedAt"]
        observed = {}

        class Provider:
            model = "fixture-model"

        def pause_child(child, _store, provider, gate, **kwargs):
            observed.update(provider=provider, gate=gate, kwargs=kwargs)
            child["status"] = "paused"
            child["pause_reason"] = "child time limit reached"
            child["messages"].append({"role": "assistant", "content": "partial result"})

        with patch.object(registry, "record", side_effect=AssertionError("duplicate record")):
            result = run_subagent(
                Gate(self.root, disallow={"read", "workflow_status"}), Provider(), [],
                "inspect", None, depth=0, max_depth=1, state_dir=self.state_dir,
                registry=registry, parent_session="parent", task_id="task-pre-recorded",
                gate_class=Gate, run_fn=pause_child, base_system="base",
                max_steps=4, summary_max=100,
            )

        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "child time limit reached")
        self.assertEqual(result["task_id"], "task-pre-recorded")
        task = registry.get("task-pre-recorded")
        self.assertEqual(task["status"], FAILED)
        self.assertEqual(task["summary"], "partial result")
        self.assertEqual(task["error"], "child time limit reached")
        self.assertEqual(task["startedAt"], original_started_at)
        self.assertIn("read", observed["gate"].disallow)
        self.assertEqual(observed["gate"].allowed_tool_names, None)
        self.assertIn("read", observed["gate"].denied_tool_names)
        self.assertIn("workflow_status", observed["gate"].denied_tool_names)
        self.assertEqual(observed["kwargs"]["max_wall_seconds"], 120)
        filtered = observed["provider"]._filter([
            {"type": "function", "function": {"name": name}}
            for name in ("read", "list", "workflow_status", "workflow_create")
        ])
        self.assertEqual([item["function"]["name"] for item in filtered], ["list"])

    def test_async_runner_records_provider_failure_instead_of_leaving_task_running(self):
        from xueness.bundled_plugins.subagents.runner import run_subagent
        from xueness.core import Gate
        from xueness.task_registry import FAILED, TaskRegistry

        registry = TaskRegistry()

        def fail_child(*_args, **_kwargs):
            raise RuntimeError("provider request failed")

        result = run_subagent(
            Gate(self.root), object(), [], "inspect", None, depth=0, max_depth=1,
            state_dir=self.state_dir, registry=registry, parent_session="parent",
            gate_class=Gate, run_fn=fail_child, base_system="base",
            max_steps=4, summary_max=100,
        )

        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "sub-agent run failed")
        self.assertEqual(registry.get(result["task_id"])["status"], FAILED)

    def test_tool_allowlist_blocks_a_model_call_even_when_schema_filter_is_bypassed(self):
        from xueness.core import Gate, run

        target = self.root / "should-not-exist.txt"

        class Store:
            def __init__(self, directory):
                self.directory = directory

            def save(self, session):
                pass

        class Provider:
            model = "fixture-model"

            def complete(self, messages, tools):
                return {"content": "", "tool_calls": [{
                    "id": "fixture-call", "type": "function",
                    "function": {"name": "write", "arguments": json.dumps({
                        "path": target.name, "content": "should be denied",
                    })},
                }]}

        gate = Gate(self.root, allow_write=True, mode="build")
        gate.allowed_tool_names = frozenset({"read"})
        session = {
            "id": "sub-fixture", "root": str(self.root), "status": "pending",
            "messages": [{"role": "system", "content": "fixture"},
                         {"role": "user", "content": "write a file"}],
            "results": {}, "steps": 0,
        }
        run(session, Store(self.state_dir), Provider(), gate, max_steps=1)
        self.assertEqual(session["results"]["fixture-call"]["error"], "denied")
        self.assertFalse(target.exists())

    def test_subagent_workflow_mutators_are_not_advertised_or_persisted(self):
        """A forced provider call cannot create or amend durable workflows.

        Exercise the full child runner for inherited, explicit-all and custom
        tool configurations. The fake provider deliberately emits calls even
        though the schema filter removes them, proving dispatch enforces the
        same boundary before WorkflowStore handlers can run.
        """
        from xueness.core import Gate, _run_subagent
        from xueness.workflows import WorkflowStore

        # Parent planning keeps its existing policy for planning-kind tools;
        # the durable-write exception is scoped to _run_subagent's child Gate.
        parent_plan_gate = Gate(self.root, mode="plan")
        parent_plan_gate.check("planning", "workflow_create")
        parent_plan_gate.check("planning", "workflow_amend")

        workflows = WorkflowStore(self.state_dir)
        existing = workflows.create(
            {"nodes": [{"id": "initial", "argv": ["python3", "-c", "print('initial')"]}]},
            self.root,
        )
        existing_path = workflows.path(existing["id"])
        original_record = existing_path.read_bytes()
        original_ids = {path.name for path in workflows.directory.glob("*.json")}

        modes = (
            ("inherit", {}),
            ("all", {"tools": ["*"]}),
            ("custom", {"tools": ["workflow_create", "workflow_amend", "workflow_status",
                                   "background_status", "background_logs", "todo_write"]}),
        )
        for mode, tool_config in modes:
            for tool_name in ("workflow_create", "workflow_amend"):
                with self.subTest(mode=mode, tool=tool_name):
                    call_args = (
                        {"plan": {"nodes": [{"id": "created", "argv": ["python3", "-c", "print('new')"]}]} }
                        if tool_name == "workflow_create" else
                        {"workflow_id": existing["id"],
                         "plan": {"nodes": [{"id": "changed", "argv": ["python3", "-c", "print('changed')"]}]}}
                    )

                    class Provider:
                        model = "local-fixture"

                        def __init__(self):
                            self.requested_schemas = []
                            self.tool_results = []
                            self.call_count = 0

                        def complete(self, messages, tools):
                            self.requested_schemas.append(tools)
                            self.call_count += 1
                            if self.call_count == 1:
                                return {"content": "", "tool_calls": [{
                                    "id": "forced-" + mode + "-" + tool_name,
                                    "type": "function",
                                    "function": {"name": tool_name,
                                                 "arguments": json.dumps(call_args)},
                                }]}
                            for message in messages:
                                if message.get("role") == "tool":
                                    self.tool_results.append(json.loads(message["content"]))
                            return {"content": "The durable workflow was not changed."}

                    provider = Provider()
                    agent = {"id": "fixture", "name": "Fixture", **tool_config}
                    child_results = []
                    def capture_child(_store, child):
                        if child.get("results"):
                            child_results[:] = list(child["results"].values())
                    with patch("xueness.bundled_plugins.subagents.runner._NullStore.save", capture_child):
                        result = _run_subagent(
                            Gate(self.root), provider, [agent], "Inspect safely", "fixture",
                            depth=0, max_depth=1, state_dir=self.state_dir,
                        )
                    self.assertFalse(result["ok"], "a denied child action is not a completed task")
                    self.assertTrue(result["error"])
                    # A policy refusal stops immediately, without sending a
                    # second request merely to ask the model to explain it.
                    self.assertEqual(provider.call_count, 1)
                    self.assertEqual(result["steps"], 1)
                    self.assertEqual(len(child_results), 1)
                    self.assertFalse(child_results[0]["ok"])
                    self.assertEqual(child_results[0]["error_code"], "permission_denied")
                    self.assertFalse(child_results[0]["retryable"])
                    first_names = {schema["function"]["name"]
                                   for schema in provider.requested_schemas[0]}
                    self.assertTrue(SUBAGENT_DENIED_TOOL_NAMES.isdisjoint(first_names))
                    for readable in ("workflow_status", "background_status", "background_logs",
                                     "todo_write"):
                        self.assertIn(readable, first_names)
                    self.assertEqual({path.name for path in workflows.directory.glob("*.json")},
                                     original_ids)
                    self.assertEqual(existing_path.read_bytes(), original_record)

    def test_id_and_name_are_stripped(self):
        self.write_agent("a.json", {"id": "  a  ", "name": "  Spaced  "})
        agents = load(self.state_dir)
        self.assertEqual(agents[0]["id"], "a")
        self.assertEqual(agents[0]["name"], "Spaced")

    # --- filtering ----------------------------------------------------------

    def test_disabled_agent_is_skipped(self):
        self.write_agent("on.json", {"id": "on", "name": "On"})
        self.write_agent("off.json", {"id": "off", "name": "Off",
                                      "enabled": False, "systemPrompt": "SECRET-PROMPT"})
        agents = load(self.state_dir)
        self.assertEqual([a["id"] for a in agents], ["on"])

    def test_missing_enabled_counts_as_enabled(self):
        self.write_agent("a.json", {"id": "a", "name": "Implicit"})
        self.write_agent("b.json", {"id": "b", "name": "Truthy", "enabled": True})
        self.assertEqual([a["id"] for a in load(self.state_dir)], ["a", "b"])

    def test_non_string_or_blank_id_is_skipped(self):
        self.write_agent("a.json", {"name": "No id"})
        self.write_agent("b.json", {"id": 7, "name": "Numeric id"})
        self.write_agent("c.json", {"id": "  ", "name": "Blank id"})
        self.write_agent("d.json", {"id": None, "name": "None id"})
        self.write_agent("e.json", {"id": ["x"], "name": "List id"})
        self.write_agent("ok.json", {"id": "ok", "name": "Kept"})
        self.assertEqual([a["id"] for a in load(self.state_dir)], ["ok"])

    def test_non_string_or_blank_name_is_skipped(self):
        self.write_agent("a.json", {"id": "a"})
        self.write_agent("b.json", {"id": "b", "name": 7})
        self.write_agent("c.json", {"id": "c", "name": "   "})
        self.write_agent("d.json", {"id": "d", "name": None})
        self.write_agent("ok.json", {"id": "ok", "name": "Kept"})
        self.assertEqual([a["id"] for a in load(self.state_dir)], ["ok"])

    def test_broken_and_non_object_files_are_skipped_in_isolation(self):
        self.write_agent("broken.json", "{ this is not json ")
        self.write_agent("arr.json", "[1, 2, 3]")
        self.write_agent("good.json", {"id": "good", "name": "Survivor"})
        agents = load(self.state_dir)
        self.assertEqual([a["id"] for a in agents], ["good"])
        self.assertEqual(agents[0]["name"], "Survivor")

    def test_non_json_files_are_ignored(self):
        (self.subagents_dir / "notes.txt").write_text("ignore me", encoding="utf-8")
        self.write_agent("a.json", {"id": "a", "name": "A"})
        self.assertEqual([a["id"] for a in load(self.state_dir)], ["a"])

    # --- ordering -----------------------------------------------------------

    def test_sorted_by_id_ascending(self):
        self.write_agent("z.json", {"id": "zeta", "name": "Zeta"})
        self.write_agent("a.json", {"id": "alpha", "name": "Alpha"})
        self.write_agent("m.json", {"id": "mid", "name": "Mid"})
        self.assertEqual([a["id"] for a in load(self.state_dir)], ["alpha", "mid", "zeta"])

    def test_ordering_is_stable_across_calls(self):
        for sid in ("b", "a", "c"):
            self.write_agent(sid + ".json", {"id": sid, "name": sid.upper()})
        self.assertEqual(load(self.state_dir), load(self.state_dir))

    def test_filename_does_not_affect_order(self):
        # ids sort independently of the on-disk filenames
        self.write_agent("aaa.json", {"id": "zzz", "name": "Z"})
        self.write_agent("zzz.json", {"id": "aaa", "name": "A"})
        self.assertEqual([a["id"] for a in load(self.state_dir)], ["aaa", "zzz"])

    # --- symlinks -----------------------------------------------------------

    def test_symlinked_entry_is_skipped(self):
        secret = self.root / "outside-secret.json"
        secret.write_text(json.dumps({"id": "evil", "name": "Evil",
                                      "systemPrompt": "SECRET-OUTSIDE"}), encoding="utf-8")
        make_symlink(self.subagents_dir / "evil.json", secret)
        self.write_agent("ok.json", {"id": "ok", "name": "Legit"})
        agents = load(self.state_dir)
        self.assertEqual([a["id"] for a in agents], ["ok"])
        self.assertNotIn("SECRET-OUTSIDE", json.dumps(agents))

    def test_symlinked_directory_returns_empty_list(self):
        outside = self.root / "outside-subagents"
        outside.mkdir()
        (outside / "a.json").write_text(
            json.dumps({"id": "a", "name": "Outside", "systemPrompt": "SECRET-DIR"}),
            encoding="utf-8")
        shutil.rmtree(self.subagents_dir)
        make_directory_boundary_link(self.subagents_dir, outside)
        self.assertEqual(load(self.state_dir), [])

    def test_broken_symlink_entry_is_skipped(self):
        make_symlink(self.subagents_dir / "dangling.json", self.root / "nope.json")
        self.write_agent("ok.json", {"id": "ok", "name": "Legit"})
        self.assertEqual([a["id"] for a in load(self.state_dir)], ["ok"])

    # --- read-only guarantee ------------------------------------------------

    def test_load_never_writes_to_state_dir(self):
        self.write_agent("a.json", {"id": "a", "name": "Alpha", "systemPrompt": "p" * 2000})
        self.write_agent("bad.json", "{ not json")
        secret = self.root / "secret.json"
        secret.write_text(json.dumps({"id": "x", "name": "X", "systemPrompt": "SECRET-VALUE"}),
                          encoding="utf-8")
        make_symlink(self.subagents_dir / "link.json", secret)

        before = self.snapshot()
        agents = load(self.state_dir)
        select(agents, "a")
        build_system_prompt(agents[0] if agents else {}, "base")
        task_tool_schema()
        after = self.snapshot()

        self.assertEqual(before, after)
        self.assertEqual(secret.read_text(encoding="utf-8"),
                         json.dumps({"id": "x", "name": "X", "systemPrompt": "SECRET-VALUE"}))
        self.assertNotIn("SECRET-VALUE", json.dumps(agents))

    def test_missing_state_dir_is_not_created(self):
        shutil.rmtree(self.state_dir)
        load(self.state_dir)
        self.assertFalse(self.state_dir.exists())

    # --- select -------------------------------------------------------------

    def test_select_matches_by_id(self):
        agents = [{"id": "a", "name": "Alpha"}, {"id": "b", "name": "Beta"}]
        self.assertIs(select(agents, "b"), agents[1])

    def test_select_matches_by_name(self):
        agents = [{"id": "a", "name": "Alpha"}, {"id": "b", "name": "Beta"}]
        self.assertIs(select(agents, "Alpha"), agents[0])

    def test_select_returns_none_on_miss(self):
        agents = [{"id": "a", "name": "Alpha"}]
        self.assertIsNone(select(agents, "nope"))

    def test_select_returns_none_for_non_string_or_blank(self):
        agents = [{"id": "a", "name": "Alpha"}]
        for bad in (None, 7, [], {}, "   ", ""):
            self.assertIsNone(select(agents, bad), msg=repr(bad))

    def test_select_on_empty_list_returns_none(self):
        self.assertIsNone(select([], "a"))

    def test_select_tolerates_non_dict_entries(self):
        agents = ["junk", None, {"id": "a", "name": "Alpha"}]
        self.assertIs(select(agents, "a"), agents[2])

    def test_select_does_not_substring_match(self):
        agents = [{"id": "alpha", "name": "Alpha"}]
        self.assertIsNone(select(agents, "alph"))
        self.assertIsNone(select(agents, "alphaa"))

    def test_select_round_trips_loaded_agents(self):
        self.write_agent("a.json", {"id": "a", "name": "Alpha"})
        agents = load(self.state_dir)
        self.assertIs(select(agents, "a"), agents[0])
        self.assertIs(select(agents, "Alpha"), agents[0])

    # --- build_system_prompt ------------------------------------------------

    def test_build_prepends_base_and_includes_agent_text(self):
        out = build_system_prompt({"systemPrompt": "Be terse."}, "BASE")
        self.assertTrue(out.startswith("BASE"))
        self.assertIn("Be terse.", out)
        self.assertGreater(len(out), len("BASE"))

    def test_build_prefers_system_prompt_over_prompt_over_description(self):
        out = build_system_prompt({
            "systemPrompt": "FROM-SYSTEM-PROMPT",
            "prompt": "FROM-PROMPT",
            "description": "FROM-DESCRIPTION",
        }, "BASE")
        self.assertIn("FROM-SYSTEM-PROMPT", out)
        self.assertNotIn("FROM-PROMPT", out)
        self.assertNotIn("FROM-DESCRIPTION", out)

        out = build_system_prompt({"prompt": "FROM-PROMPT", "description": "FROM-DESCRIPTION"}, "BASE")
        self.assertIn("FROM-PROMPT", out)
        self.assertNotIn("FROM-DESCRIPTION", out)

        out = build_system_prompt({"description": "FROM-DESCRIPTION"}, "BASE")
        self.assertIn("FROM-DESCRIPTION", out)

    def test_build_falls_through_blank_values(self):
        out = build_system_prompt({"systemPrompt": "   ", "prompt": "FROM-PROMPT"}, "BASE")
        self.assertIn("FROM-PROMPT", out)

    def test_build_without_any_text_returns_base_only(self):
        for agent in ({}, {"id": "a", "name": "A"}, {"systemPrompt": ""},
                      {"prompt": 7, "description": None}, None, "junk"):
            self.assertEqual(build_system_prompt(agent, "BASE"), "BASE", msg=repr(agent))

    def test_build_ignores_non_string_instruction_values(self):
        out = build_system_prompt({"systemPrompt": 5, "prompt": ["x"], "description": "OK-DESC"}, "B")
        self.assertIn("OK-DESC", out)

    def test_build_truncates_to_prompt_max_chars(self):
        out = build_system_prompt({"systemPrompt": "x" * 10000}, "BASE")
        self.assertLessEqual(len(out), PROMPT_MAX_CHARS)
        self.assertTrue(out.endswith(TRUNCATION_SUFFIX))

    def test_build_no_truncation_marker_when_under_cap(self):
        out = build_system_prompt({"systemPrompt": "short"}, "BASE")
        self.assertNotIn(TRUNCATION_SUFFIX, out)
        self.assertLessEqual(len(out), PROMPT_MAX_CHARS)

    def test_build_truncates_the_base_too_when_it_is_huge(self):
        out = build_system_prompt({"systemPrompt": "tail"}, "b" * 10000)
        self.assertLessEqual(len(out), PROMPT_MAX_CHARS)
        self.assertTrue(out.endswith(TRUNCATION_SUFFIX))

    def test_prompt_max_chars_constant(self):
        self.assertEqual(PROMPT_MAX_CHARS, 4000)

    def test_build_does_not_mutate_agent(self):
        agent = {"id": "a", "name": "A", "systemPrompt": "Be terse."}
        build_system_prompt(agent, "BASE")
        self.assertEqual(agent, {"id": "a", "name": "A", "systemPrompt": "Be terse."})

    # --- task_tool_schema ---------------------------------------------------

    def test_task_tool_schema_shape(self):
        schema = task_tool_schema()
        self.assertEqual(schema["type"], "function")
        fn = schema["function"]
        self.assertEqual(fn["name"], TASK_TOOL_NAME)
        self.assertEqual(TASK_TOOL_NAME, "task")
        self.assertIsInstance(fn["description"], str)
        self.assertTrue(fn["description"].strip())

        params = fn["parameters"]
        self.assertEqual(params["type"], "object")
        self.assertEqual(set(params["properties"]), {"prompt", "agent"})
        self.assertEqual(params["properties"]["prompt"], {"type": "string"})
        self.assertEqual(params["properties"]["agent"], {"type": "string"})
        self.assertEqual(params["required"], ["prompt"])
        self.assertIs(params["additionalProperties"], False)

    def test_task_tool_schema_is_fresh_each_call(self):
        first = task_tool_schema()
        first["function"]["parameters"]["required"].append("agent")
        self.assertEqual(task_tool_schema()["function"]["parameters"]["required"], ["prompt"])

    def test_task_tool_schema_is_json_serialisable(self):
        json.dumps(task_tool_schema())


if __name__ == "__main__":
    unittest.main()
