#!/usr/bin/env python3
"""PyShell introspector: monkey-patches argparse, click, and typer to extract
the argument schema of a script without running it.

Run with: python _introspect.py <target_script.py>
Outputs JSON to stdout.

Supported frameworks:
  - argparse (stdlib)
  - click (third-party, if installed in the venv)
  - typer (third-party, if installed in the venv)
"""
import json
import sys
import importlib.util
import os
import io
import contextlib
import traceback


def introspect_argparse(captured):
    """Patch ArgumentParser.parse_args to capture _actions."""
    import argparse

    original_parse_args = argparse.ArgumentParser.parse_args

    def patched_parse_args(self, *args, **kwargs):
        for action in self._actions:
            if action.option_strings:
                flag = action.option_strings[0]
                positional = False
            else:
                flag = None
                positional = True

            # Skip the help action (-h/--help)
            if action.dest == "help":
                continue

            # Determine type
            type_name = "str"
            if action.type is not None:
                type_name = getattr(action.type, "__name__", "str")

            is_flag = action.nargs == 0 or action.const is True or isinstance(action, argparse._StoreTrueAction)

            # Determine choices
            choices = None
            if action.choices:
                choices = [str(c) for c in action.choices]

            entry = {
                "key": action.dest,
                "label": action.dest.replace("_", " ").title(),
                "help": action.help if action.help else None,
                "flag": flag,
                "positional": positional,
                "required": action.required or False,
                "type": "bool" if is_flag else type_name,
                "choices": choices,
                "default": action.default if action.default is not None else None,
                "action": str(action.nargs) if hasattr(action, "nargs") and action.nargs is not None else None,
                "index": None,
                "framework": "argparse",
            }

            # For FileType, use file type
            if type_name == "FileType":
                entry["type"] = "file"

            captured.append(entry)

        raise SystemExit(0)

    argparse.ArgumentParser.parse_args = patched_parse_args


def block_dangerous_calls():
    """Patch os.fork, subprocess.Popen, time.sleep, etc. so that scripts
    that spawn processes or run infinite loops during introspection don't hang.

    The patched versions either raise SystemExit or become no-ops.
    This is critical for scripts like misbehaving.py (Plan.md §M1)."""

    import time

    # --- Block os.fork — return fake child PIDs (we're always the "parent") ---
    import os
    if hasattr(os, "fork"):
        _fake_pid = [10000]

        def fake_fork():
            _fake_pid[0] += 1
            return _fake_pid[0]  # Non-zero = parent, never enters child branch
        os.fork = fake_fork

    # --- Block subprocess module ---
    try:
        import subprocess

        class FakePopen:
            def __init__(self, *args, **kwargs):
                self.pid = 0
                self.returncode = 0
                self.stdout = None
                self.stderr = None
                self.stdin = None
            def wait(self, *a, **kw): return 0
            def communicate(self, *a, **kw): return (b"", b"")
            def poll(self): return 0
            def terminate(self): pass
            def kill(self): pass

        subprocess.Popen = FakePopen
        if hasattr(subprocess, "run"):
            subprocess.run = lambda *a, **kw: subprocess.CompletedProcess(a, 0, b"", b"")
        if hasattr(subprocess, "call"):
            subprocess.call = lambda *a, **kw: 0
        if hasattr(subprocess, "check_output"):
            subprocess.check_output = lambda *a, **kw: b""
    except ImportError:
        pass

    # --- Block os.exec* ---
    for fn in ["execl", "execle", "execlp", "execlpe", "execv", "execve", "execvp", "execvpe"]:
        if hasattr(os, fn):
            setattr(os, fn, lambda *a, **kw: (_ for _ in ()).throw(SystemExit(0)))

    os.system = lambda *a, **kw: 0

    # --- Patch time.sleep — allow a few short sleeps for import-time retries,
    #     then raise SystemExit to break infinite loops like `while True: sleep(0.5)` ---
    _sleep_count = [0]
    _orig_sleep = time.sleep

    def patched_sleep(seconds):
        _sleep_count[0] += 1
        if _sleep_count[0] > 3:
            raise SystemExit(0)
        _orig_sleep(min(seconds, 0.01))

    time.sleep = patched_sleep


