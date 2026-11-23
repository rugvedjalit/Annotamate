"""``scripts/bootstrap.py``: prerequisite checks and failure handling (no real installation is run)."""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path
from types import ModuleType

import pytest

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "bootstrap.py"


@pytest.fixture
def bootstrap() -> ModuleType:
    spec = importlib.util.spec_from_file_location("annotamate_bootstrap", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _fake_node(monkeypatch: pytest.MonkeyPatch, bootstrap: ModuleType, version: str | None) -> None:
    monkeypatch.setattr(bootstrap.shutil, "which", lambda name: None if version is None else f"/bin/{name}")

    def fake_run(command, **kwargs):
        return subprocess.CompletedProcess(command, 0, stdout=f"{version}\n", stderr="")

    monkeypatch.setattr(bootstrap.subprocess, "run", fake_run)


@pytest.mark.parametrize("version", ["v24.11.1", "v22.12.0", "v23.1.0", "v20.19.2"])
def test_supported_node_versions(bootstrap, monkeypatch, version):
    _fake_node(monkeypatch, bootstrap, version)
    assert bootstrap.check_node(required=True) is not None


@pytest.mark.parametrize("version", ["v20.18.0", "v22.11.0", "v18.20.4", "garbage"])
def test_old_node_versions_are_refused(bootstrap, monkeypatch, version):
    _fake_node(monkeypatch, bootstrap, version)
    with pytest.raises(bootstrap.SetupError, match="too old"):
        bootstrap.check_node(required=True)


def test_missing_node_is_an_error_only_when_the_web_build_is_needed(bootstrap, monkeypatch):
    _fake_node(monkeypatch, bootstrap, None)
    with pytest.raises(bootstrap.SetupError, match=r"Node.js"):
        bootstrap.check_node(required=True)
    assert bootstrap.check_node(required=False) is None


def test_old_python_is_refused(bootstrap, monkeypatch):
    monkeypatch.setattr(bootstrap.sys, "version_info", (3, 10, 14, "final", 0))
    with pytest.raises(bootstrap.SetupError, match=r"3.11 or newer"):
        bootstrap.check_python()


def test_failures_exit_with_1_and_a_message(bootstrap, monkeypatch, capsys):
    def broken_venv() -> None:
        raise bootstrap.SetupError("no space left")

    monkeypatch.setattr(bootstrap, "check_python", lambda: None)
    monkeypatch.setattr(bootstrap, "check_node", lambda required: None)
    monkeypatch.setattr(bootstrap, "create_venv", broken_venv)
    assert bootstrap.main(["--skip-web"]) == 1
    assert "Setup failed: no space left" in capsys.readouterr().err


def test_admin_password_never_comes_from_a_prompt_without_a_terminal(bootstrap, monkeypatch):
    monkeypatch.delenv(bootstrap.PASSWORD_ENV, raising=False)
    monkeypatch.setattr(bootstrap.sys.stdin, "isatty", lambda: False, raising=False)
    with pytest.raises(bootstrap.SetupError, match=bootstrap.PASSWORD_ENV):
        bootstrap.create_admin("admin", None)


def test_admin_password_is_passed_on_standard_input(bootstrap, monkeypatch):
    calls: list[tuple[list[str], str | None]] = []
    monkeypatch.setenv(bootstrap.PASSWORD_ENV, "from-the-environment")
    monkeypatch.setattr(bootstrap, "run", lambda command, **kw: calls.append((command, kw.get("stdin_text"))))
    bootstrap.create_admin("admin", "/tmp/data")
    command, stdin_text = calls[0]
    assert command[-3:] == ["--data-dir", "/tmp/data", "--password-stdin"]
    assert "from-the-environment" not in command  # never on the command line
    assert stdin_text == "from-the-environment\n"


def test_script_runs_with_only_the_standard_library():
    result = subprocess.run([sys.executable, "-I", str(SCRIPT), "--help"], capture_output=True, text=True,
                            check=False)
    assert result.returncode == 0 and "--admin" in result.stdout
