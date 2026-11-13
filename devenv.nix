{ pkgs, lib, config, inputs, ... }:

{
  # Development-time Netatmo credentials (probe and fixture scripts only) are declared in
  # secretspec.toml, but devenv does NOT inject them: its secretspec integration is not
  # enabled, so NETATMO_* are not set inside `devenv shell`. Run
  # `secretspec run -- npm run probe` (see README, Development). The shipped plugin never
  # reads them.

  # https://devenv.sh/packages/
  packages = [
    pkgs.git
    pkgs.tsx
    pkgs.osv-scanner # dependency vulnerability + license scanning (npm run scan)
    pkgs.pinact # pin GitHub Actions to full commit SHAs
    pkgs.zizmor # static analysis of the GitHub workflows (supply chain, injection, permissions)
    pkgs.imagemagick # SVG -> PNG and resizing for rendered assets (scripts/render-with-codex.py)
    pkgs.python3 # scripts/render-with-codex.py
  ];

  # https://devenv.sh/languages/
  languages.javascript = {
    enable = true;
    package = pkgs.nodejs_24;
    corepack.enable = true;
    npm = {
      enable = true;
      install.enable = true;
    };
    lsp = {
      enable = true;
      package = pkgs.typescript-language-server;
    };
  };

  languages.typescript.enable = true;

  # https://devenv.sh/processes/
  # processes.dev.exec = "${lib.getExe pkgs.watchexec} -n -- ls -la";

  # https://devenv.sh/services/
  # services.postgres.enable = true;

  enterShell = ''
    echo "Node.js $(node --version) development environment loaded."
  '';

  # https://devenv.sh/tasks/
  # tasks = {
  #   "myproj:setup".exec = "mytool build";
  #   "devenv:enterShell".after = [ "myproj:setup" ];
  # };

  # `devenv test`: the same checks as CI minus the packaging.
  enterTest = ''
    npm run typecheck
    npm test
  '';

  # https://devenv.sh/git-hooks/
  git-hooks.hooks = {
    # Enforce Conventional Commits on the commit message (see CONTRIBUTING.md).
    commitizen.enable = true;
    # Refuse to commit a manifest that carries Nodejs.Debug at all. `npm run
    # watch` adds it for the dev loop; committing that would either ship an open
    # inspector port ("enabled") or a plugin Stream Deck refuses to launch
    # ("disabled"). `npm run build` removes the key.
    forbid-debug-manifest = {
      enable = true;
      name = "forbid committing a manifest with Nodejs.Debug";
      entry = "${pkgs.writeShellScript "forbid-debug-manifest" ''
        manifest=de.schwetschke.sd.home-weather-station.sdPlugin/manifest.json
        if ! git diff --cached --name-only --diff-filter=AM | grep -qxF "$manifest"; then
          exit 0
        fi
        if git show ":$manifest" | ${pkgs.jq}/bin/jq -e 'has("Nodejs") and (.Nodejs | has("Debug"))' >/dev/null; then
          echo "ERROR: refusing to commit $manifest with a Nodejs.Debug key." >&2
          echo "\"enabled\" opens an inspector port in production; \"disabled\" makes" >&2
          echo "Stream Deck refuse to launch the plugin. Run 'npm run build' to remove it." >&2
          exit 1
        fi
      ''}";
      language = "system";
      pass_filenames = false;
      always_run = true;
    };
    # A raw control byte in a .ts source silently turns it into a "binary" file for
    # git: no diff, no review, no blame. It has happened three times in this repo
    # (a NUL in a test fixture string, a NUL used as a separator, a SUB in a
    # terminator literal) and each time the only symptom was "Bin 0 -> N bytes" in
    # the commit stat, which is easy to miss. A unicode escape is always
    # available, so there is never a reason to embed the raw byte.
    # The same hook also rejects invisible Unicode format characters (bidirectional
    # overrides and isolates, zero-width characters, the byte order mark inside a file):
    # "Trojan Source" makes code read differently from what it executes, and a zero-width
    # character in a literal is invisible in review. Write them as \u escapes.
    forbid-control-bytes = {
      enable = true;
      name = "forbid raw control bytes in sources";
      # Python, not grep: `grep -qP '[\x00-\x08…]'` silently fails to match a NUL
      # (the pattern reaches PCRE as a C string), so the first version of this hook
      # passed the very file it was written to catch. Verified by probe in both
      # directions — a file with a NUL is rejected, a clean one is not.
      entry = "${pkgs.writeShellScript "forbid-control-bytes" ''
        exec ${pkgs.python3}/bin/python3 - "$@" <<'PY'
        import re, subprocess, sys
        # U+061C, U+200B-U+200F, U+2028/2029, U+202A-U+202E, U+2060-U+2069, U+FEFF
        INVISIBLE = re.compile("[\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2069\ufeff]")
        LEGAL = {0x09, 0x0a, 0x0d}  # tab, LF, CR
        EXT = (".ts", ".js", ".json", ".md", ".html", ".css", ".nix", ".yaml", ".yml")
        names = subprocess.run(["git", "diff", "--cached", "--name-only", "--diff-filter=AM"],
                               capture_output=True, text=True, check=True).stdout.split()
        status = 0
        for name in (n for n in names if n.endswith(EXT)):
            blob = subprocess.run(["git", "show", f":{name}"], capture_output=True, check=True).stdout
            offenders = sorted({b for b in blob if b < 0x20 and b not in LEGAL} | ({0x7f} if 0x7f in blob else set()))
            hidden = INVISIBLE.search(blob.decode("utf-8", errors="replace"))
            if hidden:
                line = blob.decode("utf-8", errors="replace")[:hidden.start()].count("\n") + 1
                print(f"ERROR: {name}:{line} contains the invisible or bidirectional character "
                      f"U+{ord(hidden.group()):04X}.", file=sys.stderr)
                print("       Write it as a \\u escape instead.", file=sys.stderr)
                status = 1
            if offenders:
                where = blob.find(bytes([offenders[0]]))
                line = blob[:where].count(b"\n") + 1
                print(f"ERROR: {name}:{line} contains raw control byte(s) "
                      f"{', '.join(hex(b) for b in offenders)}; git will treat the file as binary.",
                      file=sys.stderr)
                print("       Write them as unicode escapes instead.", file=sys.stderr)
                status = 1
        sys.exit(status)
        PY
      ''}";
      language = "system";
      pass_filenames = false;
      always_run = true;
    };
    # Block secrets from being committed (pre-commit). gitleaks' default rules plus the narrow
    # allowlist in .gitleaks.toml for the fake sentinel secrets of two tests (without --config
    # the hook flags those sentinels), PLUS the real values from the local git-ignored
    # .env.local (secretspec's dotenv file), in raw, URL-encoded, base64 and JSON spellings:
    # scripts/gitleaks-local-secrets.py turns them into temporary rules, never prints them and
    # deletes the temporary config. Without .env.local only the generic rules run.
    gitleaks = {
      enable = true;
      name = "gitleaks (secret scan, incl. local secret values)";
      entry = "env GITLEAKS_BIN=${pkgs.gitleaks}/bin/gitleaks ${pkgs.python3}/bin/python3 -I scripts/gitleaks-local-secrets.py --staged";
      # devenv's built-in gitleaks hook passes its own arguments ("git --pre-commit --redact
      # --verbose"); the wrapper takes none of them, so they must be emptied.
      args = [ ];
      language = "system";
      pass_filenames = false;
    };
    # Same scan over the whole history before pushing (pre-push): a secret committed earlier and
    # "removed" in a later commit is still published by a push.
    gitleaks-history = {
      enable = true;
      name = "gitleaks (history, incl. local secret values)";
      entry = "env GITLEAKS_BIN=${pkgs.gitleaks}/bin/gitleaks ${pkgs.python3}/bin/python3 -I scripts/gitleaks-local-secrets.py --history";
      args = [ ];
      language = "system";
      pass_filenames = false;
      always_run = true;
      stages = [ "pre-push" ];
    };
    # Scan dependencies for known vulnerabilities before pushing (pre-push).
    osv-scanner = {
      enable = true;
      name = "osv-scanner (dependency vulnerabilities)";
      entry = "${pkgs.osv-scanner}/bin/osv-scanner scan source --config=osv-scanner.toml --lockfile=package-lock.json";
      language = "system";
      pass_filenames = false;
      stages = [ "pre-push" ];
    };
  };

  # See full reference at https://devenv.sh/reference/options/
}
