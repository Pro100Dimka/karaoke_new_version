"""Publish signed channel provenance from CC0 metadata and primary-source links."""

from __future__ import annotations

import argparse
import base64
import hashlib
import http.client
import ipaddress
import json
import logging
import re
import socket
import sqlite3
import ssl
import subprocess
import tarfile
import time
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from pathlib import Path
from typing import Any

from yt_dlp import YoutubeDL
from yt_dlp.utils import DownloadError

USER_AGENT = (
    "ADVoice-SourceRegistry/1.0 (https://github.com/Pro100Dimka/karaoke_new_version)"
)
DUMPS = "https://data.metabrainz.org/pub/musicbrainz/data/json-dumps/"
CHANNEL = re.compile(r"UC[A-Za-z0-9_-]{22}")
logger = logging.getLogger("source-registry")


def atomic_json(path: Path, value: object) -> None:
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    temporary.replace(path)


class PublicConnection(http.client.HTTPSConnection):
    _context: ssl.SSLContext

    def connect(self) -> None:
        addresses = socket.getaddrinfo(self.host, self.port, type=socket.SOCK_STREAM)
        if not addresses or any(
            not ipaddress.ip_address(row[4][0]).is_global for row in addresses
        ):
            raise ValueError("Source host must resolve only to public addresses")
        self.sock = self._context.wrap_socket(
            socket.create_connection(
                (str(addresses[0][4][0]), self.port), timeout=self.timeout
            ),
            server_hostname=self.host,
        )


class Network:
    def __init__(self) -> None:
        self.last_request: dict[str, float] = {}

    def read(self, url: str) -> bytes:
        for _ in range(5):
            parsed = urllib.parse.urlsplit(url)
            if parsed.scheme == "http":
                parsed = parsed._replace(scheme="https")
            if (
                parsed.scheme != "https"
                or not parsed.hostname
                or parsed.username is not None
                or parsed.password is not None
                or parsed.port not in [None, 443]
            ):
                raise ValueError("Only public HTTPS sources are supported")
            host = parsed.hostname
            time.sleep(max(0, self.last_request.get(host, 0) + 1.1 - time.monotonic()))
            self.last_request[host] = time.monotonic()
            connection = PublicConnection(
                host, timeout=12, context=ssl.create_default_context()
            )
            try:
                target = urllib.parse.urlunsplit(
                    ("", "", parsed.path or "/", parsed.query, "")
                )
                connection.request("GET", target, headers={"User-Agent": USER_AGENT})
                response = connection.getresponse()
                if response.status in [301, 302, 303, 307, 308]:
                    location = response.getheader("Location")
                    if not location:
                        raise ValueError("Source redirect has no destination")
                    url = urllib.parse.urljoin(parsed.geturl(), location)
                    continue
                if response.status != 200:
                    raise ValueError(f"Source returned HTTP {response.status}")
                data = response.read(4 * 1024 * 1024 + 1)
                if len(data) > 4 * 1024 * 1024:
                    raise ValueError("Source response is too large")
                return data
            finally:
                connection.close()
        raise ValueError("Too many source redirects")

    def entities(self, identifiers: list[str]) -> dict[str, Any]:
        query = urllib.parse.urlencode(
            {
                "action": "wbgetentities",
                "ids": "|".join(identifiers),
                "props": "claims",
                "format": "json",
            }
        )
        data = json.loads(self.read("https://www.wikidata.org/w/api.php?" + query))
        return dict(data.get("entities", {}))


def values(entity: dict[str, Any], property_id: str) -> list[Any]:
    return [
        claim["mainsnak"]["datavalue"]["value"]
        for claim in entity.get("claims", {}).get(property_id, [])
        if claim.get("rank") != "deprecated"
        and "datavalue" in claim.get("mainsnak", {})
    ]


def youtube_link(url: str) -> bool:
    return urllib.parse.urlsplit(url).hostname in [
        "youtube.com",
        "www.youtube.com",
        "m.youtube.com",
        "youtu.be",
        "www.youtu.be",
    ]


