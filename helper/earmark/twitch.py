"""Public facts from Twitch: a category's box art, a channel's avatar and when it last streamed, who's live.

Twitch's own pages read these through its public GraphQL endpoint with the web client's id, without an account;
Earmark asks the same questions about public channels and categories, and nothing else. Answers are cached briefly.
If Twitch changes the endpoint, the pictures and live badges go missing and everything else keeps working.
"""

from __future__ import annotations

import json
import threading
import time
import urllib.request

GQL = "https://gql.twitch.tv/gql"
CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko"  # the twitch.tv web client's public id

CATEGORY = """query($name: String!) { game(name: $name) { displayName boxArtURL(width: 285, height: 380) } }"""
BY_SLUG = """query($slug: String!) { game(slug: $slug) { name boxArtURL(width: 285, height: 380) } }"""
VIDEO = """query($id: ID!) { video(id: $id) { title game { name } owner { login displayName } } }"""
CHANNELS = """query($logins: [String!]) { users(logins: $logins) {
  login displayName profileImageURL(width: 150)
  stream { title viewersCount createdAt game { displayName } }
  lastBroadcast { startedAt title }
  videos(first: 1, type: ARCHIVE) { edges { node { id createdAt } } }
} }"""
LIVE = """query($name: String!, $n: Int!) { game(name: $name) { streams(first: $n, options: {broadcasterLanguages: [EN], sort: VIEWER_COUNT}) {
  edges { node { title viewersCount createdAt previewImageURL(width: 440, height: 248)
    broadcaster { login displayName profileImageURL(width: 70) } } }
} } }"""


def _ask(query: str, variables: dict) -> dict | None:
    body = json.dumps({"query": query, "variables": variables}).encode()
    request = urllib.request.Request(
        GQL, data=body, headers={"Client-Id": CLIENT_ID, "Content-Type": "application/json", "User-Agent": "earmark"}
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.load(response).get("data")
    except Exception:
        return None


class Twitch:
    def __init__(self) -> None:
        self._cache: dict[str, tuple[float, object]] = {}
        self._lock = threading.Lock()

    def _cached(self, key: str, ttl: float, fetch):
        now = time.time()
        with self._lock:
            hit = self._cache.get(key)
            if hit and hit[0] > now:
                return hit[1]
        value = fetch()
        if value is not None:
            with self._lock:
                self._cache[key] = (now + ttl, value)
        return value

    def box_art(self, category: str) -> str | None:
        def fetch():
            data = _ask(CATEGORY, {"name": category})
            game = (data or {}).get("game")
            return (game or {}).get("boxArtURL") or ""
        return self._cached(f"art:{category.lower()}", 7 * 86400, fetch) or None

    def category(self, slug: str) -> dict | None:
        """{name, boxArt} for a category's address name ("just-chatting"): its English name, whatever language
        twitch.tv is shown in."""
        def fetch():
            game = (_ask(BY_SLUG, {"slug": slug}) or {}).get("game")
            return {"name": game.get("name"), "boxArt": game.get("boxArtURL")} if game and game.get("name") else None
        return self._cached(f"slug:{slug}", 7 * 86400, fetch)

    def video(self, vod_id: str) -> dict | None:
        """{title, category, login, displayName} of a past broadcast"""
        def fetch():
            v = (_ask(VIDEO, {"id": vod_id}) or {}).get("video")
            if not v:
                return None
            return {"title": v.get("title"), "category": (v.get("game") or {}).get("name"),
                    "login": (v.get("owner") or {}).get("login"), "displayName": (v.get("owner") or {}).get("displayName")}
        return self._cached(f"vod:{vod_id}", 86400, fetch)

    def channels(self, logins: list[str]) -> dict[str, dict]:
        """login → {displayName, avatar, live: {title, viewers, since, category} | None, lastLive, lastVod}"""
        logins = sorted({l.lower() for l in logins if l})[:50]
        if not logins:
            return {}

        def fetch():
            data = _ask(CHANNELS, {"logins": logins})
            if data is None:
                return None
            out = {}
            for u in data.get("users") or []:
                if not u:
                    continue
                stream = u.get("stream")
                vods = ((u.get("videos") or {}).get("edges") or [])
                out[u["login"]] = {
                    "displayName": u.get("displayName"),
                    "avatar": u.get("profileImageURL"),
                    "live": {
                        "title": stream.get("title"),
                        "viewers": stream.get("viewersCount"),
                        "since": stream.get("createdAt"),
                        "category": (stream.get("game") or {}).get("displayName"),
                    } if stream else None,
                    "lastLive": (u.get("lastBroadcast") or {}).get("startedAt"),
                    "lastVod": vods[0]["node"]["id"] if vods else None,
                }
            return out
        return self._cached("ch:" + ",".join(logins), 120, fetch) or {}

    def live(self, category: str, n: int = 10) -> list[dict]:
        def fetch():
            data = _ask(LIVE, {"name": category, "n": n})
            if data is None:
                return None
            edges = (((data.get("game") or {}).get("streams") or {}).get("edges")) or []
            return [{
                "login": e["node"]["broadcaster"]["login"],
                "displayName": e["node"]["broadcaster"]["displayName"],
                "avatar": e["node"]["broadcaster"]["profileImageURL"],
                "title": e["node"]["title"],
                "viewers": e["node"]["viewersCount"],
                "since": e["node"]["createdAt"],
                "preview": e["node"]["previewImageURL"],
            } for e in edges if e.get("node") and e["node"].get("broadcaster")]
        return self._cached(f"live:{category.lower()}:{n}", 90, fetch) or []
