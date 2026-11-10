import asyncio
from html.parser import HTMLParser
import ipaddress
import json
import os
import re
import socket
from typing import Any
from urllib.parse import quote, urlparse
import httpx
from ddgs import DDGS
from ddgs.exceptions import DDGSException
from langchain_core.tools import tool

from shared.contracts import Source, utcnow
from shared.repository import Repository
from shared.url_security import public_https
from services.orchestrator.legality_sync import (
    POKEMON_CARD_JP_URL,
    should_refresh_legality,
    sync_legality,
)

TCGDEX_GQL_URL = "https://api.tcgdex.net/v2/graphql"
LIMITLESS_DECKS_URL = "https://limitlesstcg.com/decks"

SET_CODE_MAP = {
    "POR": "me03", "PFO": "me03", "PFL": "me02", "MEE": "mee", "MEP": "mep",
    "SVE": "sve", "SVP": "svp", "PR-SV": "svp", "WHT": "sv10.5w", "BLK": "sv10.5b",
    "MEG": "me01", "ASC": "me02.5", "CRI": "me04", "PBL": "me05", "DLR": "me06",
    "SVI": "sv01", "PAL": "sv02", "OBF": "sv03", "MEW": "sv03.5", "PAR": "sv04", "PAF": "sv04.5",
    "TEF": "sv05", "TWM": "sv06", "SFA": "sv06.5", "SCR": "sv07", "SSP": "sv08", "PRE": "sv08.5",
    "JTG": "sv09", "DRI": "sv10",
    "FFI": "xy3", "PHF": "xy4", "PRC": "xy5", "ROS": "xy6", "AOR": "xy7", "BKT": "xy8", "BKP": "xy9", "FCO": "xy10", "STS": "xy11", "EVO": "xy12",
}


class TextParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts, self.hidden = [], 0

    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style", "noscript"}:
            self.hidden += 1

    def handle_endtag(self, tag):
        if tag in {"script", "style", "noscript"}:
            self.hidden = max(0, self.hidden - 1)

    def handle_data(self, data):
        if not self.hidden and data.strip():
            self.parts.append(data.strip())


def _iter_exceptions(exc: BaseException, seen: set[int] | None = None):
    if seen is None:
        seen = set()
    if id(exc) in seen:
        return
    seen.add(id(exc))
    yield exc
    if isinstance(exc, BaseExceptionGroup):
        for sub in exc.exceptions:
            yield from _iter_exceptions(sub, seen)
    if exc.__cause__ is not None:
        yield from _iter_exceptions(exc.__cause__, seen)
    if exc.__context__ is not None:
        yield from _iter_exceptions(exc.__context__, seen)


