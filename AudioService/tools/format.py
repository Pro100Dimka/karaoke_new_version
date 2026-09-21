#!/usr/bin/env python3
import json
import pathlib
import shutil
import subprocess
import sys

root = pathlib.Path(__file__).resolve().parents[1]
paths = []
for directory in (root / "src", root / "tests", root / "tools"):
    if directory.exists():
        paths.extend(p for p in directory.rglob("*") if p.suffix in {".cpp", ".hpp", ".h"})

clang_format = shutil.which("clang-format")
if clang_format:
    subprocess.run([clang_format, "-i", *map(str, paths)], check=True)
    print(f"Formatted {len(paths)} files with clang-format")
    raise SystemExit(0)

clangd = shutil.which("clangd")
if not clangd:
    raise SystemExit("clang-format or clangd is required to format the project")

process = subprocess.Popen(
    [clangd, "--log=error"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE
)


def send(message):
    data = json.dumps(message, separators=(",", ":")).encode()
    process.stdin.write(f"Content-Length: {len(data)}\r\n\r\n".encode() + data)
    process.stdin.flush()


def receive():
    headers = {}
    while True:
        line = process.stdout.readline()
        if not line:
            raise RuntimeError(process.stderr.read().decode())
        if line in (b"\r\n", b"\n"):
            break
        key, value = line.decode().split(":", 1)
        headers[key.lower()] = value.strip()
    return json.loads(process.stdout.read(int(headers["content-length"])))


def wait_for(request_id):
    while True:
        response = receive()
        if response.get("id") == request_id:
            return response


def offset(text, position):
    lines = text.splitlines(keepends=True)
    return sum(len(line) for line in lines[: position["line"]]) + position["character"]


send(
    {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {"processId": None, "rootUri": root.as_uri(), "capabilities": {}},
    }
)
wait_for(1)
send({"jsonrpc": "2.0", "method": "initialized", "params": {}})

for request_id, path in enumerate(paths, start=2):
    text = path.read_text()
    send(
        {
            "jsonrpc": "2.0",
            "method": "textDocument/didOpen",
            "params": {
                "textDocument": {
                    "uri": path.resolve().as_uri(),
                    "languageId": "cpp",
                    "version": 1,
                    "text": text,
                }
            },
        }
    )
    send(
        {
            "jsonrpc": "2.0",
            "id": request_id,
            "method": "textDocument/formatting",
            "params": {
                "textDocument": {"uri": path.resolve().as_uri()},
                "options": {"tabSize": 4, "insertSpaces": True},
            },
        }
    )
    edits = wait_for(request_id).get("result") or []
    original = text
    for edit in sorted(edits, key=lambda item: offset(original, item["range"]["start"]), reverse=True):
        start = offset(original, edit["range"]["start"])
        end = offset(original, edit["range"]["end"])
        text = text[:start] + edit["newText"] + text[end:]
    path.write_text(text)
    send(
        {
            "jsonrpc": "2.0",
            "method": "textDocument/didClose",
            "params": {"textDocument": {"uri": path.resolve().as_uri()}},
        }
    )

send({"jsonrpc": "2.0", "id": 10_000, "method": "shutdown", "params": None})
wait_for(10_000)
send({"jsonrpc": "2.0", "method": "exit", "params": None})
process.wait(timeout=5)
print(f"Formatted {len(paths)} files with clangd formatter")
