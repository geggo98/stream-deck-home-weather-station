#!/usr/bin/env python3
"""gitleaks with the REAL secret values of this machine added as rules.

usage: gitleaks-local-secrets.py (--staged | --history | --calibrate) [--env-file PATH] [--repo PATH]

gitleaks' generic rules find secrets by shape and context. A bare refresh token pasted into a
test file has neither, so it would pass. This wrapper reads the values from the local, git-ignored
dotenv file that `secretspec` uses for development (default: <repo>/.env.local), turns each value
(and its URL-encoded, form-encoded, base64, base64url and JSON-escaped spellings) into a temporary
gitleaks rule next to the project's .gitleaks.toml, and runs gitleaks with that config:

  --staged     what is about to be committed (the pre-commit hook in devenv.nix)
  --history    every commit reachable from any ref (run it before publishing)
  --calibrate  rewrite .gitleaks-shapes.json from the values of the dotenv file (see below)

Two layers, because the exact values go stale: a refresh token ROTATES on every use, so a value that
was in .env.local an hour ago is already dead and its successor is a different string.
  1. Exact values (this machine only): the current values and their spellings.
  2. Shapes (committed, also used in CI): .gitleaks-shapes.json describes what the project's secrets
     LOOK like - character class and length of each part, the separators between them, and a
     minimum Shannon entropy - calibrated on the real values by --calibrate. Any new string of that
     shape with that much entropy is reported, wherever it appears and whatever surrounds it. The
     file holds no value: only classes, lengths and thresholds. Fixed-size identifiers (hex) must
     match the measured length exactly; other classes get +-10 %. The entropy threshold is the
     measured value minus 0.5 bit per character (random hex of that length varies by about 0.17,
     so real tokens are not missed, while placeholders such as repeated characters fall below).
     Values shorter than 16 characters are not calibrated on (too many false positives).
     A shape match must stand alone: a longer run of the same characters (a 40-digit commit hash
     around a 24-digit shape) is not a match. A separator also matches percent-encoded (%7C). Lock files and the vendored bundle are exempt
     (base64 digests there look like random alphanumerics). So is every line that holds a
     `sha256-`, `sha384-` or `sha512-` prefixed base64 string (CSP and SRI hashes).

  Known limits of the shapes (they are statistics, not proof):
    * False positive: a standalone 24-hex string that is not a secret (a Mongo-style object id, a
      trace id) matches a shape calibrated on a 24-hex client id. Treat such a hit as "an id or
      personal data", not necessarily as the client secret. A fake sample in a test goes into the
      `allow` list of .gitleaks-shapes.json (one path AND one regex, with a reason).
    * False positive: a long alphanumeric string without the sha prefix (a hash in a minified file) matches
      the alphanumeric shape; the exemption for paths and for `shaNNN-` lines does not cover it.
    * False negative: hex is calibrated in lower case only. The same client id written in
      UPPER-CASE hex is not reported by the shape (the exact value of this machine still is).
    * The `shaNNN-` exemption is per line: a real secret on the very same line as an SRI hash is not reported by the shapes.

The values never appear on a command line, in the output or in a file that outlives the run:
the temporary config lives in a 0700 directory, is written 0600 and is deleted in `finally`
(also after SIGTERM and SIGHUP, which are turned into a normal exit with status 128+signal;
SIGKILL cannot be caught and leaves the file behind, in a 0700 directory);
gitleaks runs with --redact. The output names the variable and the spelling, never the value.
Without the dotenv file only the generic rules run (stated on stderr). Exit code: gitleaks' own
(0 clean, 1 leaks found), 2 for usage errors, 3 when gitleaks cannot be started.
Python standard library only. gitleaks comes from $GITLEAKS_BIN or PATH.
"""

import argparse
import base64
import collections
import json
import os
import pathlib
import re
import shutil
import signal
import string
import subprocess
import sys
import math
import tempfile
import urllib.parse

