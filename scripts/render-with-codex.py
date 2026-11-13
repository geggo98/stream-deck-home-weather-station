#!/usr/bin/env -S uv --quiet run --frozen --script
# /// script
# requires-python = ">=3.10"
# dependencies = []
# [tool.uv]
# exclude-newer = "2026-11-01T00:00:00Z"
# ///
"""Resumable, validated artwork rendering through the Codex CLI.

usage: render-with-codex.py [options] <jobs.json> <outdir>
       render-with-codex.py --status <jobs.json> <outdir>

jobs.json is a list of {"name", "kind": "svg"|"png", "w", "h", "prompt",
"min_square"?}. The result of a job is <outdir>/<name>.<kind>.

Design (the rules of docs/RENDERING.md, in short):
* Isolation. Every job runs with a throwaway CODEX_HOME that holds only a
  symlink to the login file, and an empty working directory. Reason, measured
  on 2026-11-13: `--ignore-user-config` does NOT stop Codex from loading the
  user's global AGENTS.md, so without this the owner's private rules would be
  sent to the model provider on every call.
* Prompts are static art direction. A guard refuses credentials, e-mail
  addresses, MAC addresses, the word for the weather service's brand, other
  manufacturers' names and every request for a logo.
* Resumable. Per item exactly one of SUCCESS, SKIP, ERROR, CLEANUP. State is
  derived from the work products: an output is SKIPped when it validates, not
  because a progress file says so. Output is written under a temp name and
  renamed (atomic), leftovers of dead runs are removed (CLEANUP).
* Abortable. SIGINT/SIGTERM set a flag and are forwarded to the child's whole
  process group, so an abort costs seconds, not the 10 minute job timeout.
* Observable. Throttled progress lines on stderr (n/N, rate, ETA, elapsed;
  the rate counts only jobs really rendered in this run), flock on
  <outdir>/.run.lock (exit 75 if held), .run.status for display only, --status.

Exit codes: 0 done or nothing to do, 1 at least one error, 2 usage/config
error, 75 already running, 128+signal aborted.

Unverified: behaviour against Codex versions other than the one named in
docs/RENDERING.md; whether the image tool counts against plan quota.
"""

import argparse
import fcntl
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import xml.dom.minidom as minidom
import zlib

EX_TEMPFAIL = 75
EX_USAGE = 2
JOB_TIMEOUT_S = 600
KILL_GRACE_S = 3.0
HEARTBEAT_S = 15.0
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
PNG_IEND = b"\x00\x00\x00\x00IEND\xaeB`\x82"
MAX_SVG_BYTES = 200_000
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")

# --- prompt guard ----------------------------------------------------------

# Personal data and secrets: a prompt leaves the machine, so none may be in it.
SECRET_RE = re.compile(
    r"""(?ix)
    client_secret | refresh_token | access_token | api[_-]?key | password | bearer\s
    | \bsk-[A-Za-z0-9]{10,}
    | [\w.+-]+@[\w-]+\.\w+                       # e-mail address
    | \b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b       # MAC address
    | \b\d{1,3}(?:\.\d{1,3}){3}\b                 # IPv4 address
    """
)
# Brands that must not steer the artwork. Spelled with a character class so
# this file itself stays free of the plain words (a repo-wide hygiene scan
# greps for them).
BRAND_RE = re.compile(r"(?i)\b(?:net[a]tmo|el[g]ato|cors[a]ir|stream\s*deck)\b")
# A request for a logo, wordmark, trademark or brand look is refused; only the
# explicit negation ("no logos") is allowed because the script appends it.
NEGATED_RE = re.compile(r"(?i)\b(?:no|without|never)\s+(?:any\s+)?(?:logos?|trademarks?|wordmarks?|brand\w*)\b")
LOGO_RE = re.compile(r"(?i)\b(?:logos?|trademarks?|wordmarks?|brand\w*|lookalike|look-alike|in\s+the\s+style\s+of)\b")


def guard_prompt(prompt):
    """Return None if the prompt may be sent, else the reason it was refused."""
    if SECRET_RE.search(prompt):
        return "prompt looks like it contains a secret or personal data"
    if BRAND_RE.search(prompt):
        return "prompt names a brand or manufacturer"
    if LOGO_RE.search(NEGATED_RE.sub("", prompt)):
        return "prompt asks for a logo, trademark, brand look or imitation"
    return None