def site_key(url: str) -> tuple[str, str]:
    parsed = urllib.parse.urlsplit(url)
    return (parsed.hostname or "").lower().removeprefix("www."), parsed.path.rstrip("/")


class Links(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.links: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        if tag in ["a", "iframe"]:
            value = attributes.get("href" if tag == "a" else "src")
            if value:
                self.links.append(value)


def source_links(body: str, artist: str, label: bool) -> list[str]:
    if label:
        # Label homepages contain other artists too. Only accept an explicitly named artist card.
        blocks = re.split(r"(?=<[^>]+\bdata-[\w-]*artist-card\b)", body)
        named = [
            block.split("</h3>", 1)[0]
            for block in blocks[1:]
            if re.search(
                r"<h3\b[^>]*>\s*" + re.escape(artist) + r"\s*</h3>",
                block,
                re.IGNORECASE,
            )
        ]
        body = "\n".join(named)
    parser = Links()
    parser.feed(body)
    return list(dict.fromkeys(url for url in parser.links if youtube_link(url)))[:40]


class Collector:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.network = Network()
        self.aliases: dict[str, str | None] = {}
        self.database = sqlite3.connect(root / "state/candidates.sqlite3")
        self.database.execute(
            "CREATE TABLE IF NOT EXISTS candidates (id TEXT PRIMARY KEY, name TEXT NOT NULL, "
            "data TEXT NOT NULL, dump TEXT NOT NULL, attempted INTEGER NOT NULL DEFAULT 0, "
            "evidence TEXT NOT NULL DEFAULT '[]')"
        )

    def import_dump(self) -> None:
        latest = self.network.read(DUMPS + "LATEST").decode().strip()
        if re.fullmatch(r"\d{8}-\d{6}", latest) is None:
            raise ValueError("Invalid MusicBrainz dump version")
        marker = self.root / "state/dump-version.json"
        if marker.exists() and json.loads(marker.read_text()) == latest:
            return
        checksums = self.network.read(DUMPS + latest + "/SHA256SUMS").decode()
        expected = next(
            line.split()[0]
            for line in checksums.splitlines()
            if line.split() and line.split()[-1].lstrip("*") == "artist.tar.xz"
        )
        archive = self.root / "cache/artist.tar.xz"
        temporary = archive.with_suffix(".part")
        digest = hashlib.sha256()
        try:
            request = urllib.request.Request(
                DUMPS + latest + "/artist.tar.xz", headers={"User-Agent": USER_AGENT}
            )
            with (
                urllib.request.urlopen(request, timeout=60) as response,
                temporary.open("wb") as out,
            ):
                while chunk := response.read(1024 * 1024):
                    digest.update(chunk)
                    out.write(chunk)
            if digest.hexdigest() != expected:
                raise ValueError("MusicBrainz dump checksum mismatch")
            temporary.replace(archive)
            count = 0
            with tarfile.open(archive, "r|xz") as stream:
                for member in stream:
                    if not member.isfile() or member.name != "mbdump/artist":
                        continue
                    source = stream.extractfile(member)
                    if source is None:
                        continue
                    for line in source:
                        record = json.loads(line)
                        relations = record.get("relations", [])
                        urls: dict[str, list[str]] = {}
                        for relation in relations:
                            target = relation.get("url", {}).get("resource")
                            if isinstance(target, str):
                                urls.setdefault(relation.get("type", ""), []).append(
                                    target
                                )
                        if urls.get("youtube") and urls.get("wikidata"):
                            self.database.execute(
                                "INSERT INTO candidates (id,name,data,dump) VALUES (?,?,?,?) "
                                "ON CONFLICT(id) DO UPDATE SET name=excluded.name, "
                                "data=excluded.data,dump=excluded.dump",
                                (
                                    record["id"],
                                    record["name"],
                                    json.dumps(urls),
                                    latest,
                                ),
                            )
                        count += 1
                        if count % 100000 == 0:
                            self.database.commit()
                            logger.info("Imported %s MusicBrainz artists", count)
            if count == 0:
                raise ValueError("MusicBrainz archive contains no artist records")
            self.database.execute("DELETE FROM candidates WHERE dump != ?", (latest,))
            self.database.commit()
            atomic_json(marker, latest)
            logger.info("MusicBrainz import completed: %s artists", count)
        finally:
            temporary.unlink(missing_ok=True)
            archive.unlink(missing_ok=True)

    def channel(self, url: str) -> str | None:
        if not youtube_link(url):
            return None
        parsed = urllib.parse.urlsplit(url)
        direct = re.fullmatch(r"/channel/(UC[A-Za-z0-9_-]{22})/?", parsed.path)
        if direct:
            return direct[1]
        if not re.fullmatch(r"/(?:user/|c/)?[\w@.-]+/?", parsed.path):
            return None
        target = "https://www.youtube.com" + parsed.path.rstrip("/") + "/videos"
        if target not in self.aliases:
            try:
                with YoutubeDL(
                    {
                        "quiet": True,
                        "no_warnings": True,
                        "skip_download": True,
                        "extract_flat": True,
                        "playlist_items": "1",
                        "cachedir": False,
                        "js_runtimes": {},
                        "remote_components": set(),
                        "socket_timeout": 10,
                        "retries": 0,
                        "extractor_retries": 0,
                        "extractor_args": {
                            "youtube": {
                                "player_client": ["visionos"],
                                "player_skip": ["js"],
                            }
                        },
                    }
                ) as downloader:
                    metadata = downloader.extract_info(target, download=False) or {}
                    channel = metadata.get("channel_id") or metadata.get("id") or ""
                    self.aliases[target] = (
                        channel if CHANNEL.fullmatch(channel) else None
                    )
            except (DownloadError, OSError, ValueError):
                self.aliases[target] = None
        return self.aliases[target]

    def confirm(
        self, artist_id: str, name: str, urls: dict[str, list[str]], dump: str
    ) -> list[dict[str, Any]]:
        qids = [
            urllib.parse.urlsplit(url).path.rsplit("/", 1)[-1]
            for url in urls["wikidata"]
            if urllib.parse.urlsplit(url).hostname
            in ["wikidata.org", "www.wikidata.org"]
        ]
        qids = [qid for qid in qids if re.fullmatch(r"Q\d+", qid)]
        if len(qids) != 1:
            return []
        entity = self.network.entities(qids).get(qids[0], {})
        if artist_id not in values(entity, "P434"):
            return []
        known = {channel for url in urls["youtube"] if (channel := self.channel(url))}
        if not known:
            raise ValueError("Channel aliases could not be resolved")
        channels = known.intersection(values(entity, "P2397"))
        if not channels:
            return []
        sites = [
            url
            for url in urls.get("official homepage", [])
            if site_key(url) in {site_key(site) for site in values(entity, "P856")}
        ]
        sources = [(site, False) for site in sites[:2]]
        labels = [
            v["id"] for v in values(entity, "P264") if isinstance(v, dict) and "id" in v
        ]
        if labels:
            try:
                for label in self.network.entities(labels[:5]).values():
                    sources.extend(
                        (site, True)
                        for site in values(label, "P856")
                        if isinstance(site, str)
                    )
            except (OSError, ValueError, http.client.HTTPException):
                logger.info("Label metadata unavailable for %s", name)
        evidence: dict[str, dict[str, Any]] = {}
        available = False
        for site, is_label in sources[:8]:
            try:
                body = self.network.read(site).decode("utf-8", errors="replace")
                available = True
                for link in source_links(body, name, is_label):
                    channel = self.channel(link)
                    if channel not in channels or channel in evidence:
                        continue
                    evidence[channel] = {
                        "channelId": channel,
                        "artist": name,
                        "musicbrainzId": artist_id,
                        "wikidataId": qids[0],
                        "sourceUrl": site,
                        "channelUrl": link,
                        "checkedAt": int(time.time()),
                        "sourceSha256": hashlib.sha256(body.encode()).hexdigest(),
                        "musicbrainzDump": dump,
                    }
                if channels.issubset(evidence):
                    break
            except (OSError, ValueError, http.client.HTTPException):
                logger.info("Primary source unavailable: %s", site)
        if sources and not available:
            raise ValueError("No primary source could be retrieved")
        return list(evidence.values())

    def refresh(self, limit: int) -> None:
        rows: list[tuple[str, str, str, str, str]] = []
        for confirmed in [True, False]:
            remaining = max(1, limit // 2) if confirmed else limit - len(rows)
            rows.extend(
                self.database.execute(
                    "SELECT id,name,data,evidence,dump FROM candidates WHERE attempted < ? "
                    "AND (evidence != '[]') = ? "
                    "ORDER BY attempted, CASE WHEN id IN (?,?) THEN 0 ELSE 1 END, id LIMIT ?",
                    (
                        int(time.time()) - 86400,
                        confirmed,
                        "cc2c9c3c-b7bc-4b8b-84d8-4fbd8779e493",
                        "fc582f4a-0fe5-4cdc-96c5-527fdbbb30e6",
                        remaining,
                    ),
                ).fetchall()
            )
        for artist_id, name, data, previous, dump in rows:
            try:
                evidence = self.confirm(artist_id, name, json.loads(data), dump)
            except Exception:
                logger.exception("Source confirmation unavailable for %s", name)
                evidence = json.loads(previous)
            self.database.execute(
                "UPDATE candidates SET attempted=?,evidence=? WHERE id=?",
                (int(time.time()), json.dumps(evidence), artist_id),
            )
            self.database.commit()
            logger.info("Checked %s: %s confirmed channels", name, len(evidence))
            self.publish()

    def publish(self) -> None:
        channels: dict[str, Any] = {}
        for (data,) in self.database.execute(
            "SELECT evidence FROM candidates WHERE evidence != '[]'"
        ):
            for entry in json.loads(data):
                if int(time.time()) - entry["checkedAt"] <= 30 * 86400:
                    channels[entry["channelId"]] = entry
        selected = []
        size = 0
        for entry in sorted(
            channels.values(), key=lambda row: row["checkedAt"], reverse=True
        ):
            size += len(json.dumps(entry, ensure_ascii=False).encode())
            if size > 5 * 1024 * 1024:
                break
            selected.append(entry)
        payload = json.dumps(
            {"version": 1, "generatedAt": int(time.time()), "channels": selected},
            separators=(",", ":"),
            ensure_ascii=False,
        ).encode()
        temporary = self.root / "state/payload.tmp"
        try:
            temporary.write_bytes(payload)
            signature = subprocess.run(
                [
                    "openssl",
                    "pkeyutl",
                    "-sign",
                    "-rawin",
                    "-inkey",
                    str(self.root / "state/signing.pem"),
                    "-in",
                    str(temporary),
                ],
                capture_output=True,
                check=True,
            ).stdout
            atomic_json(
                self.root / "public/registry.json",
                {
                    "payload": base64.b64encode(payload).decode(),
                    "signature": base64.b64encode(signature).decode(),
                },
            )
            logger.info("Published %s confirmed channels", len(channels))
        finally:
            temporary.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--root", type=Path, default=Path("/opt/ad-voice-source-registry")
    )
    parser.add_argument("--limit", type=int, default=50)
    args = parser.parse_args()
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    collector = Collector(args.root)
    try:
        try:
            collector.import_dump()
        except Exception:
            logger.exception(
                "MusicBrainz refresh failed; keeping the previous candidate database"
            )
            if (
                collector.database.execute(
                    "SELECT count(*) FROM candidates"
                ).fetchone()[0]
                == 0
            ):
                raise
        collector.refresh(args.limit)
        collector.publish()
    finally:
        collector.database.close()


if __name__ == "__main__":
    main()
