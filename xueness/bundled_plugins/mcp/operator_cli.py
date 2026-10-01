"""Operator CLI commands owned by the MCP plugin."""
import argparse
import json
import sys
from pathlib import Path


def add_parsers(commands):
    check = commands.add_parser(
        "mcp-check", help="explicitly connect to an enabled MCP server and list tools")
    check.add_argument("id")
    check.add_argument("--root", type=Path, default=Path.cwd())


def execute_cli(args, deps=None):
    from .diagnostics import check_mcp
    try:
        result = check_mcp(args.state, args.id, args.root)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (OSError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
