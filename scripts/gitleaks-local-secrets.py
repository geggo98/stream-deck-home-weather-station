#!/usr/bin/env python3
"""gitleaks with the REAL secret values of this machine added as rules.

usage: gitleaks-local-secrets.py (--staged | --history) [--env-file PATH] [--repo PATH]

gitleaks' generic rules find secrets by shape and context. A bare refresh token pasted into a
test file has neither, so it would pass. This wrapper reads the values from the local, git-ignored
dotenv file that `secretspec` uses for development (default: <repo>/.env.local), turns each value
(and its URL-encoded, form-encoded, base64, base64url and JSON-escaped spellings) into a temporary
gitleaks rule next to the project's .gitleaks.toml, and runs gitleaks with that config:

  --staged   what is about to be committed (the pre-commit hook in devenv.nix)
  --history  every commit reachable from any ref (run it before publishing)

The values never appear on a command line, in the output or in a file that outlives the run:
the temporary config lives in a 0700 directory, is written 0600 and is deleted in `finally`;
gitleaks runs with --redact. The output names the variable and the spelling, never the value.
Without the dotenv file only the generic rules run (stated on stderr). Exit code: gitleaks' own
(0 clean, 1 leaks found), 2 for usage errors, 3 when gitleaks cannot be started.
Python standard library only. gitleaks comes from $GITLEAKS_BIN or PATH.
"""

import argparse
import base64
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.parse

MIN_LENGTH = 8  # shorter values would match innocent text everywhere


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


def build_config(base_config: pathlib.Path | None, secrets: dict[str, str]) -> tuple[str, int]:
	lines: list[str] = []
	if base_config is not None:
		lines += ["[extend]", f'path = "{base_config.as_posix()}"', ""]
	count = 0
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
	parser.add_argument("--env-file")
	parser.add_argument("--repo", default=".")
	args = parser.parse_args()

	repo = pathlib.Path(args.repo).resolve()
	env_file = pathlib.Path(args.env_file) if args.env_file else repo / ".env.local"
	gitleaks = os.environ.get("GITLEAKS_BIN") or shutil.which("gitleaks")
	if not gitleaks:
		print("gitleaks not found: set GITLEAKS_BIN or enter `devenv shell`", file=sys.stderr)
		return 3

	secrets: dict[str, str] = {}
	if env_file.is_file():
		secrets = parse_dotenv(env_file)
	base = repo / ".gitleaks.toml"
	base_config = base if base.is_file() else None

	tmp = pathlib.Path(tempfile.mkdtemp(prefix="gitleaks-local-"))
	try:
		os.chmod(tmp, 0o700)
		config_path = tmp / "config.toml"
		text, rules = build_config(base_config, secrets)
		fd = os.open(config_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
		with os.fdopen(fd, "w") as handle:
			handle.write(text)
		if secrets:
			print(f"gitleaks-local-secrets: {len(secrets)} local value(s) from {env_file.name} -> {rules} extra rule(s)", file=sys.stderr)
		else:
			print(f"gitleaks-local-secrets: no usable values in {env_file} - only the generic rules run", file=sys.stderr)
		cmd = [gitleaks, "git", "--no-banner", "--redact", "--config", str(config_path)]
		if args.staged:
			cmd.append("--staged")
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
