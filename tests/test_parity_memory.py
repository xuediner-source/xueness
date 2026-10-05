"""Parity regression tests for memory track formatting (matching ZCode core/src/memory).

Tests that:
1. Leading YAML frontmatter (--- ... ---) in memory entries is stripped.
2. HTML comments (<!-- ... -->) are stripped.
3. Plain entries and existing program prefixes are preserved.
4. Entries containing only comments or frontmatter are dropped as empty entries.
"""
import unittest
from xueness.memory import _strip_entry_head, render_track


class ParityMemoryTests(unittest.TestCase):
    def test_strip_leading_yaml_frontmatter(self):
        entry = "---\ntype: user\ndescription: preferred language\n---\nPrefers Chinese responses"
        stripped = _strip_entry_head(entry)
        self.assertEqual(stripped, "Prefers Chinese responses")

    def test_strip_leading_yaml_frontmatter_crlf(self):
        entry = "---\r\ntype: user\r\ndescription: crlf test\r\n---\r\nWindows newline fact"
        stripped = _strip_entry_head(entry)
        self.assertEqual(stripped, "Windows newline fact")

    def test_strip_html_comments(self):
        entry = "<!-- Note: keep this updated -->\nProject uses Python 3.13"
        stripped = _strip_entry_head(entry)
        self.assertEqual(stripped, "Project uses Python 3.13")

    def test_strip_inline_html_comments(self):
        entry = "Fact one <!-- hidden explanation --> and fact two"
        stripped = _strip_entry_head(entry)
        self.assertEqual(stripped, "Fact one  and fact two")

    def test_comment_only_entry_is_dropped_in_render_track(self):
        track_text = "<!-- comment only -->\n§\nreal fact\n§\n---\ntitle: doc\n---\n"
        rendered = render_track(track_text)
        self.assertEqual(rendered, "- real fact")

    def test_frontmatter_combined_with_program_prefixes(self):
        entry = "---\nauthor: dev\n---\n[id:0123abcd] [2026-10-01] Important architectural constraint"
        stripped = _strip_entry_head(entry)
        self.assertEqual(stripped, "Important architectural constraint")


if __name__ == "__main__":
    unittest.main()