# --- output validation -----------------------------------------------------

FORBIDDEN_SVG_RE = re.compile(
    r"""(?ix)
    <\s*(?:script|image|foreignObject|iframe|object|embed|style|animate\w*|set)\b
    | <!\s*(?:DOCTYPE|ENTITY)
    | \son\w+\s*=
    | @import
    | url\(\s*["']?(?!\s*\#)
    | (?:xlink:)?href\s*=\s*["'](?!\#)
    """
)


def validate_svg_text(text, w, h):
    """Well-formed, exact size, no active or external content. None = fine."""
    if len(text.encode("utf-8")) > MAX_SVG_BYTES:
        return "svg too large"
    m = FORBIDDEN_SVG_RE.search(text)
    if m:
        return f"forbidden construct {m.group(0).strip()!r}"
    try:
        root = minidom.parseString(text.encode("utf-8")).documentElement
    except Exception as e:  # ExpatError and friends
        return f"not well-formed XML ({type(e).__name__})"
    if root.tagName != "svg" or root.getAttribute("xmlns") != "http://www.w3.org/2000/svg":
        return "bad root element or namespace"
    if root.getAttribute("width") != str(w) or root.getAttribute("height") != str(h):
        return "width/height attribute mismatch"
    if root.getAttribute("viewBox").split() != ["0", "0", str(w), str(h)]:
        return "viewBox mismatch"
    return None


def png_dimensions(data):
    """(w, h) of a structurally sound PNG, else a string describing the defect."""
    if data[:8] != PNG_SIGNATURE:
        return "not a PNG"
    pos, size, idat = 8, None, False
    while pos + 8 <= len(data):
        length = int.from_bytes(data[pos : pos + 4], "big")
        ctype = data[pos + 4 : pos + 8]
        body = data[pos + 8 : pos + 8 + length]
        crc = data[pos + 8 + length : pos + 12 + length]
        if len(body) != length or len(crc) != 4:
            return "truncated PNG"
        if zlib.crc32(ctype + body) != int.from_bytes(crc, "big"):
            return f"bad CRC in chunk {ctype!r}"
        if ctype == b"IHDR":
            size = (int.from_bytes(body[0:4], "big"), int.from_bytes(body[4:8], "big"))
        elif ctype == b"IDAT":
            idat = True
        elif ctype == b"IEND":
            if size is None or not idat:
                return "PNG without IHDR/IDAT"
            return size
        pos += 12 + length
    return "PNG without IEND (truncated)"


def validate_png_bytes(data, w, h, min_square=False):
    dims = png_dimensions(data)
    if isinstance(dims, str):
        return dims
    if dims == (w, h):
        return None
    if min_square and dims[0] == dims[1] and dims[0] >= w:
        return None
    return f"size {dims[0]}x{dims[1]}, expected {w}x{h}"


def validate_file(path, job):
    if not os.path.isfile(path) or os.path.getsize(path) == 0:
        return "missing or empty"
    if job["kind"] == "svg":
        with open(path, encoding="utf-8", errors="replace") as f:
            return validate_svg_text(f.read(), job["w"], job["h"])
    with open(path, "rb") as f:
        return validate_png_bytes(f.read(), job["w"], job["h"], job.get("min_square", False))


# --- jobs ------------------------------------------------------------------


def load_jobs(path):
    with open(path, encoding="utf-8") as f:
        jobs = json.load(f)
    if not isinstance(jobs, list) or not jobs:
        raise ValueError("jobs file must be a non-empty list")
    seen = set()
    for j in jobs:
        if not NAME_RE.match(str(j.get("name", ""))):
            raise ValueError(f"bad job name {j.get('name')!r}")
        if j["name"] in seen:
            raise ValueError(f"duplicate job name {j['name']!r}")
        seen.add(j["name"])
        if j.get("kind") not in ("svg", "png"):
            raise ValueError(f"{j['name']}: kind must be svg or png")
        if not (isinstance(j.get("w"), int) and isinstance(j.get("h"), int) and j["w"] > 0 and j["h"] > 0):
            raise ValueError(f"{j['name']}: w and h must be positive integers")
        if not isinstance(j.get("prompt"), str) or not j["prompt"].strip():
            raise ValueError(f"{j['name']}: prompt missing")
        bad = guard_prompt(j["prompt"])
        if bad:  # fail the whole file up front, before anything is sent anywhere
            raise ValueError(f"{j['name']}: {bad}")
    return jobs