MIN_LENGTH = 8  # exact values: shorter would match innocent text everywhere
SHAPE_MIN_LENGTH = 16  # shapes: shorter values are not calibrated on
ENTROPY_MARGIN = 0.5  # bits per character below the measured value
ENTROPY_FLOOR = 2.8  # never accept a threshold below this: runs of one or two characters must not match
SHAPES_FILE = ".gitleaks-shapes.json"
CHARSETS = {"hex-lower": "0-9a-f", "hex-upper": "0-9A-F", "alnum": "0-9A-Za-z"}
# base64 digests in these files look like random alphanumerics; tracked secrets do not live there
CHARSET_CHARS = {
	"hex-lower": "0123456789abcdef",
	"hex-upper": "0123456789ABCDEF",
	"alnum": string.digits + string.ascii_uppercase + string.ascii_lowercase,
}
SHAPE_EXEMPT_PATHS = [r"package-lock\.json$", r"devenv\.lock$", r"ui/vendor/", r"\.map$"]
# CSP hashes ('sha256-<base64>') and SRI attributes (integrity="sha384-<base64>") look like random
# alphanumerics too. Exempts the whole LINE (regexTarget = "line") in which such a string stands.
SHAPE_EXEMPT_LINE = r"sha(?:256|384|512)-[A-Za-z0-9+/_-]{40,}={0,2}"


def parse_dotenv(path: pathlib.Path) -> dict[str, str]:
	values: dict[str, str] = {}
	for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
		line = raw.strip()
		if not line or line.startswith("#") or "=" not in line:
			continue
		if line.startswith("export "):
			line = line[len("export "):].lstrip()
		key, _, value = line.partition("=")
		value = value.strip()
		if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
			value = value[1:-1]
		if key.strip() and len(value) >= MIN_LENGTH:
			values[key.strip()] = value
	return values


def spellings(value: str) -> dict[str, str]:
	"""The ways the same secret can legitimately show up in text. Name -> spelling (deduplicated)."""
	raw = value.encode("utf-8")
	out = {
		"raw": value,
		"url-encoded": urllib.parse.quote(value, safe=""),
		"form-encoded": urllib.parse.quote_plus(value),
		"base64": base64.b64encode(raw).decode(),
		"base64url": base64.urlsafe_b64encode(raw).decode().rstrip("="),
		"json-escaped": json.dumps(value)[1:-1],
	}
	seen: set[str] = set()
	unique: dict[str, str] = {}
	for name, text in out.items():
		if text and text not in seen:
			seen.add(text)
			unique[name] = text
	return unique


def re2_literal(text: str) -> str:
	"""A regular expression (RE2, as used by gitleaks) matching exactly `text`."""
	return "".join(ch if re.fullmatch(r"[A-Za-z0-9_]", ch) else "\\x{%X}" % ord(ch) for ch in text)


def shannon(text: str) -> float:
	counts = collections.Counter(text)
	n = len(text)
	return -sum(c / n * math.log2(c / n) for c in counts.values())


def classify(part: str) -> str | None:
	if re.fullmatch(r"[0-9a-f]+", part) and re.search(r"[0-9]", part) and re.search(r"[a-f]", part):
		return "hex-lower"
	if re.fullmatch(r"[0-9A-F]+", part) and re.search(r"[0-9]", part) and re.search(r"[A-F]", part):
		return "hex-upper"
	if re.fullmatch(r"[0-9A-Za-z]+", part):
		return "alnum"
	return None


def derive_shape(name: str, value: str) -> dict | None:
	"""The shape of one secret value, or None if it is too short or built from unsupported characters."""
	if len(value) < SHAPE_MIN_LENGTH:
		return None
	pieces = re.split(r"([^0-9A-Za-z])", value)
	parts: list[dict] = []
	separators: list[str] = []
	for piece in pieces:
		if piece == "":
			continue
		if re.fullmatch(r"[^0-9A-Za-z]", piece):
			separators.append(piece)
			continue
		charset = classify(piece)
		if charset is None:
			return None
		fixed = charset.startswith("hex")
		slack = 0 if fixed else max(2, round(len(piece) * 0.1))
		parts.append({"charset": charset, "min": len(piece) - slack, "max": len(piece) + slack})
	if not parts or len(separators) != len(parts) - 1:
		return None  # a leading, trailing or doubled separator: not a token shape we model
	entropy = max(ENTROPY_FLOOR, round(shannon(value) - ENTROPY_MARGIN, 2))
	return {"name": name, "parts": parts, "separators": separators, "minEntropy": entropy}


