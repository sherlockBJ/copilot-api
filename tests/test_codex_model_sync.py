"""Run with: python3 -m unittest discover -s tests -p 'test_codex_model_sync.py'."""

import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import tomllib
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location(
    "codex_model_sync", Path(__file__).parents[1] / "scripts" / "codex-model-sync.py",
)
sync = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sync)


def bundled():
    generic = {
        "slug": "gpt-5.5", "display_name": "GPT", "shell_type": "unified_exec",
        "supported_reasoning_levels": [{"effort": "ultra", "description": "Old capability"}],
        "default_reasoning_level": "ultra", "visibility": "list", "supported_in_api": True,
        "priority": 1, "support_verbosity": True, "additional_speed_tiers": ["fast"],
        "service_tiers": [{"id": "priority"}], "upgrade": {"model": "gpt-obsolete"},
        "truncation_policy": {"mode": "tokens", "limit": 10000},
        "experimental_supported_tools": [], "context_window": 1000000,
        "base_instructions": "You are Codex, a coding agent based on GPT-5. Keep changes focused.",
        "model_messages": {"instructions_template": "Model-specific instructions"},
    }
    known = copy.deepcopy(generic)
    known.update(slug="known-model", tool_mode="code_mode_only")
    return {"models": [generic, known]}


def provider_model(model_id="new-model"):
    return {
        "id": model_id, "name": "Provider model", "vendor": "Example",
        "model_picker_enabled": True, "supported_endpoints": ["/responses"],
        "capabilities": {"type": "chat", "supports": {"tool_calls": True}},
        "reasoning_efforts": ["low", "medium", "high"],
        "context_window": 256000, "input_limit": 128000,
        "input_modalities": ["text", "image"],
    }


CONFIG = '''# Keep this comment.
model = "known-model"
model_provider = "proxy"
model_reasoning_effort = "high"

[model_providers.proxy]
base_url = "http://127.0.0.1:4141/v1"
wire_api = "responses"

[projects."/some/project"]
trust_level = "trusted"
'''


class CatalogTests(unittest.TestCase):
    def test_filters_incompatible_models_and_uses_provider_limits(self):
        chat = provider_model("chat-only")
        chat["supported_endpoints"] = ["/chat/completions"]
        embedding = provider_model("embedding")
        embedding["capabilities"]["type"] = "embeddings"
        disabled = provider_model("disabled")
        disabled["policy"] = {"state": "disabled"}
        no_tools = provider_model("no-tools")
        no_tools["capabilities"]["supports"]["tool_calls"] = False
        hidden = provider_model("hidden")
        hidden["model_picker_enabled"] = False
        catalog = sync.build_catalog(
            [chat, embedding, disabled, no_tools, hidden, provider_model()], bundled(), "high",
        )
        self.assertEqual(len(catalog["models"]), 1)
        model = catalog["models"][0]
        self.assertEqual(model["slug"], "new-model")
        self.assertEqual(model["context_window"], 128000)
        self.assertEqual(model["max_context_window"], 128000)
        self.assertEqual([x["effort"] for x in model["supported_reasoning_levels"]], ["low", "medium", "high"])
        self.assertEqual(model["default_reasoning_level"], "high")
        self.assertEqual(model["additional_speed_tiers"], [])
        self.assertEqual(model["service_tiers"], [])
        self.assertIsNone(model["upgrade"])
        self.assertFalse(model["supports_search_tool"])
        self.assertFalse(model["use_responses_lite"])
        self.assertNotIn("GPT-5", model["base_instructions"])
        self.assertNotIn("model_messages", model)

    def test_known_models_keep_their_coding_instructions_and_tool_configuration(self):
        model = sync.build_catalog([provider_model("known-model")], bundled())["models"][0]
        self.assertEqual(model["tool_mode"], "code_mode_only")
        self.assertEqual(model["model_messages"], bundled()["models"][1]["model_messages"])

    def test_rejects_empty_catalog_duplicates_and_unknown_reasoning_levels(self):
        with self.assertRaises(sync.SyncError):
            sync.build_catalog([], bundled())
        with self.assertRaises(sync.SyncError):
            sync.build_catalog([provider_model(), provider_model()], bundled())
        model = provider_model()
        model["reasoning_efforts"] = ["future-effort"]
        with self.assertRaises(sync.SyncError):
            sync.build_catalog([model], bundled())
        model["reasoning_efforts"] = [{"effort": "high"}]
        with self.assertRaises(sync.SyncError):
            sync.build_catalog([model], bundled())

    def test_no_reasoning_does_not_inherit_template_reasoning_levels(self):
        model = provider_model()
        model["reasoning_efforts"] = []
        result = sync.build_catalog([model], bundled())["models"][0]
        self.assertEqual(result["supported_reasoning_levels"], [])
        self.assertIsNone(result["default_reasoning_level"])

    def test_malformed_provider_metadata_is_reported_as_a_sync_failure(self):
        cases = [("policy", []), ("supported_endpoints", 42), ("input_modalities", None)]
        for field, value in cases:
            model = provider_model()
            model[field] = value
            # Empty policy is treated as an absent policy.
            if field == "policy":
                model[field] = ["invalid-policy"]
            with self.subTest(field=field), self.assertRaises(sync.SyncError):
                sync.build_catalog([model], bundled())

    def test_source_fingerprint_omits_credentials_and_distinguishes_providers(self):
        config = tomllib.loads(CONFIG)
        provider = config["model_providers"]["proxy"]
        provider.update(env_key="SYNC_TEST_KEY", env_http_headers={"X-Test": "SYNC_TEST_HEADER"})
        with patch.dict(os.environ, {"SYNC_TEST_KEY": "secret-token", "SYNC_TEST_HEADER": "secret-header"}):
            request, source = sync.provider_settings(config)
            self.assertEqual(request.get_header("Authorization"), "Bearer secret-token")
            self.assertEqual(len(source), 64)
            self.assertNotIn("secret", source)
            provider["base_url"] = "http://127.0.0.1:4545/v1"
            self.assertNotEqual(source, sync.provider_settings(config)[1])


class PersistenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = self.root / "config.toml"
        self.config.write_text(CONFIG)
        self.output = self.root / "provider-models.json"

    def test_native_validation_failure_keeps_previous_catalog_and_removes_temporary_file(self):
        self.output.write_bytes(b"old catalog")
        def reject(_):
            raise sync.SyncError("incompatible catalog")
        with self.assertRaises(sync.SyncError):
            sync.atomic_write(self.output, b"new catalog", reject)
        self.assertEqual(self.output.read_bytes(), b"old catalog")
        self.assertEqual(list(self.root.glob(".provider-models.json*")), [])

    def test_failed_or_empty_provider_response_never_replaces_valid_catalog(self):
        self.output.write_bytes(b"valid previous catalog")
        with patch.object(sync, "fetch_models", return_value=[]), patch.object(sync, "native", return_value=bundled()):
            with self.assertRaises(sync.SyncError):
                sync.sync(self.config, self.output, "codex")
        self.assertEqual(self.output.read_bytes(), b"valid previous catalog")
        self.assertEqual(self.config.read_text(), CONFIG)

    def test_changed_provider_removes_old_models_and_unchanged_response_does_not_rewrite(self):
        def native(_, args):
            return bundled() if "--bundled" in args else {}
        with patch.object(sync, "fetch_models", return_value=[provider_model("old")]), patch.object(sync, "native", side_effect=native):
            sync.sync(self.config, self.output, "codex")
        with patch.object(sync, "fetch_models", return_value=[provider_model("new")]), patch.object(sync, "native", side_effect=native):
            sync.sync(self.config, self.output, "codex")
            before = self.output.stat().st_mtime_ns
            sync.sync(self.config, self.output, "codex")
            self.assertEqual(self.output.stat().st_mtime_ns, before)
        self.assertEqual([m["slug"] for m in json.loads(self.output.read_text())["models"]], ["new"])

    def test_config_edit_preserves_unrelated_settings_and_is_idempotent(self):
        result = sync.config_with_catalog(CONFIG, self.output)
        before = tomllib.loads(CONFIG)
        after = tomllib.loads(result)
        self.assertEqual(after.pop("model_catalog_json"), str(self.output))
        self.assertEqual(before, after)
        self.assertIn("# Keep this comment.", result)
        self.assertEqual(sync.config_with_catalog(result, self.output), result)

    def test_offline_launch_uses_same_provider_cache_and_a_fresh_backend(self):
        catalog = sync.build_catalog([provider_model()], bundled())
        catalog["provider_source_sha256"] = sync.provider_settings(tomllib.loads(CONFIG))[1]
        self.output.write_text(json.dumps(catalog))
        with patch.object(sync, "sync", side_effect=OSError("connection refused")), patch.object(sync, "native", return_value=catalog), patch.object(sync.os, "execv") as launch:
            code = sync.main(["--config", str(self.config), "--codex-bin", "/real/codex", "--launch", "resume", "session-id"])
        self.assertEqual(code, 0)
        args = launch.call_args.args[1]
        self.assertIn("--no-daemon", args)
        self.assertEqual(args[-2:], ["resume", "session-id"])

    def test_offline_launch_refuses_a_catalog_from_another_provider(self):
        self.output.write_text(json.dumps({"provider_source_sha256": "other-provider", "models": []}))
        with patch.object(sync, "sync", side_effect=OSError("connection refused")), patch.object(sync.os, "execv") as launch:
            code = sync.main(["--config", str(self.config), "--codex-bin", "/real/codex", "--launch", "resume"])
        self.assertEqual(code, 1)
        launch.assert_not_called()

    def test_launcher_separator_and_maintenance_command_do_not_require_provider_access(self):
        with patch.object(sync.os, "execv") as launch, patch.object(sync, "sync") as refresh:
            code = sync.main(["--config", str(self.root / "missing.toml"), "--codex-bin", "/real/codex", "--launch", "--", "--version"])
        self.assertEqual(code, 0)
        launch.assert_called_once_with("/real/codex", ["/real/codex", "--version"])
        refresh.assert_not_called()

    def test_install_is_repeatable_and_keeps_original_backups(self):
        shell_rc = self.root / ".zshrc"
        shell_rc.write_text("# User shell settings\n")
        with patch.object(sync.Path, "home", return_value=self.root), patch.object(sync, "sync"):
            sync.install(self.config, self.output, "codex", shell_rc)
            sync.install(self.config, self.output, "codex", shell_rc)
        self.assertEqual(shell_rc.read_text().count(sync.SHELL_BEGIN), 1)
        backups = sorted((self.root / "backups").iterdir())
        self.assertEqual(len(backups), 2)
        self.assertEqual((backups[0] / "config.toml").read_text(), CONFIG)
        launcher = self.root / ".local" / "bin" / "codex-synced"
        self.assertIn("--launch --", launcher.read_text())
        self.assertEqual(launcher.stat().st_mode & 0o777, 0o700)


if __name__ == "__main__":
    unittest.main()