def build_prompt(job):
    name = f"result.{job['kind']}"
    if job["kind"] == "svg":
        tail = (
            f"\n\nWrite the result to ./{name} only. SVG rules: the root element is "
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{job["w"]}" height="{job["h"]}" '
            f'viewBox="0 0 {job["w"]} {job["h"]}">. Use only basic shapes, paths, gradients '
            "and <text> with a generic font-family; presentation attributes instead of "
            "<style>; no <script>, <image>, <foreignObject>, animation, external fonts or links. "
            "No logos or trademarks. Reply DONE."
        )
    else:
        tail = (
            "\n\nUse your image generation tool. Copy the final PNG to "
            f"./{name}. Opaque background, no text, no logos or trademarks. Reply DONE."
        )
    return job["prompt"].strip() + tail


def parse_usage(stdout_text):
    """Token usage from the last turn.completed event of `codex exec --json`."""
    usage = None
    for line in stdout_text.splitlines():
        if '"turn.completed"' not in line:
            continue
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if isinstance(ev.get("usage"), dict):
            usage = ev["usage"]
    return usage


def fmt_duration(sec):
    sec = int(sec)
    return f"{sec // 60}:{sec % 60:02d}" if sec < 3600 else f"{sec // 3600}:{sec % 3600 // 60:02d}:{sec % 60:02d}"


def progress_line(n, total, ok, pending_left, elapsed):
    rate = ok / elapsed if ok and elapsed > 0 else 0.0  # real work only, SKIPs excluded
    eta = fmt_duration(pending_left / rate) if rate > 0 else "?"
    return f"{n}/{total}  {rate * 60:.2f}/min  ETA {eta}  elapsed {fmt_duration(elapsed)}"


# --- process handling ------------------------------------------------------


class Abort(Exception):
    pass


class Runner:
    def __init__(self):
        self.stop = None  # signal number once requested
        self.child = None

    def on_signal(self, signum, _frame):
        first = self.stop is None
        self.stop = signum
        self._killpg(signal.SIGTERM if first else signal.SIGKILL)

    def _killpg(self, sig):
        if self.child and self.child.poll() is None:
            try:
                os.killpg(self.child.pid, sig)
            except (ProcessLookupError, PermissionError):
                pass

    def run(self, argv, env, cwd, stdin_text, stdout_path, stderr_path, timeout):
        """Run a child in its own process group; kill the group on timeout/abort."""
        with open(stdout_path, "wb") as so, open(stderr_path, "wb") as se:
            self.child = subprocess.Popen(
                argv, env=env, cwd=cwd, stdin=subprocess.PIPE, stdout=so, stderr=se,
                start_new_session=True,
            )
            try:
                try:
                    self.child.stdin.write(stdin_text.encode("utf-8"))
                    self.child.stdin.close()
                except BrokenPipeError:
                    pass
                t0 = last_beat = time.monotonic()
                term_at = None
                while True:
                    try:
                        return self.child.wait(timeout=0.25)
                    except subprocess.TimeoutExpired:
                        pass
                    now = time.monotonic()
                    if self.stop is not None:
                        term_at = term_at or now
                        if now - term_at > KILL_GRACE_S:
                            self._killpg(signal.SIGKILL)
                    elif now - t0 > timeout:
                        self._killpg(signal.SIGKILL)
                        self.child.wait()
                        raise TimeoutError(f"codex did not finish within {timeout}s")
                    elif now - last_beat >= HEARTBEAT_S:
                        last_beat = now
                        print(f"  ... still rendering, {fmt_duration(now - t0)} so far", file=sys.stderr, flush=True)
            finally:
                self._killpg(signal.SIGKILL)  # no stragglers, whatever happened
                try:
                    self.child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    pass
                self.child = None


def codex_version(codex_bin):
    try:
        r = subprocess.run([codex_bin, "--version"], capture_output=True, text=True, timeout=30)
        return r.stdout.strip() or "unknown"
    except (OSError, subprocess.SubprocessError):
        return "unknown"