def calibrate(values: dict[str, str], allow: list[dict] | None = None) -> dict:
	shapes = [shape for name, value in sorted(values.items()) if (shape := derive_shape(name, value))]
	return {
		"version": 1,
		"note": "Shapes of the project's secrets: character class and length per part, separators and a minimum "
		"Shannon entropy. NO value is stored. Regenerate with `npm run scan:calibrate` after a secret changes its format. "
		"`allow` entries (kept by --calibrate) exempt ONE obviously fake sample in ONE file; each needs a reason. "
		"Known limits: a standalone 24-hex string (an object id) matches a 24-hex shape; hex is calibrated in lower case only, "
		"so the same id in upper case is not reported; lines with a sha256-/sha384-/sha512- hash are exempt.",
		"shapes": shapes,
		"allow": allow or [],
	}


def shape_regex(shape: dict) -> str:
	body = ""
	for i, part in enumerate(shape["parts"]):
		if i:
			sep = shape["separators"][i - 1]
			code = "%02X" % ord(sep)
			# a separator may also appear percent-encoded (a token inside a URL: %7C for the pipe)
			body += f"(?:{re2_literal(sep)}|%{code}|%{code.lower()})"
		span = f"{{{part['min']}}}" if part["min"] == part["max"] else f"{{{part['min']},{part['max']}}}"
		body += f"[{CHARSETS[part['charset']]}]{span}"
	# the match must stand alone: not a piece of a longer alphanumeric run
	return f"(?:^|[^0-9A-Za-z])({body})(?:[^0-9A-Za-z]|$)"


def max_entropy(shape: dict) -> float:
	"""The highest Shannon entropy a string of this shape can reach: bounded by its alphabet and by its length."""
	alphabet: set[str] = set(shape["separators"])
	for part in shape["parts"]:
		alphabet |= set(CHARSET_CHARS[part["charset"]])
	length = sum(p["max"] for p in shape["parts"]) + len(shape["separators"])
	return math.log2(min(len(alphabet), length))


def load_profile(path: pathlib.Path) -> dict:
	if not path.is_file():
		return {"shapes": [], "allow": []}
	data = json.loads(path.read_text(encoding="utf-8"))
	for shape in data.get("shapes", []):
		assert shape["minEntropy"] >= ENTROPY_FLOOR and all(p["charset"] in CHARSETS for p in shape["parts"]), "invalid shape profile"
		ceiling = max_entropy(shape)
		if shape["minEntropy"] > ceiling:
			raise SystemExit(f"invalid shape profile: {shape['name']} needs entropy >= {shape['minEntropy']}, but no string of that shape can have more than {ceiling:.2f}: the shape would never match")
	for entry in data.get("allow", []):
		assert entry.get("path") and entry.get("regex") and entry.get("reason"), "an allow entry needs path, regex and reason"
	return {"shapes": data.get("shapes", []), "allow": data.get("allow", [])}


def shape_rules(shapes: list[dict], allow: list[dict] | None = None) -> list[str]:
	lines: list[str] = []
	exempt = ", ".join(f"'''{p}'''" for p in SHAPE_EXEMPT_PATHS)
	for shape in shapes:
		safe = re.sub(r"[^A-Za-z0-9_-]", "_", shape["name"])
		regex = shape_regex(shape)
		assert "'''" not in regex
		lines += [
			"[[rules]]",
			f'id = "secret-shape-{safe}"',
			f'description = "A string shaped like {safe}: same character classes, lengths and separators, entropy >= {shape["minEntropy"]}"',
			f"regex = '''{regex}'''",
			"secretGroup = 1",
			f"entropy = {shape['minEntropy']}",
			"[[rules.allowlists]]",
			f"paths = [{exempt}]",
			"[[rules.allowlists]]",
			'regexTarget = "line"',
			f"regexes = ['''{SHAPE_EXEMPT_LINE}''']",
		]
		for entry in allow or []:  # each entry needs BOTH its path and its regex to apply
			lines += [
				"[[rules.allowlists]]",
				'condition = "AND"',
				f"paths = [\'\'\'{entry['path']}\'\'\']",
				f"regexes = [\'\'\'{entry['regex']}\'\'\']",
			]
		lines.append("")
	return lines


