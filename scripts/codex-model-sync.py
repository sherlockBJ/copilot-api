#!/usr/bin/env python3
"""Synchronize a Responses provider's models into a Codex model catalog.

Requires Python 3.11+ and a Codex CLI supporting `debug models --bundled`.
Only the Python standard library is used. Generated catalogs contain no keys.
"""

import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import tomllib
import urllib.error
import urllib.parse
import urllib.request


class SyncError(Exception):
    pass


EFFORTS = {"none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"}
SHELL_BEGIN = "# >>> codex provider model sync >>>"
SHELL_END = "# <<< codex provider model sync <<<"
MAINTENANCE = {
    "agents", "app", "app-server", "archive", "cloud", "completion", "debug",
    "delete", "doctor", "features", "help", "login", "logout", "mcp",
    "migrate-nfs-db", "migrate-rollouts", "plugin", "queue", "remote-control",
    "unarchive", "update",
}


def native(executable, args):
    result = subprocess.run(
        [executable, *args], capture_output=True, text=True, timeout=30,
    )
    if result.returncode:
        raise SyncError("Codex rejected the catalog or configuration: " + result.stderr.strip())
    return json.loads(result.stdout)


def provider_settings(config):
    provider_id = config.get("model_provider", "openai")
    provider = config.get("model_providers", {}).get(provider_id, {})
    if not provider.get("base_url"):
        raise SyncError("The selected custom provider must have a base_url.")
    if provider.get("wire_api", "responses") != "responses":
        raise SyncError("This synchronizer requires wire_api = \"responses\".")
    url = provider["base_url"].rstrip("/") + "/models"
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in {"http", "https"} or parts.username or parts.password:
        raise SyncError("Provider base_url must be an HTTP(S) URL without embedded credentials.")
    if parts.query or parts.fragment:
        raise SyncError("Put provider URL parameters in query_params, not base_url.")
    headers = {"Accept": "application/json", **provider.get("http_headers", {})}
    if key_name := provider.get("env_key"):
        if not (key := os.environ.get(key_name)):
            raise SyncError(f"Provider credential environment variable {key_name} is missing.")
        headers["Authorization"] = "Bearer " + key
    for header, variable in provider.get("env_http_headers", {}).items():
        if not (value := os.environ.get(variable)):
            raise SyncError(f"Provider header environment variable {variable} is missing.")
        headers[header] = value
    params = provider.get("query_params", {})
    request_url = url + ("?" + urllib.parse.urlencode(params) if params else "")
    # Store only a fingerprint: query parameters and headers can contain secrets.
    source = hashlib.sha256(json.dumps(
        [provider_id, url, params], sort_keys=True,
    ).encode()).hexdigest()
    return urllib.request.Request(request_url, headers=headers), source


def fetch_models(request):
    with urllib.request.urlopen(request, timeout=8) as response:
        payload = json.load(response)
    if not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
        raise SyncError("Provider /models must return an object containing a data array.")
    # Never silently publish a truncated provider response.
    if payload.get("has_more") is True:
        raise SyncError("Paginated provider responses are not supported.")
    return payload["data"]