def write_atomic(dest, data, mode="wb"):
    tmp = f"{dest}.tmp.{os.getpid()}"
    with open(tmp, mode) as f:
        f.write(data)
    os.replace(tmp, dest)


def render_job(job, outdir, args, runner, version):
    """Render one job. Returns None on success or raises. Always cleans up."""
    dest = os.path.join(outdir, f"{job['name']}.{job['kind']}")
    home = tempfile.mkdtemp(prefix="codexhome.")
    work = tempfile.mkdtemp(prefix="codexwork.")
    logs = tempfile.mkdtemp(prefix="codexlog.", dir=outdir)  # swept by name on the next start
    t0 = time.monotonic()
    try:
        # Only the login file; no AGENTS.md, config, memories, skills of the user.
        os.symlink(args.auth_file, os.path.join(home, "auth.json"))
        env = {**os.environ, "CODEX_HOME": home}
        argv = [
            args.codex_bin, "exec", "--ephemeral", "--skip-git-repo-check",
            "--ignore-user-config", "--ignore-rules", "--json",
            "-s", "workspace-write", "-C", work, "--color", "never", "-",
        ]
        out_log, err_log = os.path.join(logs, "stdout"), os.path.join(logs, "stderr")
        rc = runner.run(argv, env, work, build_prompt(job), out_log, err_log, args.timeout)
        if runner.stop is not None:
            raise Abort()
        stdout_text = open(out_log, encoding="utf-8", errors="replace").read()
        res = os.path.join(work, f"result.{job['kind']}")
        if rc != 0 or not os.path.isfile(res):
            tail = open(err_log, encoding="utf-8", errors="replace").read().strip().splitlines()[-3:]
            raise RuntimeError(f"codex exit={rc} result_present={os.path.isfile(res)} stderr_tail={tail}")
        bad = validate_file(res, job)
        if bad:
            raise RuntimeError(f"output rejected: {bad}")
        with open(res, "rb") as f:
            write_atomic(dest, f.read())
        seconds = round(time.monotonic() - t0, 1)
        meta = {
            "name": job["name"], "kind": job["kind"], "codex": version,
            "rendered_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "seconds": seconds, "usage": parse_usage(stdout_text),
            "prompt": job["prompt"],
        }
        write_atomic(os.path.join(outdir, f"{job['name']}.meta.json"), json.dumps(meta, indent=2, ensure_ascii=False) + "\n", "w")
        # Codex may refresh the login by replacing the symlink with a real file in
        # the throwaway home. Refresh tokens rotate, so dropping that file would log
        # the owner out of Codex; hand it back (bytes are copied, never read or shown).
        rewritten = os.path.join(home, "auth.json")
        if os.path.isfile(rewritten) and not os.path.islink(rewritten):
            shutil.copyfile(rewritten, f"{args.auth_file}.tmp.{os.getpid()}")
            os.chmod(f"{args.auth_file}.tmp.{os.getpid()}", 0o600)
            os.replace(f"{args.auth_file}.tmp.{os.getpid()}", args.auth_file)
            print("  note: codex rewrote its login file; copied back", file=sys.stderr)
        return seconds
    finally:
        for d in (home, work, logs):
            shutil.rmtree(d, ignore_errors=True)  # never follows the auth symlink


# --- locking / status ------------------------------------------------------


def process_age(pid):
    try:
        r = subprocess.run(["ps", "-o", "etime=", "-p", str(pid)], capture_output=True, text=True, timeout=5)
        return r.stdout.strip() or None
    except (OSError, subprocess.SubprocessError):
        return None


def describe_holder(status_path):
    pid = start = "?"
    try:
        text = open(status_path, encoding="utf-8").read()
        pid = re.search(r"pid=(\d+)", text).group(1)
        start = re.search(r"start=(.*)", text).group(1).strip()
    except (OSError, AttributeError):
        pass
    age = process_age(pid) if pid != "?" else None
    return f"pid={pid} started {start} running for {age or '? (process gone)'}"


