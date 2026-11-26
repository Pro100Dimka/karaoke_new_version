"""Consent receipts and narrowly scoped file declarations, shared by the two servers."""

from __future__ import annotations

import hashlib
import secrets
import time
import re
import shutil
from pathlib import Path

from backend.domain_errors import DomainError, ForbiddenError
from backend.infrastructure.sqlite_social import SocialDatabase

CONSENT_VERSION = "2026-11-26.1"
PURPOSES = ("online", "processing", "diagnostics")
TRANSFER_NOTICE = (
    "Recipient: Dmytro Andreiev, Ukraine; Oracle hosts the relay in Frankfurt, Germany. "
    "Online: profile, contacts, room activity, voice and shared projects, including room copies. "
    "Processing: source audio, lyrics, project metadata and results on the recipient's PC in Ukraine. "
    "Diagnostics: optional technical logs and metrics. The recipient administers the servers from Ukraine. "
    "Ukraine has no EU adequacy decision; an applicable Article 46 safeguard for this return "
    "has not been confirmed. Risks include weaker enforceability of rights, public authority "
    "access and difficulties obtaining redress. Explicit consent concerns the selected purpose "
    "and its transfers under Article 49(1)(a), not acceptance of terms. Refuse or withdraw in "
    "Privacy settings; future corresponding transfers stop, prior lawful processing is unaffected. "
    "Room voice is unencrypted. Other participants may keep copies. Consent covers only your "
    "own personal data, not another person's data. Local functions remain available."
)
NOTICE_HASH = hashlib.sha256(TRANSFER_NOTICE.encode()).hexdigest()