def build_catalog(provider_models, bundled, configured_effort=None):
    templates = {model["slug"]: model for model in bundled["models"]}
    fallback = templates.get("gpt-5.5")
    if not fallback:
        fallback = next((m for m in templates.values() if not m.get("tool_mode")), None)
    if not fallback:
        raise SyncError("This Codex has no generic template for third-party models.")
    result = []
    seen = set()
    for raw in provider_models:
        if not isinstance(raw, dict):
            raise SyncError("Provider returned a non-object model entry.")
        model_id = raw.get("id")
        caps = raw.get("capabilities") or {}
        if not isinstance(caps, dict):
            raise SyncError("Provider model capabilities must be an object.")
        supports = caps.get("supports") or {}
        if not isinstance(supports, dict):
            raise SyncError("Provider model supports metadata must be an object.")
        policy = raw.get("policy") or {}
        endpoints = raw.get("supported_endpoints") or []
        if not isinstance(policy, dict) or not isinstance(endpoints, list):
            raise SyncError("Provider model policy or endpoint metadata is malformed.")
        if (raw.get("model_picker_enabled") is False
                or policy.get("state") in {"disabled", "blocked"}
                or "/responses" not in endpoints
                or caps.get("type", "chat") != "chat"
                or supports.get("tool_calls") is not True):
            continue
        if not isinstance(model_id, str) or not model_id.strip() or model_id in seen:
            raise SyncError("Provider returned an empty or duplicate model ID.")
        seen.add(model_id)
        model = copy.deepcopy(templates.get(model_id, fallback))
        if model_id not in templates:
            # Keep Codex's generic coding instructions, without claiming another model's identity.
            model.pop("model_messages", None)
            instructions = fallback["base_instructions"]
            model["base_instructions"] = "You are Codex, a coding agent. " + instructions.partition(". ")[2]
        model.update(
            slug=model_id,
            display_name=raw.get("name") or raw.get("display_name") or model_id,
            description=f"{raw.get('vendor', 'Provider')} model from the configured Responses provider.",
            visibility="list",
            supported_in_api=True,
            priority=len(result),
            upgrade=None,
            availability_nux=None,
            additional_speed_tiers=[],
            service_tiers=[],
            default_service_tier=None,
            supports_search_tool=supports.get("web_search") is True,
            support_verbosity=supports.get("verbosity") is True,
            use_responses_lite=False,
        )
        efforts = raw.get("reasoning_efforts", supports.get("reasoning_effort", []))
        if not isinstance(efforts, list) or any(not isinstance(e, str) or e not in EFFORTS for e in efforts):
            raise SyncError(f"Unsupported reasoning metadata for {model_id}.")
        model["supported_reasoning_levels"] = [
            {"effort": effort, "description": f"Provider reasoning effort: {effort}"}
            for effort in dict.fromkeys(efforts)
        ]
        preferred = [model.get("default_reasoning_level"), configured_effort, "medium"]
        model["default_reasoning_level"] = next(
            (effort for effort in preferred if effort in efforts), efforts[0] if efforts else None,
        )
        limits = caps.get("limits") or {}
        if not isinstance(limits, dict):
            raise SyncError(f"Provider context metadata is malformed for {model_id}.")
        windows = [raw.get("input_limit"), limits.get("max_prompt_tokens"),
                   raw.get("context_window"), limits.get("max_context_window_tokens")]
        windows = [n for n in windows if type(n) is int and n > 0]
        if not windows:
            raise SyncError(f"Provider did not declare a context limit for {model_id}.")
        model["context_window"] = min(windows)
        model["max_context_window"] = min(windows)
        modalities = raw.get("input_modalities", ["text"])
        if not isinstance(modalities, list) or not all(isinstance(mode, str) for mode in modalities):
            raise SyncError(f"Provider input modalities are malformed for {model_id}.")
        model["input_modalities"] = [mode for mode in modalities if mode in {"text", "image"}]
        result.append(model)
    if not result:
        raise SyncError("Provider returned no selectable Responses models with tool calling.")
    return {"models": result}


def atomic_write(path, data, validate=None, mode=0o600):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.read_bytes() == data:
        return False
    name = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix="." + path.name, delete=False) as file:
            name = Path(file.name)
            os.fchmod(file.fileno(), mode)
            file.write(data)
            file.flush()
            os.fsync(file.fileno())
        if validate:
            validate(name)
        os.replace(name, path)
        return True
    finally:
        if name is not None:
            name.unlink(missing_ok=True)


def validate_catalog(path, executable):
    return native(executable, ["-c", "model_catalog_json=" + json.dumps(str(path)), "debug", "models"])


def sync(config_path, output, executable):
    config = tomllib.loads(config_path.read_text())
    request, source = provider_settings(config)
    provider_models = fetch_models(request)
    bundled = native(executable, ["debug", "models", "--bundled"])
    catalog = build_catalog(provider_models, bundled, config.get("model_reasoning_effort"))
    catalog["provider_source_sha256"] = source
    data = (json.dumps(catalog, ensure_ascii=False, indent=2) + "\n").encode()
    changed = atomic_write(output, data, lambda path: validate_catalog(path, executable))
    label = "updated" if changed else "unchanged"
    print(f"[codex-model-sync] {len(catalog['models'])} compatible models; {label}: {output}", file=sys.stderr)
    return catalog


def backup(path, directory):
    if path.exists():
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        shutil.copy2(path, directory / path.name)


def config_with_catalog(text, output):
    # Only edit the top-level setting; preserve comments, tables, and other settings.
    table = re.search(r"(?m)^\s*\[", text)
    split = table.start() if table else len(text)
    top, rest = text[:split], text[split:]
    line = "model_catalog_json = " + json.dumps(str(output))
    if re.search(r"(?m)^model_catalog_json\s*=", top):
        top = re.sub(r"(?m)^model_catalog_json\s*=.*$", lambda _: line, top)
    else:
        top = line + "\n" + top
    updated = top + rest
    if tomllib.loads(updated).get("model_catalog_json") != str(output):
        raise SyncError("Could not safely update the model_catalog_json setting.")
    return updated


