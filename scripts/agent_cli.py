#!/usr/bin/env python3
"""Headless Agent CLI & Programmatic Test Harness.

Executes and verifies Pokémon TCG Agent executions over HTTP/SSE with zero browser dependency.
Supports direct JWT tokens, browser session cookies, credentials with TOTP MFA,
and automated multi-turn decision handling.
"""
import argparse
import asyncio
import json
import os
import sys
from typing import AsyncGenerator
import httpx


async def stream_sse(
    client: httpx.AsyncClient,
    url: str,
    payload: dict,
    headers: dict,
) -> AsyncGenerator[tuple[str, dict], None]:
    """Stream Server-Sent Events from an orchestrator endpoint."""
    async with client.stream("POST", url, json=payload, headers=headers, timeout=120) as resp:
        if resp.status_code != 200:
            content = await resp.aread()
            raise RuntimeError(f"HTTP {resp.status_code}: {content.decode('utf-8', errors='replace')}")
        current_event = None
        current_data: list[str] = []
        async for line in resp.aiter_lines():
            line = line.strip()
            if not line:
                if current_event and current_data:
                    raw_json = "\n".join(current_data)
                    try:
                        parsed = json.loads(raw_json)
                        yield current_event, parsed
                    except Exception:
                        pass
                current_event = None
                current_data = []
                continue
            if line.startswith("event: "):
                current_event = line[len("event: "):].strip()
            elif line.startswith("data: "):
                current_data.append(line[len("data: "):])


def auth_endpoint(base_url: str, auth_url: str, path: str) -> str:
    """Resolve an auth URL path for direct service or API gateway."""
    target_base = auth_url.strip() if auth_url else ""
    if not target_base:
        if "api.chat." in base_url:
            target_base = base_url.replace("api.chat.", "api.auth.")
        else:
            target_base = base_url.rstrip("/")

    target_base = target_base.rstrip("/")
    if not path.startswith("/"):
        path = "/" + path

    is_direct = bool(auth_url) or ("api.chat." in base_url)
    if is_direct:
        if path.startswith("/api/auth/"):
            path = path[len("/api/auth"):]
        return f"{target_base}{path}"
    else:
        if not path.startswith("/api/auth/"):
            path = f"/api/auth{path}"
        return f"{target_base}{path}"


def chat_endpoint(base_url: str, path: str) -> str:
    """Resolve a chat/orchestrator URL path for direct service or API gateway."""
    base = base_url.rstrip("/")
    if not path.startswith("/"):
        path = "/" + path

    if "api.chat." in base:
        if path.startswith("/api/chat/"):
            path = path[len("/api/chat"):]
        return f"{base}{path}"
    else:
        if not path.startswith("/api/chat/"):
            path = f"/api/chat{path}"
        return f"{base}{path}"


async def resolve_auth_token(client: httpx.AsyncClient, base_url: str, args: argparse.Namespace) -> str:
    """Resolve an authenticated Bearer token via CLI args, env, cookies, or credentials."""
    auth_url_arg = getattr(args, "auth_url", "")
    token = args.token or os.getenv("TCG_BEARER_TOKEN", "")
    if not token and args.token_file:
        try:
            with open(args.token_file, "r") as f:
                token = f.read().strip()
        except Exception as e:
            print(f"[auth] Failed reading token file {args.token_file}: {e}", file=sys.stderr)

    if token:
        if args.refresh:
            resp = await client.get(
                auth_endpoint(base_url, auth_url_arg, "/portal-session"),
                headers={"Authorization": f"Bearer {token}"},
            )
            if resp.status_code == 200:
                data = resp.json()
                fresh = data.get("access_token")
                if fresh:
                    token = fresh
                    print(f"[auth] Successfully refreshed Bearer token via sliding session.")
        return token

    cookie = args.cookie or os.getenv("TCG_PORTAL_COOKIE", "")
    if cookie:
        cookie_header = f"__Host-tcg_portal={cookie}; tcg_portal_local={cookie}"
        resp = await client.get(
            auth_endpoint(base_url, auth_url_arg, "/portal-session"),
            headers={"Cookie": cookie_header},
        )
        if resp.status_code == 200:
            data = resp.json()
            tok = data.get("access_token")
            if tok:
                print(f"[auth] Successfully exchanged portal cookie for Bearer token.")
                return tok
        raise RuntimeError(f"Failed exchanging cookie for portal session: HTTP {resp.status_code}")

    username = args.username or os.getenv("TCG_USERNAME", "")
    password = args.password or os.getenv("TCG_PASSWORD", "")
    if username and password:
        resp = await client.post(
            auth_endpoint(base_url, auth_url_arg, "/token"),
            data={"username": username, "password": password},
        )
        if resp.status_code != 200:
            raise RuntimeError(f"Login failed: HTTP {resp.status_code} {resp.text}")
        data = resp.json()
        if "access_token" in data:
            return data["access_token"]
        if data.get("challenge_token") and (args.totp_code or args.totp_secret):
            code = args.totp_code
            if not code and args.totp_secret:
                try:
                    import pyotp
                    code = pyotp.TOTP(args.totp_secret).now()
                except ImportError:
                    raise RuntimeError("pyotp is required for --totp-secret. Install pyotp or pass --totp-code.")
            verify_resp = await client.post(
                auth_endpoint(base_url, auth_url_arg, "/totp/challenge"),
                json={"challenge_token": data["challenge_token"], "code": code},
            )
            if verify_resp.status_code == 200:
                return verify_resp.json()["access_token"]
            raise RuntimeError(f"TOTP verification failed: HTTP {verify_resp.status_code}")
        raise RuntimeError(f"Unexpected login response (MFA challenge required): {data}")

    raise RuntimeError("No authentication provided. Use --token, --cookie, or --username/--password.")