def build_config(base_config: pathlib.Path | None, secrets: dict[str, str], shapes: list[dict] | None = None, allow: list[dict] | None = None) -> tuple[str, int]:
	lines: list[str] = []
	if base_config is not None:
		lines += ["[extend]", f'path = "{base_config.as_posix()}"', ""]
	count = 0
	lines += shape_rules(shapes or [], allow)
	count += len(shapes or [])
	for var, value in secrets.items():
		safe_var = re.sub(r"[^A-Za-z0-9_-]", "_", var)
		for name, text in spellings(value).items():
			regex = re2_literal(text)
			assert "'''" not in regex
			lines += [
				"[[rules]]",
				f'id = "local-secret-{safe_var}-{name}"',
				f'description = "The value of {safe_var} from the local dotenv file ({name} spelling)"',
				f"regex = '''{regex}'''",
				"",
			]
			count += 1
	return "\n".join(lines), count


def main() -> int:
	parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
	mode = parser.add_mutually_exclusive_group(required=True)
	mode.add_argument("--staged", action="store_true")
	mode.add_argument("--history", action="store_true")
	mode.add_argument("--calibrate", action="store_true")
	parser.add_argument("--env-file")
	parser.add_argument("--repo", default=".")
	args, extra = parser.parse_known_args()  # anything else goes to gitleaks (for example --report-path)

	repo = pathlib.Path(args.repo).resolve()
	env_file = pathlib.Path(args.env_file) if args.env_file else repo / ".env.local"
	if args.calibrate:
		if not env_file.is_file():
			print(f"cannot calibrate: {env_file} does not exist", file=sys.stderr)
			return 2
		profile = calibrate(parse_dotenv(env_file), load_profile(repo / SHAPES_FILE)["allow"])
		(repo / SHAPES_FILE).write_text(json.dumps(profile, indent=2) + "\n", encoding="utf-8")
		for shape in profile["shapes"]:
			desc = " ".join(f"{p['charset']}x{p['min']}" + (f"-{p['max']}" if p["max"] != p["min"] else "") for p in shape["parts"])
			print(f"calibrated {shape['name']}: {desc}, separators {shape['separators']!r}, min entropy {shape['minEntropy']}", file=sys.stderr)
		print(f"wrote {SHAPES_FILE} with {len(profile['shapes'])} shape(s); no value is stored in it", file=sys.stderr)
		return 0
	gitleaks = os.environ.get("GITLEAKS_BIN") or shutil.which("gitleaks")
	if not gitleaks:
		print("gitleaks not found: set GITLEAKS_BIN or enter `devenv shell`", file=sys.stderr)
		return 3

	secrets: dict[str, str] = {}
	if env_file.is_file():
		secrets = parse_dotenv(env_file)
	base = repo / ".gitleaks.toml"
	base_config = base if base.is_file() else None
	profile = load_profile(repo / SHAPES_FILE)
	shapes, allow = profile["shapes"], profile["allow"]

	def terminate(signum: int, _frame: object) -> None:
		raise SystemExit(128 + signum)  # unwinds through `finally`, which removes the temporary config

	for sig in (signal.SIGTERM, signal.SIGHUP):
		signal.signal(sig, terminate)
	tmp = pathlib.Path(tempfile.mkdtemp(prefix="gitleaks-local-"))
	try:
		os.chmod(tmp, 0o700)
		config_path = tmp / "config.toml"
		text, rules = build_config(base_config, secrets, shapes, allow)
		fd = os.open(config_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
		with os.fdopen(fd, "w") as handle:
			handle.write(text)
		print(f"gitleaks-local-secrets: {len(shapes)} secret shape(s) from {SHAPES_FILE}", file=sys.stderr)
		if secrets:
			print(f"gitleaks-local-secrets: {len(secrets)} local value(s) from {env_file.name}; {rules} extra rule(s) in total", file=sys.stderr)
		else:
			print(f"gitleaks-local-secrets: no usable values in {env_file} - exact values not checked, only the shapes and the generic rules run", file=sys.stderr)
		cmd = [gitleaks, "git", "--no-banner", "--redact", "--config", str(config_path)]
		if args.staged:
			cmd.append("--staged")
		cmd += extra
		cmd.append(str(repo))
		try:
			return subprocess.run(cmd, cwd=repo).returncode
		except OSError as error:
			print(f"cannot start gitleaks: {error.strerror}", file=sys.stderr)
			return 3
	finally:
		shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
	sys.exit(main())