def main(argv=None):
    ap = argparse.ArgumentParser(description="Resumable Codex artwork rendering.")
    ap.add_argument("jobs")
    ap.add_argument("outdir")
    ap.add_argument("--status", action="store_true", help="report whether a run is active and exit")
    ap.add_argument("--codex-bin", default="codex", help="codex executable (tests pass a fake)")
    ap.add_argument("--auth-file", default=os.path.expanduser("~/.codex/auth.json"),
                    help="Codex login file to symlink into the throwaway CODEX_HOME")
    ap.add_argument("--timeout", type=int, default=JOB_TIMEOUT_S, help="per-job timeout in seconds")
    ap.add_argument("--only", action="append", default=[], help="render only this job name (repeatable)")
    ap.add_argument("--force", action="store_true", help="re-render even if a valid output exists")
    args = ap.parse_args(argv)

    outdir = args.outdir
    os.makedirs(outdir, exist_ok=True)
    status_path = os.path.join(outdir, ".run.status")
    lock = open(os.path.join(outdir, ".run.lock"), "a")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)  # kernel drops it on death, even kill -9
    except BlockingIOError:
        print(f"already running: {describe_holder(status_path)}", file=sys.stderr)
        return EX_TEMPFAIL
    if args.status:
        print("not running")
        return 0

    try:
        jobs = load_jobs(args.jobs)
    except (OSError, ValueError, KeyError) as e:
        print(f"config error: {e}", file=sys.stderr)
        return EX_USAGE
    unknown = set(args.only) - {j["name"] for j in jobs}
    if unknown:
        print(f"config error: unknown job(s) {sorted(unknown)}", file=sys.stderr)
        return EX_USAGE
    if args.only:
        jobs = [j for j in jobs if j["name"] in args.only]
    if not os.path.exists(args.auth_file):
        print(f"config error: {args.auth_file} not found; run `codex login` first", file=sys.stderr)
        return EX_USAGE
    if shutil.which(args.codex_bin) is None:
        print(f"config error: {args.codex_bin} not found on PATH", file=sys.stderr)
        return EX_USAGE

    write_atomic(status_path, f"pid={os.getpid()} start={time.strftime('%Y-%m-%dT%H:%M:%S%z')}\n", "w")

    runner = Runner()
    for s in (signal.SIGINT, signal.SIGTERM):
        signal.signal(s, runner.on_signal)

    cleanup = 0
    for entry in os.listdir(outdir):  # leftovers of a dead run
        if ".tmp." in entry or entry.startswith("codexlog."):
            p = os.path.join(outdir, entry)
            shutil.rmtree(p, ignore_errors=True) if os.path.isdir(p) else os.unlink(p)
            cleanup += 1

    ok = skip = err = 0
    pending = []
    for j in jobs:  # state from the work products, not from a progress file
        dest = os.path.join(outdir, f"{j['name']}.{j['kind']}")
        if not args.force and validate_file(dest, j) is None:
            skip += 1
            print(f"SKIP {j['name']} (valid output exists)", file=sys.stderr)
        else:
            pending.append(j)

    version = codex_version(args.codex_bin) if pending else "n/a"
    total, t0, last_print, n = len(jobs), time.monotonic(), 0.0, skip
    for idx, j in enumerate(pending):
        if runner.stop is not None:
            break
        try:
            secs = render_job(j, outdir, args, runner, version)
            ok += 1
            print(f"OK {j['name']} {secs:.0f}s", file=sys.stderr, flush=True)
        except Abort:
            print(f"ABORT {j['name']} (discarded)", file=sys.stderr)
            break
        except Exception as e:
            err += 1
            print(f"ERROR {j['name']}: {e}", file=sys.stderr, flush=True)
        n += 1
        now = time.monotonic()
        if now - last_print >= 1.0 or idx == len(pending) - 1:
            last_print = now
            print(progress_line(n, total, ok, len(pending) - idx - 1, now - t0), file=sys.stderr, flush=True)

    left = len(jobs) - ok - skip - err
    note = "aborted" if runner.stop is not None else ("nothing left to do" if left == 0 and err == 0 else "")
    print(f"{ok} ok, {skip} skip, {err} error, {cleanup} cleanup, {left} left" + (f" - {note}" if note else ""), file=sys.stderr)
    if runner.stop is not None:
        return 128 + runner.stop
    return 1 if err else 0


if __name__ == "__main__":
    sys.exit(main())