def match_clarification_choice(options: list[str], auto_clarify: str) -> str:
    """Find the best option matching the auto-clarify rule."""
    if not options:
        return auto_clarify
    if auto_clarify.lower() == "first":
        return options[0]
    try:
        idx = int(auto_clarify)
        if 0 <= idx < len(options):
            return options[idx]
    except ValueError:
        pass
    for opt in options:
        if auto_clarify.lower() in opt.lower():
            return opt
    return auto_clarify


async def main_async(args: argparse.Namespace) -> int:
    base_url = args.base_url.rstrip("/")
    async with httpx.AsyncClient(timeout=120) as client:
        try:
            token = await resolve_auth_token(client, base_url, args)
        except Exception as e:
            print(f"[error] Authentication failed: {e}", file=sys.stderr)
            return 1

        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        }

        # Step 1: Start execution
        execution_id = ""
        conversation_id = ""
        final_result = None
        turn = 1

        print(f"[run] Starting execution turn {turn}: '{args.prompt}' (model: {args.model})")
        start_payload = {"text": args.prompt, "model_id": args.model}

        async def execute_turn(url: str, payload: dict):
            nonlocal execution_id, conversation_id, final_result
            async for ev_type, ev_data in stream_sse(client, url, payload, headers):
                if args.jsonl:
                    print(json.dumps({"event": ev_type, "data": ev_data}))
                    continue

                if ev_type == "execution":
                    execution_id = ev_data.get("id", "")
                    conversation_id = ev_data.get("conversation_id", "")
                    print(f"[{ev_type}] ID={execution_id} Conversation={conversation_id}")
                elif ev_type == "progress":
                    print(f"[{ev_type}] {ev_data.get('step')}: {ev_data.get('message')}")
                elif ev_type == "thinking":
                    if ev_data.get("status") == "complete":
                        summary = ev_data.get("summary", "").replace("\n", " ").strip()
                        print(f"[{ev_type}] {ev_data.get('source')}: {summary[:120]}...")
                elif ev_type == "tool":
                    status = ev_data.get("status")
                    if status != "loading":
                        dur = f" ({ev_data.get('duration_ms')}ms)" if ev_data.get("duration_ms") else ""
                        sources = len(ev_data.get("sources", []))
                        print(f"[{ev_type}] {ev_data.get('name')}: {status}{dur} · {sources} sources")
                elif ev_type == "cards":
                    cards_list = ev_data.get("cards", [])
                    total_qty = sum(c.get("quantity", 1) for c in cards_list)
                    print(f"[{ev_type}] Resolved {len(cards_list)} printings ({total_qty} total cards).")
                elif ev_type == "question":
                    kind = ev_data.get("kind")
                    q_text = ev_data.get("question")
                    print(f"[{ev_type}] {kind}: {q_text}")
                    return ev_data
                elif ev_type == "result":
                    final_result = ev_data
                    offers_count = len(ev_data.get("offers", []))
                    cards_count = len(ev_data.get("plan", {}).get("cards", []))
                    print(f"[{ev_type}] Result received! {cards_count} plan cards, {offers_count} supplier offers.")
                elif ev_type == "error":
                    print(f"[{ev_type}] {ev_data.get('message')}", file=sys.stderr)
                elif ev_type == "done":
                    print(f"[{ev_type}] Status: {ev_data.get('status')}")

            return None

        question = await execute_turn(chat_endpoint(base_url, "/executions"), start_payload)

        # Multi-turn decision loop
        while question and not final_result:
            turn += 1
            kind = question.get("kind")
            if kind == "clarification":
                if not args.auto_clarify:
                    print(f"[pause] Paused at clarification question: {question.get('question')}")
                    print(f"Options: {question.get('options')}")
                    print("Provide --auto-clarify <choice> to automate multi-turn execution.")
                    return 2
                options = question.get("options", [])
                choice = match_clarification_choice(options, args.auto_clarify)
                print(f"[resume] Turn {turn} (Clarification): answering '{choice}'")
                decision_payload = {
                    "action": "clarify",
                    "text": choice,
                    "selected_option": choice,
                    "approved": True,
                }
            elif kind == "missing_cards":
                if not args.auto_missing:
                    print(f"[pause] Paused at missing cards: {question.get('missing')}")
                    print("Provide --auto-missing <keep_missing|substitute|cancel> to automate.")
                    return 2
                act = args.auto_missing.lower()
                print(f"[resume] Turn {turn} (Missing cards): executing action '{act}'")
                decision_payload = {
                    "action": act,
                    "approved": act != "cancel",
                    "text": "Approved" if act == "keep_missing" else act,
                }
            else:
                print(f"[error] Unknown question kind '{kind}'", file=sys.stderr)
                return 1

            question = await execute_turn(
                chat_endpoint(base_url, f"/executions/{execution_id}/resume"),
                decision_payload,
            )

        # Assertions
        if not final_result:
            print("[failure] Execution ended without final result.", file=sys.stderr)
            return 1

        if args.assert_cards:
            cards = final_result.get("plan", {}).get("cards", [])
            total_qty = sum(c.get("quantity", 1) for c in cards)
            if total_qty < args.assert_cards and len(cards) < args.assert_cards:
                print(
                    f"[assertion error] Total cards ({total_qty}) or unique ({len(cards)}) < asserted {args.assert_cards}",
                    file=sys.stderr,
                )
                return 3
            print(f"[assertion ok] Card count ({total_qty}) >= {args.assert_cards}")

        if args.assert_offers:
            offers = final_result.get("offers", [])
            if not offers:
                print(f"[assertion error] Expected offers > 0, got 0 offers.", file=sys.stderr)
                return 4
            print(f"[assertion ok] Offers retrieved: {len(offers)} offers.")

        print("[success] Execution completed and all assertions passed!")
        return 0


