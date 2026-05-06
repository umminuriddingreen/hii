"""Web search — DuckDuckGo (default), SearxNG, SerpAPI."""

from __future__ import annotations
import os
import re
import httpx

TIMEOUT = 15.0


def _strip_html(s: str) -> str:
    return re.sub(r"<[^>]+>", " ", s).replace("&amp;", "&").replace("&quot;", '"').strip()


def _format(results: list[dict]) -> str:
    if not results:
        return "No web results"
    return "\n\n".join(
        f"{i+1}. {r['title']}\n{r['link']}\n{r.get('snippet', '')}".strip()
        for i, r in enumerate(results)
    )


def duckduckgo(query: str, count: int = 5) -> str:
    r = httpx.get(
        "https://html.duckduckgo.com/html/",
        params={"q": query},
        headers={"User-Agent": "hii-cli/0.2"},
        timeout=TIMEOUT, follow_redirects=True,
    )
    results = []
    for m in re.finditer(
        r'<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)</a>.*?'
        r'<a[^>]+class="result__snippet"[^>]*>(.*?)</a>',
        r.text, re.DOTALL,
    ):
        if len(results) >= count:
            break
        results.append({"link": m.group(1), "title": _strip_html(m.group(2)),
                        "snippet": _strip_html(m.group(3))})
    return _format(results)


def searxng(query: str, count: int = 5, url: str | None = None) -> str:
    base = url or os.environ.get("SEARXNG_URL", "http://127.0.0.1:8888")
    try:
        r = httpx.post(
            f"{base}/search",
            data={"q": query, "language": "auto", "safesearch": "0", "category_general": "1"},
            headers={"User-Agent": "hii-cli/0.2"},
            timeout=TIMEOUT,
        )
        r.raise_for_status()
    except Exception as e:
        return f"SearxNG error: {e}"

    results = []
    for m in re.finditer(
        r'<article[^>]*class="[^"]*result[^"]*"[\s\S]*?<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)</a>'
        r'[\s\S]*?(?:<p[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)</p>)?',
        r.text, re.IGNORECASE,
    ):
        if len(results) >= count:
            break
        results.append({"link": m.group(1), "title": _strip_html(m.group(2)),
                        "snippet": _strip_html(m.group(3) or "")})
    return _format(results)


def search(query: str, provider: str | None = None) -> str:
    p = provider or ("searxng" if os.environ.get("SEARXNG_URL") else "duckduckgo")
    if p == "searxng":
        result = searxng(query)
        if not result.startswith("SearxNG error:"):
            return result
        return duckduckgo(query)
    return duckduckgo(query)
