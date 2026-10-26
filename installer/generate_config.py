"""Build Inno declarations from the application's language list and verified model catalogue."""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "python"))
from backend.ai.catalog import CATALOG  # noqa: E402

LANGUAGE_FILES = {"en": "Default.isl", "ru": "Languages\\Russian.isl", "uk": "Languages\\Ukrainian.isl"}


def main() -> None:
    languages = json.loads((ROOT / "frontend/src/i18n/languages.json").read_text(encoding="utf-8"))
    lines = ["[Languages]"]
    for locale in languages:
        lines.append(f'Name: "{locale}"; MessagesFile: "compiler:{LANGUAGE_FILES[locale]}"')
    lines += ["[Code]", "procedure DownloadModels;", "begin", "  ModelDownloadPage.Clear;"]
    for model in CATALOG:
        name = f"{model.model_id}-{model.version}.bin"
        target = f"{{userappdata}}\\AD Voice\\backend-data\\models\\{model.model_id}\\{model.version}\\model.bin"
        lines += [
            f"  if not VerifiedModel('{target}', '{model.checksum}') then",
            f"    ModelDownloadPage.Add('{model.download_url}', '{name}', '{model.checksum}');",
        ]
    lines += ["  ModelDownloadPage.Show;", "  try", "    ModelDownloadPage.Download;"]
    for model in CATALOG:
        lines.append(f"    KeepModel('{model.model_id}-{model.version}.bin', '{model.model_id}\\{model.version}');")
    lines += ["  finally", "    ModelDownloadPage.Hide;", "  end;", "end;"]
    Path(sys.argv[1]).write_text("\n".join(lines) + "\n", encoding="utf-8-sig")


if __name__ == "__main__":
    main()