class TransferConsent:
    def __init__(self, path: Path | None) -> None:
        self._db = SocialDatabase(path, schema=())
        self._exports = None if path is None else path.parent / "admin-exports"
        for statement in (
            "CREATE TABLE IF NOT EXISTS transfer_consents (owner TEXT, purpose TEXT, version TEXT,"
            " enabled INTEGER, revision TEXT, changed REAL, PRIMARY KEY(owner,purpose))",
            "CREATE TABLE IF NOT EXISTS consent_receipts (owner TEXT, purpose TEXT, version TEXT,"
            " notice_hash TEXT, enabled INTEGER, revision TEXT, recorded REAL)",
            "CREATE TABLE IF NOT EXISTS file_declarations (ticket TEXT PRIMARY KEY, owner TEXT,"
            " purpose TEXT, resource TEXT, category TEXT, evidence TEXT, revision TEXT, expires REAL)",
            "CREATE TABLE IF NOT EXISTS export_audit (owner TEXT, purpose TEXT, recorded REAL)",
            "CREATE TABLE IF NOT EXISTS consent_notices (version TEXT PRIMARY KEY, notice TEXT, notice_hash TEXT)",
        ):
            self._db.write(statement)
        self._db.write(
            "INSERT OR IGNORE INTO consent_notices VALUES (?,?,?)",
            (CONSENT_VERSION, TRANSFER_NOTICE, NOTICE_HASH),
        )
        if (
            self._db.rows(
                "SELECT notice_hash FROM consent_notices WHERE version=?", (CONSENT_VERSION,)
            )[0][0]
            != NOTICE_HASH
        ):
            raise ValueError("Transfer notice changed without a consent version change")

    def revision(self, owner: str, purpose: str) -> str:
        rows = self._db.rows(
            "SELECT revision FROM transfer_consents WHERE owner=? AND purpose=?"
            " AND enabled=1 AND version=?",
            (owner, purpose, CONSENT_VERSION),
        )
        return str(rows[0][0]) if rows else ""

    def require(self, owner: str, purpose: str) -> str:
        revision = self.revision(owner, purpose)
        if not revision or (purpose != "online" and not self.revision(owner, "online")):
            raise ForbiddenError(
                "TransferConsentRequired",
                "Confirm the separate transfer consent in Privacy settings",
            )
        return revision

    def record(self, owner: str, purpose: str, enabled: bool, version: str) -> None:
        if purpose not in PURPOSES or version != CONSENT_VERSION:
            raise ForbiddenError(
                "TransferConsentVersion", "Read the current transfer notice before choosing"
            )
        current = self._db.rows(
            "SELECT enabled,version FROM transfer_consents WHERE owner=? AND purpose=?",
            (owner, purpose),
        )
        if current and current[0] == (int(enabled), version):
            return
        if (
            enabled
            and not current
            and int(str(self._db.rows("SELECT count(*) FROM transfer_consents")[0][0])) >= 65536
        ):
            raise DomainError("ConsentStorageLimit", "Consent storage capacity reached", 429)
        moment, revision = time.time(), secrets.token_hex(16)
        self._db.write_all(
            (
                (
                    "INSERT OR REPLACE INTO transfer_consents VALUES (?,?,?,?,?,?)",
                    (owner, purpose, version, int(enabled), revision, moment),
                ),
                (
                    "INSERT INTO consent_receipts VALUES (?,?,?,?,?,?,?)",
                    (owner, purpose, version, NOTICE_HASH, int(enabled), revision, moment),
                ),
            )
        )

    def declare(self, owner: str, purpose: str, resource: str, category: str, evidence: str) -> str:
        revision = self.require(owner, purpose)
        counts = self._db.rows(
            "SELECT count(*),sum(CASE WHEN owner=? AND expires>? THEN 1 ELSE 0 END) FROM file_declarations",
            (owner, time.time()),
        )[0]
        if int(str(counts[0])) >= 32768 or int(str(counts[1] or 0)) >= 1024:
            raise DomainError(
                "DeclarationStorageLimit", "Too many recent file operations; try later", 429
            )
        if category not in ["own", "nonpersonal", "others"] or (
            category == "others" and re.fullmatch(r"sha256:[a-f0-9]{64}", evidence) is None
        ):
            raise ForbiddenError(
                "FileDeclarationRequired",
                "Identify whose data is included and the authority for others' data",
            )
        ticket = secrets.token_urlsafe(32)
        self._db.write(
            "INSERT INTO file_declarations VALUES (?,?,?,?,?,?,?,?)",
            (ticket, owner, purpose, resource, category, evidence, revision, time.time() + 86400),
        )
        return ticket

    def require_file(
        self, ticket: str, owner: str, purpose: str, resource: str | None = None
    ) -> None:
        revision = self.require(owner, purpose)
        rows = self._db.rows(
            "SELECT resource FROM file_declarations WHERE ticket=? AND owner=? AND purpose=?"
            " AND revision=? AND expires>?",
            (ticket, owner, purpose, revision, time.time()),
        )
        if not rows or (resource is not None and rows[0][0] != resource):
            raise ForbiddenError(
                "FileDeclarationRequired", "Confirm the data declaration for this operation"
            )

    def erase(self, owners: tuple[str, ...]) -> None:
        for owner in owners:
            if self._exports is not None and re.fullmatch(r"[a-f0-9]{32}", owner):
                directory = self._exports / owner
                if directory.is_dir():
                    shutil.rmtree(directory)
            self._db.write_all(
                (f"DELETE FROM {table} WHERE owner=?", (owner,))
                for table in [
                    "transfer_consents",
                    "consent_receipts",
                    "file_declarations",
                    "export_audit",
                ]
            )
        self._db.checkpoint()

    def export_revision(self, owner: str, purpose: str) -> str:
        if len(owner) != 32 or any(value not in "0123456789abcdef" for value in owner):
            raise ForbiddenError("ExportScopeRequired", "Specify one participant")
        if purpose not in ["support-request", "incident-investigation"]:
            raise ForbiddenError("ExportPurposeRequired", "Specify the support or security purpose")
        return self.require(owner, "diagnostics")

    def record_export(self, owner: str, purpose: str) -> None:
        self.export_revision(owner, purpose)
        self._db.write("INSERT INTO export_audit VALUES (?,?,?)", (owner, purpose, time.time()))

    def export_path(self, owner: str, purpose: str) -> Path:
        self.export_revision(owner, purpose)
        if self._exports is None:
            raise ValueError("Export requires persistent server storage")
        directory = self._exports / owner
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        return directory / (secrets.token_hex(16) + ".jsonl")

    def cleanup(self) -> None:
        if self._exports is not None:
            for output in self._exports.glob("*/*.jsonl"):
                if output.stat().st_mtime < time.time() - 7 * 86400:
                    output.unlink(missing_ok=True)
        self._db.write("DELETE FROM file_declarations WHERE expires<?", (time.time() - 7 * 86400,))
        self._db.write("DELETE FROM export_audit WHERE recorded<?", (time.time() - 7 * 86400,))
        self._db.write(
            "DELETE FROM consent_receipts WHERE recorded<? AND revision NOT IN"
            " (SELECT revision FROM transfer_consents WHERE enabled=1)",
            (time.time() - 365 * 86400,),
        )