def install(config_path, output, executable, shell_rc):
    directory = config_path.parent
    installed = directory / "scripts" / "codex-model-sync.py"
    launcher = Path.home() / ".local" / "bin" / "codex-synced"
    snapshot = directory / "backups" / ("model-sync-" + time.strftime("%Y%m%d-%H%M%S") + f"-{time.time_ns()}")
    config_text = config_path.read_text()
    updated_config = config_with_catalog(config_text, output)
    rc_text = shell_rc.read_text() if shell_rc.exists() else ""
    if SHELL_BEGIN not in rc_text and re.search(r"(?m)^\s*(?:function\s+codex\b|codex\s*\(\))", rc_text):
        raise SyncError("An existing codex shell function needs to be integrated manually.")
    block = f'{SHELL_BEGIN}\ncodex() {{\n  {shlex.quote(str(launcher))} "$@"\n}}\n{SHELL_END}'
    if SHELL_BEGIN in rc_text:
        if SHELL_END not in rc_text:
            raise SyncError("Incomplete model-sync shell block; refusing to overwrite it.")
        updated_rc = re.sub(re.escape(SHELL_BEGIN) + r".*?" + re.escape(SHELL_END),
                            lambda _: block, rc_text, flags=re.S)
    else:
        updated_rc = rc_text.rstrip("\n") + "\n\n" + block + "\n"
    interpreter = str(Path(sys._base_executable).resolve())
    launch_text = ("#!/bin/sh\nexec " + shlex.join([
        interpreter, str(installed), "--config", str(config_path), "--launch", "--",
    ]) + ' "$@"\n')
    for path in [config_path, shell_rc, installed, launcher, output]:
        backup(path, snapshot)
    sync(config_path, output, executable)
    if Path(__file__).resolve() != installed.resolve():
        atomic_write(installed, Path(__file__).read_bytes(), mode=0o700)
    atomic_write(launcher, launch_text.encode(), mode=0o700)
    atomic_write(config_path, updated_config.encode())
    atomic_write(shell_rc, updated_rc.encode(), mode=shell_rc.stat().st_mode & 0o777 if shell_rc.exists() else 0o600)
    print(f"[codex-model-sync] Installed. Backups: {snapshot}", file=sys.stderr)
    print("Open a new shell, or source your shell rc. codex-synced is available immediately.", file=sys.stderr)


def skip_sync(args):
    if any(arg in {"--help", "-h", "--version", "-V", "--remote", "--profile", "-p"}
           or arg.startswith(("--remote=", "--profile=")) for arg in args):
        return True
    return bool(args and args[0] in MAINTENANCE)


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    # argparse treats a literal `--` as the end of options even for REMAINDER.
    if "--launch" in argv:
        index = argv.index("--launch") + 1
        if argv[index:index + 1] == ["--"]:
            argv.pop(index)
    directory = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex")))
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=directory / "config.toml")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--codex-bin", default=shutil.which("codex"))
    parser.add_argument("--install", action="store_true", help="Install the script, launcher, config, and zsh startup hook")
    parser.add_argument("--shell-rc", type=Path, default=Path.home() / ".zshrc")
    parser.add_argument("--launch", nargs=argparse.REMAINDER, help="Sync, then launch Codex with the remaining arguments")
    options = parser.parse_args(argv)
    if not options.codex_bin:
        parser.error("codex must be installed and on PATH, or supplied with --codex-bin")
    args = options.launch
    if args is not None and args[:1] == ["--"]:
        args = args[1:]
    try:
        if args is not None and skip_sync(args):
            os.execv(options.codex_bin, [options.codex_bin, *args])
            return 0
        config_path = options.config.expanduser().absolute()
        config = tomllib.loads(config_path.read_text())
        output = (options.output or Path(config.get("model_catalog_json", config_path.parent / "provider-models.json"))).expanduser().absolute()
        if options.install:
            install(config_path, output, options.codex_bin, options.shell_rc.expanduser())
            return 0
        try:
            sync(config_path, output, options.codex_bin)
        except (SyncError, OSError, ValueError, subprocess.SubprocessError) as error:
            if args is None:
                raise
            _, source = provider_settings(config)
            cached = json.loads(output.read_text()) if output.exists() else {}
            if cached.get("provider_source_sha256") != source:
                raise SyncError("Sync failed and there is no catalog for this provider: " + str(error)) from error
            validate_catalog(output, options.codex_bin)
            print(f"[codex-model-sync] Sync failed; using the last valid catalog: {error}", file=sys.stderr)
        if args is not None:
            # A shared daemon keeps its startup catalog. Use a fresh backend without stopping it.
            override = "model_catalog_json=" + json.dumps(str(output))
            os.execv(options.codex_bin, [options.codex_bin, "--no-daemon", "-c", override, *args])
        return 0
    except (SyncError, OSError, ValueError, subprocess.SubprocessError) as error:
        print(f"[codex-model-sync] {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