def introspect_click(captured):
    """Patch click.Command / click.Group to capture params."""
    try:
        import click
    except ImportError:
        return

    original_parse_args = click.Command.parse_args

    def patched_parse_args(self, ctx, args):
        for param in self.get_params(ctx):
            if isinstance(param, click.Option):
                flag = param.opts[0] if param.opts else None
                positional = False
            elif isinstance(param, click.Argument):
                flag = None
                positional = True
            else:
                continue

            type_name = "str"
            if param.type is not None:
                type_name = getattr(param.type, "__name__", "str")

            is_flag = param.is_flag

            choices = None
            if hasattr(param.type, "choices") and param.type.choices:
                choices = [str(c) for c in param.type.choices]

            entry = {
                "key": param.name,
                "label": param.name.replace("_", " ").title() if param.name else "arg",
                "help": param.help if param.help else None,
                "flag": flag,
                "positional": positional,
                "required": param.required or False,
                "type": "bool" if is_flag else type_name,
                "choices": choices,
                "default": param.default,
                "action": None,
                "index": None,
                "framework": "click",
            }
            captured.append(entry)

        raise SystemExit(0)

    click.Command.parse_args = patched_parse_args


def introspect_typer(captured):
    """Patch typer.Typer to capture params from the click commands it builds."""
    try:
        import typer
    except ImportError:
        return

    original_command = typer.Typer.command
    typer_command_info = []

    def patched_command(self, *args, **kwargs):
        func = args[0] if args else kwargs.get("name")
        if func and hasattr(func, "__annotations__"):
            for key, ann in func.__annotations__.items():
                if key == "return":
                    continue
                entry = {
                    "key": key,
                    "label": key.replace("_", " ").title(),
                    "help": None,
                    "flag": f"--{key.replace('_', '-')}",
                    "positional": False,
                    "required": False,
                    "type": "str",
                    "choices": None,
                    "default": None,
                    "action": None,
                    "index": None,
                    "framework": "typer",
                }
                typer_command_info.append(entry)
        return original_command(self, *args, **kwargs)

    typer.Typer.command = patched_command

    # Merge typer info after execution if click didn't catch them
    import builtins
    original_exit = getattr(builtins, "_pyshell_original_exit", None)

    def merge_after_exit(code=0):
        existing_keys = {e["key"] for e in captured}
        for entry in typer_command_info:
            if entry["key"] not in existing_keys:
                captured.append(entry)
        if original_exit:
            original_exit(code)
        raise SystemExit(code)


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "no script path"}))
        sys.exit(1)

    script_path = sys.argv[1]
    captured = []

    introspect_argparse(captured)
    introspect_click(captured)
    introspect_typer(captured)
    block_dangerous_calls()

    # Load the target script as __main__ so that
    # `if __name__ == "__main__": main()` blocks execute.
    # This is necessary because parse_args() is usually called inside main().
    # The patched parse_args will capture args and raise SystemExit(0)
    # before any real work is done.
    spec = importlib.util.spec_from_file_location("__main__", script_path)
    if spec is None or spec.loader is None:
        print(json.dumps({"error": f"cannot load {script_path}"}))
        sys.exit(1)

    module = importlib.util.module_from_spec(spec)

    # Set sys.argv to minimal args so argparse doesn't complain
    # about missing required arguments during introspection
    original_argv = sys.argv
    sys.argv = [script_path]

    # Suppress stdout/stderr during execution
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        try:
            spec.loader.exec_module(module)
        except SystemExit:
            pass
        except Exception:
            traceback.print_exc()

    sys.argv = original_argv

    # If nothing was captured, try calling main() directly
    if not captured and hasattr(module, "main"):
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            try:
                sys.argv = [script_path]
                module.main()
            except SystemExit:
                pass
            except Exception:
                traceback.print_exc()
            finally:
                sys.argv = original_argv

    # Merge any typer fallback info
    if not captured:
        try:
            merge_after_exit(0)
        except (NameError, SystemExit):
            pass

    # Renumber positional args
    pos_idx = 0
    for entry in captured:
        if entry["positional"]:
            entry["index"] = pos_idx
            pos_idx += 1

    print(json.dumps({"inputs": captured}))


if __name__ == "__main__":
    main()
