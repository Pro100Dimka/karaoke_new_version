from __future__ import annotations

from pathlib import PurePosixPath
import struct
import zipfile

import pytest

from backend.domain_errors import DependencyError
from backend.infrastructure import zip_archive


@pytest.mark.parametrize("corrupt_entry", ["first.bin", "empty.bin", "last.bin", "metadata.txt"])
def test_export_checks_every_entry_crc_and_preserves_the_previous_archive(
    tmp_path, monkeypatch, corrupt_entry
):
    payloads = {"first.bin": b"first file", "empty.bin": b"", "last.bin": b"last file"}
    files = {}
    for name, data in payloads.items():
        path = tmp_path / name
        path.write_bytes(data)
        files[PurePosixPath(name)] = path
    output = tmp_path / "published.zip"
    with zipfile.ZipFile(output, "w") as previous:
        previous.writestr("verified.txt", "previous publication")
    previous_bytes = output.read_bytes()
    write_archive = zip_archive._write_archive

    def corrupt_crc(path, *args, **kwargs):
        write_archive(path, *args, **kwargs)
        with zipfile.ZipFile(path) as bundle:
            offset = bundle.start_dir
            entries = len(bundle.infolist())
        data = bytearray(path.read_bytes())
        for _ in range(entries):
            assert data[offset : offset + 4] == b"PK\x01\x02"
            name_length, extra_length, comment_length = struct.unpack_from(
                "<HHH", data, offset + 28
            )
            name = data[offset + 46 : offset + 46 + name_length].decode("utf-8")
            if name == corrupt_entry:
                data[offset + 16] ^= 1  # Corrupt the central-directory CRC, including empty files.
                path.write_bytes(data)
                return
            offset += 46 + name_length + extra_length + comment_length
        pytest.fail("The requested CRC fixture entry was not written")

    monkeypatch.setattr(zip_archive, "_write_archive", corrupt_crc)
    with pytest.raises(DependencyError) as error:
        zip_archive.ZipPackageArchive().build(
            output, files, {PurePosixPath("metadata.txt"): "complete metadata"}, lambda _value: None
        )
    assert error.value.code == "PackageExportFailed"
    assert output.read_bytes() == previous_bytes
    assert not list(output.parent.glob(".*.tmp"))
    for relative, source in files.items():
        assert source.read_bytes() == payloads[relative.name]
