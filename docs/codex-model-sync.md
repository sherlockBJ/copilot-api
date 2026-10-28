# Synchronize the Codex model picker

Codex's model picker does not automatically mirror this proxy's `/v1/models`.
The optional `scripts/codex-model-sync.py` helper converts the provider's model
metadata into a local Codex catalog before starting a new session.

The gateway also supports a merged remote Codex catalog and a one-time local
export; see [the Codex guide](guides/en/codex.md). This startup helper instead
mirrors the raw provider's explicitly advertised Responses models, excludes
unrelated bundled catalog entries, and automates refresh and offline fallback.

Requirements: Python 3.11+, a Codex CLI supporting `debug models --bundled` and
`model_catalog_json` (tested with 0.160.0 and 0.165.0), and a running proxy.
The helper uses only the Python standard library.

Configure your custom provider in `~/.codex/config.toml` first:

```toml
model = "your-model-id"
model_provider = "copilot-api"

[model_providers.copilot-api]
name = "Local Copilot API"
base_url = "http://127.0.0.1:4141/v1"
wire_api = "responses"
requires_openai_auth = false
```

Install from the repository root:

```sh
python3 scripts/codex-model-sync.py --install
source ~/.zshrc
codex
```

The installer generates `~/.codex/provider-models.json`, sets the top-level
`model_catalog_json` option, copies the helper into `~/.codex/scripts/`, and
creates `~/.local/bin/codex-synced`. A marked block in `.zshrc` makes interactive
`codex` calls use this launcher. Existing files are backed up under
`~/.codex/backups/model-sync-*` before editing. Reinstalling updates that block
without duplicating it.

The launcher is available immediately as `~/.local/bin/codex-synced`. For shells
other than zsh, invoke it directly or integrate it into that shell's startup
configuration. Use `command codex` to bypass the zsh function.

## Runtime behavior

- The helper reads `model_provider`, `base_url`, `query_params`, `env_key`,
  `http_headers`, and `env_http_headers` from your base user configuration.
- Only visible, enabled chat models advertising `/responses` and tool calling
  are included. Chat Completions-only models and embeddings are excluded.
- Model IDs, display names, reasoning efforts, and input limits come from the
  provider. Codex coding instructions and local tool metadata come from its
  bundled catalog; unknown models use its generic coding template.
- Provider input limits cap the context window. Undeclared reasoning levels,
  priority service tiers, and Responses Lite support are not inherited from the
  template. A model appearing in the picker does not guarantee account access or
  that every coding tool is supported by that model.
- Every catalog is validated by Codex before an atomic replacement. An empty,
  malformed, or unavailable provider response leaves the previous file intact.
- Offline launches reuse a validated previous catalog only when it belongs to
  the same provider endpoint. An initial failure or a different provider fails
  visibly instead of launching with an unrelated list.
- Sessions start with `--no-daemon` because the shared app-server keeps its
  startup catalog. Existing daemon sessions are left running. A running session
  keeps its list until reopened; updates apply at the next synchronized launch.
- Help, version, maintenance commands, explicit remote connections, and named
  profiles bypass synchronization. The hook targets the base user profile;
  project settings and command-line overrides still follow normal Codex rules.
- Installation and synchronization do not change the configured default model.
  If the provider removes it, select an available model in the picker or update
  the default explicitly.

To refresh the file manually without starting Codex:

```sh
python3 ~/.codex/scripts/codex-model-sync.py
```

To remove the integration, delete the marked block from `.zshrc`, remove
`model_catalog_json` from the top level of `config.toml` (or restore its previous
value from the backup), and remove the installed helper, launcher, and generated
catalog. Existing Codex and provider installations are not replaced.

Run the helper's regression checks:

```sh
python3 -m unittest discover -s tests -p test_codex_model_sync.py
```