class Research:
    def __init__(
        self,
        repository: Repository | None = None,
        mcp_url: str | None = None,
        mcp_auth_token: str | None = None,
    ):
        self.repository = repository
        self.mcp_url = (mcp_url if mcp_url is not None else os.getenv("DDG_MCP_URL", "")).strip()
        self.mcp_auth_token = (mcp_auth_token if mcp_auth_token is not None else os.getenv("MCP_AUTH_TOKEN", "")).strip()
        self.sources: dict[str, Source] = {}
        self.cards: dict[str, dict] = {}
        self.network_calls = 0

    def network_budget(self):
        self.network_calls += 1
        if self.network_calls > 120:
            raise ValueError("Research network-call limit reached.")

    async def _call_ddg_mcp_tool(self, tool_name: str, arguments: dict) -> str:
        from mcp.client import Client
        import services.ddg_mcp.main as ddg_main

        if self.mcp_url:
            try:
                from mcp.client.streamable_http import streamable_http_client
                from mcp.shared._httpx_utils import create_mcp_http_client

                headers = {"Authorization": f"Bearer {self.mcp_auth_token}"} if self.mcp_auth_token else None
                async with create_mcp_http_client(headers=headers) as http_client:
                    transport = streamable_http_client(self.mcp_url, http_client=http_client)
                    async with Client(transport) as client:
                        res = await client.call_tool(tool_name, arguments)
                        if getattr(res, "is_error", False) or getattr(res, "isError", False):
                            raise RuntimeError("\n".join(getattr(c, "text", "") for c in res.content))
                        return "\n".join(getattr(c, "text", "") for c in res.content if getattr(c, "text", None))
            except BaseException as exc:
                for item in _iter_exceptions(exc):
                    if isinstance(item, httpx.HTTPStatusError):
                        raise RuntimeError(f"ddg_mcp request failed with HTTP {item.response.status_code}") from exc
                for item in _iter_exceptions(exc):
                    if isinstance(item, RuntimeError) and not any(
                        isinstance(sub, (httpx.ConnectError, httpx.ConnectTimeout))
                        for sub in _iter_exceptions(item)
                    ):
                        raise item
                is_local_connect_error = any(
                    isinstance(item, (httpx.ConnectError, httpx.ConnectTimeout))
                    for item in _iter_exceptions(exc)
                )
                if not is_local_connect_error or os.getenv("DYNO"):
                    raise RuntimeError(f"ddg_mcp request failed: {exc}") from exc
                # On local transport/connection errors in dev/test mode when ddg-mcp container is not running, fall through to in-process MCP server

        async with Client(ddg_main.ddg_server.mcp) as client:
            res = await client.call_tool(tool_name, arguments)
            if getattr(res, "is_error", False) or getattr(res, "isError", False):
                raise RuntimeError("\n".join(getattr(c, "text", "") for c in res.content))
            return "\n".join(getattr(c, "text", "") for c in res.content if getattr(c, "text", None))

    async def search(self, query: str) -> list[dict]:
        self.network_budget()
        raw = await self._call_ddg_mcp_tool("search", {"query": query[:500], "max_results": 8})
        results = []
        matches = re.finditer(
            r"^\d+\.\s+(.+?)\n\s*URL:\s*(\S+)[^\n]*\n\s*Summary:\s*(.*?)(?=\n\s*\n|\n\d+\.\s|\Z)",
            raw,
            re.MULTILINE | re.DOTALL,
        )
        for m in matches:
            title, url, snippet = m.group(1).strip(), m.group(2).strip(), m.group(3).strip()
            if url.startswith("ref://"):
                try:
                    url = await self._call_ddg_mcp_tool("expand_link", {"token": url})
                except Exception:
                    pass
            if not url.startswith("https://"):
                continue
            try:
                source = Source(url=url, title=title, excerpt=snippet[:1500])
                self.sources[str(source.url)] = source
                results.append(source.model_dump(mode="json"))
            except Exception:
                continue
        return results

    async def fetch(self, url: str) -> dict:
        self.network_budget()
        await asyncio.to_thread(public_https, url)
        text = await self._call_ddg_mcp_tool("fetch_content", {"url": url, "max_length": 20000, "backend": "auto", "parse_mode": "markdown"})
        text = re.sub(r"\n\n---\n\[Content info:.*?\]$", "", text, flags=re.DOTALL).strip()
        if text.startswith("Error:") or any(marker in text.casefold() for marker in ("verify you are human", "just a moment...", "checking your browser")):
            raise ValueError(text)
        first_line = text.split("\n", 1)[0].strip() if text else url
        source = Source(url=url, title=first_line[:200] or url, excerpt=text[:20000])
        self.sources[str(source.url)] = source
        return source.model_dump(mode="json")

    def _extract_and_cache_cards(self, node: Any) -> list[dict]:
        """Recursively inspect GraphQL node and cache cards containing id and name."""
        cached = []
        if isinstance(node, dict):
            if "id" in node and "name" in node and isinstance(node["id"], str):
                self.cards[node["id"]] = node
                cached.append(node)
            for v in node.values():
                cached.extend(self._extract_and_cache_cards(v))
        elif isinstance(node, list):
            for item in node:
                cached.extend(self._extract_and_cache_cards(item))
        return cached

    async def query_tcgdex_graphql(
        self,
        query: str = "",
        variables: dict | None = None,
        *,
        name: str = "",
        set_id: str = "",
        local_id: str = "",
        regulation_mark: str = "",
        category: str = "",
        stage: str = "",
        trainer_type: str = "",
        energy_type: str = "",
        rarity: str = "",
        language: str = "en",
        limit: int = 20,
    ) -> dict:
        """Execute a direct GraphQL query or structured filter search against TCGdex GraphQL endpoint."""
        q = (query or "").strip()
        lang = "ja" if language.lower() in {"ja", "japan", "japanese"} else "en"
        if not q:
            filter_parts = []
            if name:
                filter_parts.append(f"name: {json.dumps(name)}")
            if local_id:
                filter_parts.append(f"localId: {json.dumps(local_id)}")
            if regulation_mark:
                filter_parts.append(f"regulationMark: {json.dumps(regulation_mark)}")
            if category:
                filter_parts.append(f"category: {json.dumps(category)}")
            if stage:
                filter_parts.append(f"stage: {json.dumps(stage)}")
            if trainer_type:
                filter_parts.append(f"trainerType: {json.dumps(trainer_type)}")
            if energy_type:
                filter_parts.append(f"energyType: {json.dumps(energy_type)}")
            if rarity:
                filter_parts.append(f"rarity: {json.dumps(rarity)}")

            filters_str = f"filters: {{ {', '.join(filter_parts)} }}, " if filter_parts else ""
            items_limit = max(1, min(limit or 20, 100))

            q = f"""query SearchCards {{
  cards({filters_str}pagination: {{ page: 1, itemsPerPage: {items_limit} }}) @locale(lang: "{lang}") {{
    id
    localId
    name
    image
    category
    hp
    stage
    trainerType
    energyType
    regulationMark
    rarity
    legal {{
      standard
      expanded
    }}
    set {{
      id
      name
      releaseDate
      tcgOnline
    }}
  }}
}}"""

        self.network_budget()
        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.post(TCGDEX_GQL_URL, json={"query": q, "variables": variables or {}})
            resp.raise_for_status()
            data = resp.json()

        # Cache every card containing 'id' and 'name'
        self._extract_and_cache_cards(data.get("data"))

        # Client-side filtering by set_id if specified
        if set_id and isinstance(data.get("data"), dict) and isinstance(data["data"].get("cards"), list):
            target_set = set_id.strip().lower()
            filtered_cards = [
                c for c in data["data"]["cards"]
                if (c.get("set") or {}).get("id", "").lower() == target_set
                or (c.get("set") or {}).get("tcgOnline", "").lower() == target_set
            ]
            data["data"]["cards"] = filtered_cards

        source = Source(
            url=TCGDEX_GQL_URL,
            title="TCGdex GraphQL API",
            excerpt=str(data)[:2000],
        )
        self.sources[TCGDEX_GQL_URL] = source
        return data

    async def search_cards(self, name: str, language: str = "en") -> list[dict]:
        """Search cards via TCGdex GraphQL API, returning full metadata in 1 request."""
        lang = "ja" if language.lower() in {"ja", "japan", "japanese"} else "en"
        query = """
        query SearchCards($name: String, $itemsPerPage: Int) {
          cards(filters: { name: $name }, pagination: { page: 1, itemsPerPage: $itemsPerPage }) @locale(lang: """ + f'"{lang}"' + """) {
            id
            localId
            name
            image
            category
            hp
            stage
            trainerType
            energyType
            regulationMark
            rarity
            legal {
              standard
              expanded
            }
            set {
              id
              name
              releaseDate
              tcgOnline
            }
          }
        }
        """
        try:
            res = await self.query_tcgdex_graphql(query, {"name": name, "itemsPerPage": 15})
            cards = (res.get("data") or {}).get("cards") or []
            clean_cards = []
            for c in cards:
                cid = c.get("id")
                if cid:
                    self.cards[cid] = c
                clean_cards.append(c)
            return clean_cards
        except Exception:
            # Fallback to REST search if GraphQL endpoint had unexpected schema error
            self.network_budget()
            rest_url = f"https://api.tcgdex.net/v2/{lang}/cards"
            async with httpx.AsyncClient(timeout=20) as client:
                response = await client.get(rest_url, params={"name": name, "pagination:itemsPerPage": 15})
                response.raise_for_status()
                return response.json()[:15]

    async def card(self, card_id: str, language: str = "en", *, _from_batch: bool = False) -> dict:
        """Fetch full card details by ID, checking cache first."""
        if card_id in self.cards and not self.cards[card_id].get("unknown"):
            return self.cards[card_id]
        if not _from_batch:
            results = await self.get_cards([card_id], language=language)
            if results and results[0].get("id") == card_id and not results[0].get("unknown"):
                return results[0]
        # Direct REST fallback
        self.network_budget()
        lang = "ja" if language.lower() in {"ja", "japan", "japanese"} else "en"
        url = f"https://api.tcgdex.net/v2/{lang}/cards/{quote(card_id, safe='')}"
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.get(url)
            response.raise_for_status()
            data = response.json()
        result = {key: value for key, value in data.items() if key != "pricing"}
        self.cards[card_id] = result
        source = Source(url=url, title=f"TCGdex {data.get('name', card_id)}", excerpt=str(result)[:10000])
        self.sources[url] = source
        return result

    async def get_cards(self, card_ids: list[str], language: str = "en") -> list[dict]:
        """Fetch up to 60 cards in a single GraphQL request using field aliases."""
        if not card_ids:
            return []
        unique_ids = list(dict.fromkeys(card_ids[:60]))
        uncached = [cid for cid in unique_ids if cid not in self.cards]
        lang = "ja" if language.lower() in {"ja", "japan", "japanese"} else "en"

        if uncached:
            query_aliases = []
            for idx, cid in enumerate(uncached):
                # Try primary ID
                query_aliases.append(f'c{idx}: card(id: "{cid}") @locale(lang: "{lang}") {{ ...CardFields }}')
                # If ID has a localId with different padding (e.g. me01-77 vs me01-077), add alternative alias
                if "-" in cid:
                    prefix, num = cid.rsplit("-", 1)
                    if num.isdigit():
                        alt_num = num.zfill(3) if len(num) < 3 else num.lstrip("0")
                        alt_id = f"{prefix}-{alt_num}"
                        if alt_id != cid:
                            query_aliases.append(f'alt_{idx}: card(id: "{alt_id}") @locale(lang: "{lang}") {{ ...CardFields }}')

            full_query = f"""
            query BatchFetchCards {{
              {chr(10).join(query_aliases)}
            }}

            fragment CardFields on Card {{{{
              id
              localId
              name
              image
              category
              hp
              stage
              trainerType
              energyType
              regulationMark
              rarity
              legal {{{{
                standard
                expanded
              }}}}
              set {{{{
                id
                name
                releaseDate
                tcgOnline
              }}}}
            }}}}
            """
            try:
                res = await self.query_tcgdex_graphql(full_query)
                data = res.get("data") or {}
                for idx, cid in enumerate(uncached):
                    card_obj = data.get(f"c{idx}") or data.get(f"alt_{idx}")
                    if card_obj:
                        self.cards[cid] = card_obj
                        if card_obj.get("id"):
                            self.cards[card_obj["id"]] = card_obj
            except Exception:
                pass

            still_uncached = [cid for cid in uncached if cid not in self.cards]
            if still_uncached:
                gate = asyncio.Semaphore(6)
                async def fetch_one(c_id):
                    async with gate:
                        try:
                            try:
                                dt = await self.card(c_id, language=language, _from_batch=True)
                            except TypeError:
                                try:
                                    dt = await self.card(c_id, language=language)
                                except TypeError:
                                    dt = await self.card(c_id)
                            if dt and not dt.get("unknown"):
                                self.cards[c_id] = dt
                        except Exception:
                            pass
                await asyncio.gather(*(fetch_one(cid) for cid in still_uncached))

        return [self.cards.get(cid, {"id": cid, "name": cid, "unknown": True}) for cid in unique_ids]

    async def query_legality(
        self,
        ruleset: str = "international",
        format_: str = "standard",
        set_query: str | None = None,
        card_query: str | None = None,
    ) -> dict:
        """Query PostgreSQL legality catalog for sets, banned cards, and regulation marks."""
        if self.repository:
            return self.repository.query_legality_catalog(
                ruleset=ruleset,
                format_=format_,
                set_query=set_query,
                card_query=card_query,
            )
        # Fallback if no repository injected
        return {
            "sync_state": {"status": "unverified", "international_standard_marks": ["H", "I", "J"], "japan_standard_marks": ["H", "I", "J"]},
            "sets": [],
            "banned_cards": [],
        }

    async def search_deck_lists(self, query: str) -> list[dict]:
        """Search Limitless TCG for tournament deck archetypes and lists."""
        self.network_budget()
        url = f"{LIMITLESS_DECKS_URL}?q={quote(query)}"
        async with httpx.AsyncClient(timeout=20, headers={"User-Agent": "PokemonTCGPrivatePoC/0.1"}) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            text = resp.text

        source = Source(url=url, title=f"Limitless TCG search for '{query}'", excerpt=text[:2000])
        self.sources[url] = source

        matches = re.findall(r"<a[^>]*href=[\"\x27](/decks/\d+)[\"\x27][^>]*>(.*?)</a>", text, re.S)
        archetypes = []
        for href, inner in matches:
            clean_name = re.sub(r"<[^>]+>", "", inner).strip()
            if clean_name and "Decks" not in clean_name:
                archetypes.append({
                    "archetype_id": f"decks/{href.removeprefix('/decks/')}",
                    "name": clean_name,
                    "url": f"https://limitlesstcg.com{href}",
                })
        return archetypes[:10]

    async def get_deck_list(self, deck_id_or_list_id: str) -> dict:
        """Fetch tournament deck list from Limitless TCG and resolve cards via TCGdex GraphQL."""
        self.network_budget()
        raw_id = deck_id_or_list_id.strip()
        is_list = False
        if raw_id.startswith(("/decks/list/", "list/")):
            is_list = True
            list_id = raw_id.removeprefix("/decks/list/").removeprefix("list/").strip()
        elif raw_id.startswith(("/decks/", "decks/")):
            is_list = False
            arch_id = raw_id.removeprefix("/decks/").removeprefix("decks/").strip()
        elif raw_id.isdigit():
            val = int(raw_id)
            if val >= 2000:
                is_list = True
                list_id = raw_id
            else:
                is_list = False
                arch_id = raw_id
        else:
            is_list = True
            list_id = raw_id

        async with httpx.AsyncClient(timeout=20, headers={"User-Agent": "PokemonTCGPrivatePoC/0.1"}) as client:
            if not is_list:
                arch_url = f"https://limitlesstcg.com/decks/{arch_id}"
                resp = await client.get(arch_url)
                if resp.status_code == 200:
                    lists = re.findall(r"href=[\"\x27](/decks/list/\d+)[\"\x27]", resp.text)
                    if lists:
                        url = f"https://limitlesstcg.com{lists[0]}"
                        resp = await client.get(url)
                    else:
                        url = f"https://limitlesstcg.com/decks/list/{arch_id}"
                        resp = await client.get(url)
                else:
                    url = f"https://limitlesstcg.com/decks/list/{arch_id}"
                    resp = await client.get(url)
            else:
                url = f"https://limitlesstcg.com/decks/list/{list_id}"
                resp = await client.get(url)
                if resp.status_code == 404:
                    arch_url = f"https://limitlesstcg.com/decks/{list_id}"
                    resp = await client.get(arch_url)
                    if resp.status_code == 200:
                        lists = re.findall(r"href=[\"\x27](/decks/list/\d+)[\"\x27]", resp.text)
                        if lists:
                            url = f"https://limitlesstcg.com{lists[0]}"
                            resp = await client.get(url)
            resp.raise_for_status()
            text = resp.text

        source = Source(url=url, title=f"Limitless TCG deck list {url}", excerpt=text[:4000])
        self.sources[url] = source

        # Parse cards
        items = re.findall(
            r"<div class=[\"\x27]decklist-card[\"\x27]\s+data-set=[\"\x27]([^\"\x27]+)[\"\x27]\s+data-number=[\"\x27]([^\"\x27]+)[\"\x27][^>]*>.*?<span class=[\"\x27]card-count[\"\x27]>(\d+)</span>\s*<span class=[\"\x27]card-name[\"\x27]>([^<]+)</span>",
            text,
            re.S,
        )

        card_entries = []
        tcgdex_ids_to_fetch = []
        for set_code, number, count_str, card_name in items:
            count = int(count_str)
            clean_name = card_name.strip()
            # Map Limitless set code to TCGdex set id
            tcgdex_set = SET_CODE_MAP.get(set_code.upper())
            if not tcgdex_set and self.repository:
                tcgdex_set = self.repository.resolve_set_code(set_code)
            if not tcgdex_set:
                tcgdex_set = set_code.lower()

            candidate_id = f"{tcgdex_set}-{number}"
            tcgdex_ids_to_fetch.append(candidate_id)
            card_entries.append({
                "set_code": set_code,
                "tcgdex_set": tcgdex_set,
                "number": number,
                "quantity": count,
                "name": clean_name,
                "candidate_id": candidate_id,
                "basic_energy": clean_name.lower().endswith(" energy"),
            })

        # Batch resolve all cards in 1 GraphQL call
        resolved = await self.get_cards(tcgdex_ids_to_fetch)
        resolved_map = {c.get("id"): c for c in resolved if c.get("id") and not c.get("unknown")}

        final_cards = []
        for entry in card_entries:
            matched_meta = resolved_map.get(entry["candidate_id"])
            if not matched_meta:
                cached_candidate = self.cards.get(entry["candidate_id"])
                if cached_candidate and not cached_candidate.get("unknown") and not cached_candidate.get("unverified"):
                    matched_meta = cached_candidate
            if not matched_meta:
                # Try padded / unpadded match
                for mid, mdata in resolved_map.items():
                    if mid.startswith(f"{entry['tcgdex_set']}-") and (
                        str(mdata.get("localId", "")).lstrip("0") == entry["number"].lstrip("0")
                    ):
                        matched_meta = mdata
                        break
            if not matched_meta:
                try:
                    cands = await self.search_cards(entry["name"])
                    for cand in cands:
                        if cand.get("id", "").startswith(f"{entry['tcgdex_set']}-") or str(cand.get("localId", "")).lstrip("0") == entry["number"].lstrip("0"):
                            matched_meta = cand
                            self.cards[entry["candidate_id"]] = matched_meta
                            break
                except Exception:
                    pass
            if not matched_meta:
                unverified_id = f"unverified-{entry['set_code']}-{entry['number']}"
                matched_meta = {
                    "id": unverified_id,
                    "name": entry["name"],
                    "localId": entry["number"],
                    "category": "Energy" if entry["basic_energy"] else "Pokemon",
                    "energyType": "Normal" if entry["basic_energy"] else None,
                    "set": {"id": entry["tcgdex_set"], "name": entry["set_code"], "tcgOnline": entry["set_code"]},
                    "legal": {"standard": False, "expanded": False},
                    "unverified": True,
                }

            card_item = {
                "card_id": matched_meta.get("id") if matched_meta else f"unverified-{entry['set_code']}-{entry['number']}",
                "name": matched_meta.get("name") if matched_meta else entry["name"],
                "quantity": entry["quantity"],
                "set_code": entry["set_code"],
                "set_name": (matched_meta.get("set") or {}).get("name") if matched_meta else entry["set_code"],
                "number": str(matched_meta.get("localId")) if matched_meta else entry["number"],
                "image_url": matched_meta.get("image") if matched_meta else None,
                "regulation_mark": matched_meta.get("regulationMark") if matched_meta else None,
                "legal": matched_meta.get("legal") if matched_meta else {"standard": False, "expanded": False},
            }
            if matched_meta and matched_meta.get("unverified"):
                card_item["unverified"] = True
            final_cards.append(card_item)

        return {
            "source_url": url,
            "total_cards": sum(c["quantity"] for c in final_cards),
            "cards": final_cards,
        }

    async def legality_knowledge(self) -> dict:
        """Fetch dated current official format and banned-card knowledge from DB or official rules."""
        if self.repository:
            try:
                if should_refresh_legality(self.repository):
                    await asyncio.to_thread(sync_legality, self.repository, "auto_weekly")
            except Exception:
                pass
            catalog = self.repository.query_legality_catalog()
            return {
                "as_of": utcnow().isoformat(),
                "sync_state": catalog.get("sync_state", {}),
                "total_sets": len(catalog.get("sets", [])),
                "total_banned_cards": len(catalog.get("banned_cards", [])),
                "official_sources": [
                    {"url": POKEMON_CARD_JP_URL, "title": "Official Pokemon Card Japan Regulation"},
                    {"url": "https://www.pokemon.com/us/pokemon-tcg-banned-card-list/", "title": "Official Play! Pokemon Banned Card List"},
                ],
            }
        query = f"site:pokemon.com Pokemon TCG Standard format rotation banned cards {utcnow().date().isoformat()}"
        try:
            results = await self.search(query)
        except (DDGSException, RuntimeError, httpx.HTTPError, OSError, ValueError):
            return {
                "as_of": utcnow().isoformat(),
                "official_sources": [],
                "warning": "Current legality research is unavailable or returned no results. Format legality and banned-card status remain unverified; do not infer current rotation.",
            }
        official = []
        for row in results[:4]:
            host = urlparse(row["url"]).hostname or ""
            if host == "pokemon.com" or host.endswith(".pokemon.com"):
                try:
                    official.append(await self.fetch(row["url"]))
                except (DDGSException, RuntimeError, httpx.HTTPError, OSError, ValueError):
                    continue
        return {
            "as_of": utcnow().isoformat(),
            "official_sources": official,
            "warning": "Only use successfully fetched current official rules; search snippets and TCGdex alone do not prove current format legality or bans.",
        }

    def tools(self):
        @tool
        async def query_tcgdex_graphql(
            query: str = "",
            name: str = "",
            set_id: str = "",
            local_id: str = "",
            regulation_mark: str = "",
            category: str = "",
            stage: str = "",
            trainer_type: str = "",
            energy_type: str = "",
            rarity: str = "",
            language: str = "en",
            limit: int = 20,
        ) -> dict:
            """Query Pokemon card metadata, sets, regulation marks, or printings directly from TCGdex GraphQL API (POST https://api.tcgdex.net/v2/graphql). You can provide either a raw GraphQL `query` string, or structured filter arguments like `name`, `set_id`, `local_id`, `regulation_mark`, `category`, `stage`, `trainer_type`, `energy_type`, `rarity`, `language` ('en' or 'ja'), and `limit`. Returned cards are automatically cached for deck planning."""
            return await self.query_tcgdex_graphql(
                query=query,
                name=name,
                set_id=set_id,
                local_id=local_id,
                regulation_mark=regulation_mark,
                category=category,
                stage=stage,
                trainer_type=trainer_type,
                energy_type=energy_type,
                rarity=rarity,
                language=language,
                limit=limit,
            )

        @tool
        async def search_cards(name: str, language: str = "en") -> list[dict]:
            """Find actual Pokemon card metadata and printings from TCGdex GraphQL (English or Japanese)."""
            return await self.search_cards(name, language=language)

        @tool
        async def get_card(card_id: str, language: str = "en") -> dict:
            """Verify actual printing metadata, image, local number and card legality flags from TCGdex."""
            return await self.card(card_id, language=language)

        @tool
        async def get_cards(card_ids: list[str], language: str = "en") -> list[dict]:
            """Verify up to 60 distinct card IDs in one batched GraphQL tool call for a full deck."""
            if not card_ids or len(card_ids) > 60:
                raise ValueError("Provide 1 to 60 card IDs.")
            return await self.get_cards(card_ids, language=language)

        @tool
        async def query_legality(
            ruleset: str = "international",
            format: str = "standard",
            set_query: str = "",
            card_query: str = "",
        ) -> dict:
            """Query the PostgreSQL legality catalog for sets, banned cards, and regulation marks (for International or Japan rulesets, Standard or Expanded formats)."""
            return await self.query_legality(
                ruleset=ruleset,
                format_=format,
                set_query=set_query or None,
                card_query=card_query or None,
            )

        @tool
        async def search_deck_lists(query: str) -> list[dict]:
            """Search Limitless TCG for tournament deck archetypes and lists (e.g. 'Lucario', 'Dragapult', 'Charizard')."""
            return await self.search_deck_lists(query)

        @tool
        async def get_deck_list(deck_id_or_list_id: str) -> dict:
            """Fetch a 60-card tournament deck list from Limitless TCG by list ID or archetype ID, resolving card IDs and set codes automatically."""
            return await self.get_deck_list(deck_id_or_list_id)

        @tool
        async def search_web(query: str) -> list[dict]:
            """Search free public web sources for deck lists, tournament standings, or card identity."""
            return await self.search(query)

        @tool
        async def fetch_public_page(url: str) -> dict:
            """Read a public HTTPS page as untrusted evidence; private networks and protection bypass are forbidden."""
            return await self.fetch(url)

        @tool
        async def current_legality() -> dict:
            """Fetch dated current official format and banned-card knowledge."""
            return await self.legality_knowledge()

        return [
            query_tcgdex_graphql,
            search_cards,
            get_card,
            get_cards,
            query_legality,
            search_deck_lists,
            get_deck_list,
            search_web,
            fetch_public_page,
            current_legality,
        ]
