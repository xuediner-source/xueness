"""Write checksums for actual platform installers; no upload or release creation."""
import hashlib
from pathlib import Path

root = Path(__file__).resolve().parents[1]/'release'
files = sorted(p for p in root.iterdir() if p.is_file() and p.suffix in ('.exe', '.zip', '.dmg'))
if not files:
    raise SystemExit('No desktop installers found.')
(root/'SHA256SUMS.txt').write_text(''.join(f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}\n' for p in files))
for p in files:
    print(p.name, p.stat().st_size)
