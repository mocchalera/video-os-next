"""Copy installed Python distributions (and their dependency closure) from one environment's
site-packages into another, file by file per RECORD. Used to assemble python/.venv offline
from environments that already exist on this machine (no network, no rebuild).

  python merge_dists.py <src-site-packages> <dst-site-packages> <dist> [<dist> ...]
"""
import re, shutil, sys
from importlib.metadata import distributions
from pathlib import Path

src, dst = Path(sys.argv[1]), Path(sys.argv[2])
wanted = [re.sub(r"[-_.]+", "-", n).lower() for n in sys.argv[3:]]
norm = lambda n: re.sub(r"[-_.]+", "-", n).lower()
src_d = {norm(d.metadata["Name"]): d for d in distributions(path=[str(src)])}
dst_d = {norm(d.metadata["Name"]) for d in distributions(path=[str(dst)])}

todo, seen, copied = list(wanted), set(), []
while todo:
    n = todo.pop()
    if n in seen:
        continue
    seen.add(n)
    if n in dst_d:
        continue
    d = src_d.get(n)
    if d is None:
        print(f"skip {n}: not in source", file=sys.stderr)
        continue
    for req in d.requires or []:
        if "extra ==" in req:
            continue
        todo.append(norm(re.split(r"[ ;<>=!~\[(]", req, maxsplit=1)[0]))
    for f in d.files or []:
        p = Path(d.locate_file(f)).resolve()
        try:
            rel = p.relative_to(src.resolve())
        except ValueError:
            continue  # scripts in bin/ etc. are not needed
        out = dst / rel
        out.parent.mkdir(parents=True, exist_ok=True)
        if p.is_file():
            shutil.copy2(p, out)
    copied.append(f"{d.metadata['Name']}=={d.version}")
print("\n".join(sorted(copied)))
