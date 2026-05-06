"""Academic search — arXiv, OpenAlex, Crossref."""

from __future__ import annotations
import re
from dataclasses import dataclass
import httpx

TIMEOUT = 15.0


@dataclass
class Paper:
    source: str
    title: str
    authors: list[str]
    year: int | None
    venue: str | None
    doi: str | None
    url: str
    abstract: str | None
    id: str


def _dedupe(items: list[Paper]) -> list[Paper]:
    seen: dict[str, Paper] = {}
    for it in items:
        key = (it.doi or it.id or f"{it.title}|{','.join(it.authors[:2])}").lower()
        if key not in seen:
            seen[key] = it
    return list(seen.values())


def search_arxiv(query: str, max_results: int = 5) -> list[Paper]:
    try:
        r = httpx.get(
            "http://export.arxiv.org/api/query",
            params={"search_query": f"all:{query}", "start": "0", "max_results": str(max_results)},
            headers={"User-Agent": "hii-cli/0.2"}, timeout=TIMEOUT,
        )
        if not r.is_success:
            return []
    except Exception:
        return []

    papers = []
    for entry in r.text.split("<entry>")[1:]:
        title = re.search(r"<title>(.*?)</title>", entry, re.DOTALL)
        abstract = re.search(r"<summary>(.*?)</summary>", entry, re.DOTALL)
        pid = re.search(r"<id>(.*?)</id>", entry, re.DOTALL)
        year_m = re.search(r"<published>(\d{4})-", entry)
        authors = re.findall(r"<name>(.*?)</name>", entry)
        link = re.search(r'<link rel="alternate" type="text/html" href="([^"]+)"', entry)

        papers.append(Paper(
            source="arxiv",
            title=" ".join((title.group(1) if title else "").split()),
            abstract=" ".join((abstract.group(1) if abstract else "").split()),
            id=(pid.group(1) if pid else "").strip(),
            year=int(year_m.group(1)) if year_m else None,
            authors=[a.strip() for a in authors],
            url=(link.group(1) if link else (pid.group(1) if pid else "")),
            venue=None, doi=None,
        ))
    return papers


def search_openalex(query: str, max_results: int = 5) -> list[Paper]:
    try:
        r = httpx.get(
            "https://api.openalex.org/works",
            params={"search": query, "per-page": str(max_results), "mailto": "hii-cli@example.com"},
            timeout=TIMEOUT,
        )
        if not r.is_success:
            return []
        data = r.json()
    except Exception:
        return []

    papers = []
    for w in data.get("results", []):
        abstract_idx = w.get("abstract_inverted_index") or {}
        abstract = " ".join(k for k, _ in sorted(abstract_idx.items(), key=lambda x: x[1][0] if x[1] else 0)) if abstract_idx else None
        papers.append(Paper(
            source="openalex", id=w.get("id", ""), title=w.get("title", ""),
            authors=[a["author"]["display_name"] for a in w.get("authorships", []) if a.get("author", {}).get("display_name")],
            year=w.get("publication_year"), venue=(w.get("host_venue") or {}).get("display_name"),
            doi=w.get("doi"), url=w.get("open_access", {}).get("oa_url") or w.get("doi") or w.get("id", ""),
            abstract=abstract,
        ))
    return papers


def search_crossref(query: str, max_results: int = 5) -> list[Paper]:
    try:
        r = httpx.get("https://api.crossref.org/works",
                       params={"query": query, "rows": str(max_results)}, timeout=TIMEOUT)
        if not r.is_success:
            return []
        data = r.json()
    except Exception:
        return []

    papers = []
    for it in data.get("message", {}).get("items", []):
        title = it.get("title", [""])[0] if isinstance(it.get("title"), list) else it.get("title", "")
        authors = [f"{a.get('given', '')} {a.get('family', '')}".strip() for a in it.get("author", [])]
        year = (it.get("issued", {}).get("date-parts") or [[None]])[0][0]
        abstract = re.sub(r"<[^>]+>", "", it.get("abstract", "")) if it.get("abstract") else None
        papers.append(Paper(
            source="crossref", id=it.get("DOI") or it.get("URL", ""), title=title, authors=authors,
            year=year, venue=(it.get("container-title") or [None])[0], doi=it.get("DOI"),
            url=it.get("URL") or (f"https://doi.org/{it['DOI']}" if it.get("DOI") else ""),
            abstract=abstract,
        ))
    return papers


def search(query: str, max_results: int = 10) -> list[Paper]:
    from concurrent.futures import ThreadPoolExecutor
    n = min(5, max_results)
    with ThreadPoolExecutor(3) as pool:
        fa = pool.submit(search_arxiv, query, n)
        fo = pool.submit(search_openalex, query, n)
        fc = pool.submit(search_crossref, query, n)
    return _dedupe(fa.result() + fo.result() + fc.result())[:max_results]


def format_results(papers: list[Paper]) -> str:
    if not papers:
        return "No scholarly results"
    lines = []
    for i, p in enumerate(papers):
        authors = ", ".join(p.authors[:5]) + (" et al." if len(p.authors) > 5 else "")
        year = f" ({p.year})" if p.year else ""
        venue = f" {p.venue}" if p.venue else ""
        doi = f" DOI: {p.doi}" if p.doi else ""
        abstract = (p.abstract[:400] + "..." if p.abstract and len(p.abstract) > 400 else p.abstract or "")
        lines.append(f"{i+1}. {p.title}{year}{venue}\n{authors}\n[{p.source}] {p.url}{doi}\n{abstract}")
    return "\n\n".join(lines)