def main():
    parser = argparse.ArgumentParser(description="Pokémon TCG Agent Headless CLI")
    parser.add_argument("--prompt", default="Help me build a M Lucario ex deck for standard format", help="User prompt")
    parser.add_argument("--model", default="gpt-6-luna", help="Model registry ID")
    parser.add_argument("--base-url", default=os.getenv("TCG_BASE_URL", "http://localhost:8080"), help="Base URL")
    parser.add_argument("--auth-url", default=os.getenv("TCG_AUTH_URL", ""), help="Auth service base URL (if separate from gateway/chat)")
    parser.add_argument("--token", help="Bearer JWT token")
    parser.add_argument("--token-file", help="File with Bearer token")
    parser.add_argument("--cookie", help="Browser session cookie value")
    parser.add_argument("--username", help="Username")
    parser.add_argument("--password", help="Password")
    parser.add_argument("--totp-code", help="6-digit TOTP code")
    parser.add_argument("--totp-secret", help="TOTP secret for auto-generation")
    parser.add_argument("--refresh", action="store_true", help="Test sliding session refresh")
    parser.add_argument("--auto-clarify", help="Auto-answer clarification (first, index, or match text)")
    parser.add_argument("--auto-missing", default="keep_missing", help="Auto-decision for missing cards")
    parser.add_argument("--assert-cards", type=int, help="Assert minimum total cards")
    parser.add_argument("--assert-offers", action="store_true", help="Assert supplier offers > 0")
    parser.add_argument("--jsonl", action="store_true", help="Output raw JSONL")

    args = parser.parse_args()
    code = asyncio.run(main_async(args))
    sys.exit(code)


if __name__ == "__main__":
    main()
