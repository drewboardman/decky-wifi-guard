"""Build a runtime-only archive suitable for Decky's ZIP installer."""
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

root = Path(__file__).resolve().parent.parent
name = json.loads((root / "plugin.json").read_text())["name"]
version = json.loads((root / "package.json").read_text())["version"]
files = ["main.py", "plugin.json", "package.json", "dist/index.js", "README.md", "LICENSE"]
for file in files:
    if not (root / file).is_file():
        raise SystemExit(f"Missing {file}; run pnpm build first")
(root / "out").mkdir(exist_ok=True)
archive = root / "out" / f"decky-wifi-toggle-{version}.zip"
with ZipFile(archive, "w", ZIP_DEFLATED) as zip_file:
    for file in files:
        zip_file.write(root / file, f"{name}/{file}")
print(archive)
