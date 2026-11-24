"""Provision the CI media tools from the reviewed Ubuntu package snapshot."""

import hashlib
import os
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
import re
import shlex
import subprocess
import sys
from tempfile import mkdtemp

PIN = Path("scripts/ci-ffmpeg.lock")


def run(*args):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE, text=True).stdout


def install():
    header, *packages = PIN.read_text().splitlines()
    snapshot = re.fullmatch(r"snapshot (\d{8}T\d{6}Z)", header)[1]
    cache_hit = os.environ["FFMPEG_CACHE_HIT"] == "true"
    temp = Path(os.environ["RUNNER_TEMP"])
    cache = temp / "ci-ffmpeg-debs"
    if cache.is_symlink():
        raise ValueError("Cache directory is a symbolic link")
    cache.mkdir(exist_ok=True)
    rows = [row.split() for row in packages]
    revision, = [version for _, version, path in rows if Path(path).name.startswith("ffmpeg_")]
    version = revision.split(":")[-1]
    print(f"{'Cache hit: no downloads' if cache_hit else 'Cache miss: fetching from snapshot.ubuntu.com'}; "
          f"verifying {len(rows)} Ubuntu packages", flush=True)

    def verified_package(row):
        expected, _, path = row
        package = cache / Path(path).name
        if package.is_symlink():
            raise ValueError(f"Unexpected symlink: {package.name}")
        if not cache_hit:
            run("curl", "--disable", "--fail", "--silent", "--show-error", "--max-time", "45",
                "--output", package, f"https://snapshot.ubuntu.com/ubuntu/{snapshot}/{path}")
        if not package.is_file():
            raise ValueError(f"Missing package: {package.name}")
        actual = hashlib.sha256(package.read_bytes()).hexdigest()
        if actual != expected:
            raise ValueError(f"{package.name}: expected {expected}, actual {actual}")
        return package

    with ThreadPoolExecutor(max_workers=12) as pool:
        pending = [pool.submit(verified_package, row) for row in rows]
        try:
            for future in as_completed(pending):
                future.result()
        finally:
            for future in pending:
                future.cancel()
        archives = [future.result() for future in pending]

    # Only the listed, verified archives enter this fresh directory. No maintainer
    # scripts run, and the runner's system packages are never overwritten.
    root = Path(mkdtemp(prefix="ci-ffmpeg-", dir=temp))
    for archive in archives:
        run("dpkg-deb", "-x", archive, root)
    lib = root / "usr/lib/x86_64-linux-gnu"
    loader = lib / "ld-linux-x86-64.so.2"
    library_path = f"{lib}:{lib}/pulseaudio"
    bin_dir = root / "media-bin"
    bin_dir.mkdir()
    for tool in ("ffmpeg", "ffprobe"):
        binary = root / "usr/bin" / tool
        command = [str(loader), "--inhibit-cache", "--library-path", library_path]
        # An unmet dependency must not silently bind to an unpinned host library.
        for resolved in run(*command, "--list", binary).splitlines():
            if " => " in resolved:
                path = Path(resolved.split(" => ")[1].split()[0])
                if not path.resolve().is_relative_to(root):
                    raise ValueError(f"{tool}: library outside verified install: {resolved}")
        wrapper = bin_dir / tool
        wrapper.write_text("#!/bin/sh\nexec " + shlex.join([*command, str(binary)]) + ' "$@"\n')
        wrapper.chmod(0o755)
        line = run(wrapper, "-version").splitlines()[0]
        print(line, flush=True)
        if line.split()[:3] != [tool, "version", version]:
            raise ValueError(f"{tool}: expected version {version}")
    encoders = run(bin_dir / "ffmpeg", "-hide_banner", "-encoders")
    for flags, encoder in (("V", "libx264"), ("A", "aac")):
        if not re.search(rf"^\s*{flags}\S{{5}}\s+{encoder}\s", encoders, re.MULTILINE):
            raise ValueError(f"ffmpeg: missing encoder {encoder}")
    with open(os.environ["GITHUB_PATH"], "a") as output:
        print(bin_dir, file=output)
    print(f"Verified {len(archives)} Ubuntu packages; ffmpeg, ffprobe, libx264 and aac ready")


if __name__ == "__main__":
    if sys.argv[1:] == ["key"]:
        digest = hashlib.sha256(PIN.read_bytes()).hexdigest()
        print(f"key=ci-ffmpeg-{os.environ['ImageOS']}-{os.environ['RUNNER_ARCH']}-{digest}")
    else:
        try:
            install()
        except (ValueError, OSError, subprocess.CalledProcessError) as error:
            sys.exit(str(error))
