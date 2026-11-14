"""Launch the standalone Docker API-token tester without provisioning app services."""
import argparse
import re
import subprocess
import sys
import time
from pathlib import Path
from urllib.error import URLError
from urllib.parse import urlsplit
from urllib.request import build_opener, ProxyHandler

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_NAME = 'tcg-api-tester'
DEFAULT_IMAGE = 'tcg-api-tester:local'
AUTH_URL = 'https://api.auth.tcg-marketplace.02labs.me'
CHAT_URL = 'https://api.chat.tcg-marketplace.02labs.me'
WRITE_TOKEN = "const fs=require('node:fs');let token='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>token+=chunk);process.stdin.on('end',()=>fs.writeFileSync('/run/api-tester/token',token,{mode:0o600,flag:'wx'}));"


def api_url(raw):
    try:
        value = urlsplit(raw)
        if value.scheme not in {'http', 'https'} or not value.hostname or value.username or value.password or value.query or value.fragment:
            raise ValueError
        value.port
    except ValueError:
        raise argparse.ArgumentTypeError('Use an HTTP(S) API base URL without credentials, query or fragment.') from None
    return raw.rstrip('/')


def resource_name(raw):
    if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]*', raw):
        raise argparse.ArgumentTypeError('Use a Docker container name containing letters, numbers, dots, underscores or hyphens.')
    return raw


def port_number(raw):
    number = int(raw)
    if not 1 <= number <= 65535:
        raise argparse.ArgumentTypeError('Port must be between 1 and 65535.')
    return number


def docker(*args, **kwargs):
    return subprocess.run(['docker', *args], check=True, **kwargs)


def launch(args):
    token = sys.stdin.readline().rstrip('\r\n') if args.token_stdin else args.token
    if not token or len(token) > 8192 or any(not 33 <= ord(char) <= 126 for char in token):
        raise ValueError('Provide a nonempty API token with printable ASCII characters and no whitespace.')
    docker('info', stdout=subprocess.DEVNULL)
    existing = docker('container', 'ls', '-aq', '--filter', f'name=^/{args.name}$', capture_output=True, text=True)
    if existing.stdout.strip():
        raise ValueError(f'Container {args.name} already exists. Stop it or choose another --name.')
    if not args.no_build:
        build = ['build', '-f', str(ROOT / 'deploy/api-tester.Dockerfile'), '-t', args.image]
        if args.build_network:
            build += ['--network', args.build_network]
        docker(*build, str(ROOT))
    origin = f'http://127.0.0.1:{args.port}'
    command = ['create', '--name', args.name, '--label', 'me.02labs.tcg.api-tester=true',
               '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true',
               '--tmpfs', '/run/api-tester:rw,noexec,nosuid,size=64k,mode=0700,uid=1000,gid=1000',
               '-p', f'127.0.0.1:{args.port}:8080',
               '-e', f'AUTH_URL={args.auth_url}', '-e', f'CHAT_URL={args.chat_url}', '-e', f'PUBLIC_ORIGIN={origin}']
    if args.network:
        command += ['--network', args.network]
    command.append(args.image)
    container_id = ''
    try:
        container_id = docker(*command, capture_output=True, text=True).stdout.strip()
        docker('start', container_id, capture_output=True, text=True)
        # The credential travels over stdin, not Docker argv, environment or the build context.
        docker('exec', '-i', container_id, 'node', '-e', WRITE_TOKEN, input=token, text=True, capture_output=True)
        token = ''
        opener = build_opener(ProxyHandler({}))
        for _ in range(40):
            try:
                with opener.open(origin + '/health', timeout=1) as response:
                    if response.status == 200:
                        print(f'API tester ready: {origin}/api-test/')
                        print('The launch token connects once. Reload or disconnect requires entering a token again.')
                        print(f'Stop: python -m scripts.api_tester down --name {args.name}')
                        return
            except (URLError, TimeoutError, ConnectionError):
                pass
            time.sleep(0.25)
        raise ValueError('API tester did not become healthy.')
    except BaseException:
        if container_id:
            subprocess.run(['docker', 'rm', '-f', container_id], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        raise


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    up = sub.add_parser('up', help='Build and start a local API tester.')
    secret = up.add_mutually_exclusive_group(required=True)
    secret.add_argument('--token', help='Existing API-principal token; prefer a shell variable to a literal.')
    secret.add_argument('--token-stdin', action='store_true', help='Read the token from stdin instead of command arguments.')
    up.add_argument('--name', type=resource_name, default=DEFAULT_NAME)
    up.add_argument('--image', default=DEFAULT_IMAGE)
    up.add_argument('--port', type=port_number, default=8090)
    up.add_argument('--auth-url', type=api_url, default=AUTH_URL, help='Auth service base URL, optionally including /api/auth for a gateway.')
    up.add_argument('--chat-url', type=api_url, default=CHAT_URL, help='Chat service base URL, optionally including /api/chat for a gateway.')
    up.add_argument('--network', help='Existing Docker network for local API services.')
    up.add_argument('--build-network', help='Docker build network, if required by this host.')
    up.add_argument('--no-build', action='store_true', help='Use the existing image.')
    down = sub.add_parser('down', help='Remove only the named API tester container.')
    down.add_argument('--name', type=resource_name, default=DEFAULT_NAME)
    args = parser.parse_args(argv)
    try:
        if args.command == 'up':
            launch(args)
        else:
            label = docker('inspect', '--format', '{{index .Config.Labels "me.02labs.tcg.api-tester"}}', args.name, capture_output=True, text=True)
            if label.stdout.strip() != 'true':
                raise ValueError('Refusing to remove a container not created by the API tester launcher.')
            docker('rm', '-f', args.name)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        # Never echo subprocess arguments, stdin, environment or backend response bodies.
        print(f'API tester: {error if isinstance(error, ValueError) else "Docker operation failed; check Docker availability and container state."}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
