"""No-echo local model setup wizard."""
import getpass
import os
import sys

from ... import providers_api


def dispatch(method, parts, query, data, ctx):
    from .desktop_setup import dispatch as dispatch_setup
    return dispatch_setup(method, parts, data, ctx)


def register_cli(commands):
    wizard = commands.add_parser('onboarding', help='configure the first local model profile')
    wizard.add_argument('--id', default=None)
    wizard.add_argument('--name', default=None)
    wizard.add_argument('--protocol', choices=('openai', 'anthropic'), default=None)
    wizard.add_argument('--base-url', default=None)
    wizard.add_argument('--model', default=None)
    wizard.add_argument('--capabilities', default=None,
                        help='optional comma-separated image,pdf,video input capabilities')
    wizard.add_argument('--api-key-env', default=None,
                        help='read the key from this environment variable instead of a hidden prompt')


def _value(provided, prompt, default=None):
    if provided is not None:
        return provided.strip()
    label = f'{prompt} [{default}]: ' if default else f'{prompt}: '
    value = input(label).strip()
    return value or (default or '')


def execute_cli(args):
    language = getattr(args, 'language', 'zh')
    en = language == 'en'
    try:
        if not sys.stdin.isatty() and not args.api_key_env:
            raise ValueError('a hidden key prompt needs a terminal; use --api-key-env for noninteractive setup')
        if not sys.stdin.isatty() and any(getattr(args, name) is None for name in
                                         ('id', 'name', 'protocol', 'base_url', 'model')):
            raise ValueError('interactive configuration needs a terminal; supply all profile flags')
        profile_id = _value(args.id, 'Profile id' if en else '配置 ID', 'default')
        existing = next((item for item in providers_api._list({'state_dir': args.state})
                         if item.get('id') == profile_id), {})
        protocol = _value(args.protocol, 'Protocol (openai/anthropic)' if en else '协议 (openai/anthropic)',
                          existing.get('protocol', 'openai'))
        default_url = existing.get('baseUrl') or (
            'https://api.anthropic.com/v1' if protocol == 'anthropic' else 'https://api.openai.com/v1')
        data = {
            'id': profile_id,
            'name': _value(args.name, 'Display name' if en else '显示名称',
                           existing.get('name', 'Default provider')),
            'protocol': protocol,
            'baseUrl': _value(args.base_url, 'API base URL' if en else 'API 地址', default_url),
            'model': _value(args.model, 'Model name' if en else '模型名称', existing.get('model')),
        }
        if args.capabilities is not None:
            data['capabilities'] = [item.strip() for item in args.capabilities.split(',') if item.strip()]
        key = os.environ.get(args.api_key_env, '') if args.api_key_env else ''
        if args.api_key_env and not key:
            raise ValueError('the selected API key environment variable is empty')
        if not key:
            prompt = 'API key (input hidden; Enter keeps an existing key): ' if en else 'API 密钥（输入不回显；回车保留现有密钥）：'
            key = getpass.getpass(prompt)
        if key:
            data['apiKey'] = key
        elif args.api_key_env:
            raise ValueError('API key is required')
        status, result = providers_api.dispatch('POST', ['api', 'providers'], {}, data,
                                                 {'state_dir': args.state})
        if status >= 400:
            raise ValueError(result.get('error', 'provider profile could not be saved'))
        print(('模型配置已保存；密钥不会显示。' if not en else
               'Provider profile saved; the key is never displayed.'), file=sys.stderr)
        import json
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (OSError, ValueError, EOFError, KeyboardInterrupt) as exc:
        message = str(exc) or ('设置已取消' if not en else 'Setup cancelled')
        print(f"ERROR: {message}", file=sys.stderr)
        return 1
