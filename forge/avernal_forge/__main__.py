"""Command line entry point: `python3 -m avernal_forge`."""

from __future__ import annotations

import argparse
import sys
import time
import webbrowser
from pathlib import Path

from . import __version__
from .config import DEFAULT_PORT, Config
from .engines import EngineRegistry
from .server import serve

BANNER = """
  \033[38;5;160m/\\\033[0m  AVERNAL FORGE
  \033[38;5;160m\\/\033[0m  local image generation
"""


def _add_common(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--home", type=Path, help="data directory (default ~/.avernal-forge)")
    parser.add_argument("--models", type=Path, dest="models_dir",
                        help="folder to scan for local model weights")
    parser.add_argument("--engine", default="auto",
                        choices=["auto", "diffusers", "procedural"],
                        help="which local engine to use (default: auto)")
    parser.add_argument("--model", help="model id, name or path to load")
    parser.add_argument("--device", default="auto",
                        help="auto, cuda, mps or cpu (diffusers engine)")
    parser.add_argument("--sd-config", dest="sd_config",
                        help="pipeline config folder for single-file checkpoints")
    parser.add_argument("--offload", action="store_true",
                        help="enable model CPU offload to save VRAM")
    parser.add_argument("--online", action="store_true",
                        help="allow live connectors to fetch reference material")
    parser.add_argument("--allow-private-hosts", action="store_true",
                        dest="allow_private_hosts",
                        help="let connectors reach LAN/loopback hosts (self-hosted instances)")
    parser.add_argument("--quiet", action="store_true", help="less logging")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="avernal-forge",
        description="Fully local image generation. No third-party APIs - Forge is the provider.",
    )
    parser.add_argument("--version", action="version", version=f"Avernal Forge {__version__}")
    subparsers = parser.add_subparsers(dest="command")

    run = subparsers.add_parser("serve", help="start the studio and API (default)")
    run.add_argument("--host", default="127.0.0.1",
                     help="bind address (default 127.0.0.1, local only)")
    run.add_argument("--port", type=int, default=DEFAULT_PORT)
    run.add_argument("--workers", type=int, default=1,
                     help="concurrent render workers (keep at 1 for one GPU)")
    run.add_argument("--api-key", dest="api_key",
                     help="require this bearer token on API requests")
    run.add_argument("--cors", action="store_true",
                     help="allow cross-origin browser calls (off by default)")
    run.add_argument("--open", action="store_true", dest="open_browser",
                     help="open the studio in your browser")
    _add_common(run)

    one = subparsers.add_parser("generate", help="render once from the terminal")
    one.add_argument("prompt")
    one.add_argument("-o", "--out", type=Path, default=None, help="output PNG path")
    one.add_argument("-n", "--batch", type=int, default=1)
    one.add_argument("--negative", default="")
    one.add_argument("--size", default="512x512")
    one.add_argument("--steps", type=int, default=24)
    one.add_argument("--guidance", type=float, default=7.0)
    one.add_argument("--seed", type=int, default=-1)
    one.add_argument("--sampler", default="euler_a")
    _add_common(one)

    listing = subparsers.add_parser(
        "models", help="list, or install, the models on this machine")
    listing.add_argument("--catalogue", "--catalog", action="store_true",
                         dest="catalogue",
                         help="show models Forge can install for you")
    listing.add_argument("--install", metavar="NAME",
                         help="install a catalogue id, or any owner/repo from the hub")
    listing.add_argument("--hf-token", dest="hf_token",
                         help="Hugging Face token, needed for gated models")
    _add_common(listing)

    connectors = subparsers.add_parser(
        "connectors", help="show live connectors, and optionally test them")
    connectors.add_argument("--check", action="store_true",
                            help="make one real request per connector and report")
    connectors.add_argument("--only", help="check a single connector by id")
    _add_common(connectors)
    return parser


def config_from_args(args: argparse.Namespace) -> Config:
    config = Config()
    if getattr(args, "home", None):
        config.home = args.home.expanduser()
    if getattr(args, "models_dir", None):
        config.models_dir_override = args.models_dir.expanduser()
    if getattr(args, "online", False):
        config.online_forced = True
        config.online = True
    for name in ("device", "engine", "model", "sd_config", "offload", "quiet",
                 "host", "port", "workers", "api_key", "cors",
                 "allow_private_hosts", "hf_token"):
        value = getattr(args, name, None)
        if value is not None:
            setattr(config, name, value)
    config.ensure_dirs()
    return config


def cmd_serve(args: argparse.Namespace) -> int:
    config = config_from_args(args)
    try:
        httpd = serve(config)
    except OSError as exc:
        print(f"Could not bind {config.host}:{config.port}: {exc}", file=sys.stderr)
        print("Another Forge may already be running; try --port 8788.", file=sys.stderr)
        return 1

    engine = httpd.registry.default()
    if not config.quiet:
        print(BANNER)
        print(f"  Avernal Forge {__version__} - everything runs on this machine")
        print(f"  Studio    {config.base_url}")
        print(f"  API       {config.base_url}/v1/images/generations (OpenAI-compatible)")
        print(f"  Engine    {engine.label} [{engine.device_label()}]")
        print(f"  Models    {config.models_dir}")
        print(f"  Outputs   {config.outputs_dir}")
        if not engine.is_neural:
            print("\n  No model weights found, so the built-in procedural engine is active.")
            print("  Drop a diffusers model folder in the models directory for Stable Diffusion.")
        if config.host not in ("127.0.0.1", "localhost", "::1") and not config.api_key:
            print("\n  WARNING: bound to a non-local address with no --api-key set.")
        print("\n  Press Ctrl+C to stop.\n")

    if getattr(args, "open_browser", False):
        threading_timer_open(config.base_url)

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[forge] shutting down")
    finally:
        httpd.shutdown()
        httpd.server_close()
    return 0


def threading_timer_open(url: str) -> None:
    import threading

    threading.Timer(0.6, lambda: webbrowser.open(url)).start()


def cmd_generate(args: argparse.Namespace) -> int:
    from .server import build_request

    config = config_from_args(args)
    registry = EngineRegistry(config)
    engine = registry.resolve(config.engine)
    request = build_request(
        {
            "prompt": args.prompt,
            "negative": args.negative,
            "size": args.size,
            "steps": args.steps,
            "guidance": args.guidance,
            "seed": args.seed,
            "batch": args.batch,
            "sampler": args.sampler,
            "model": config.model,
        }
    )

    class TerminalContext:
        def progress(self, step: int, total: int, note: str = "") -> None:
            if args.quiet:
                return
            filled = int(24 * min(1.0, step / max(1, total)))
            bar = "#" * filled + "." * (24 - filled)
            print(f"\r  [{bar}] {note or 'working'}   ", end="", flush=True)

        def check_cancel(self) -> None:
            return None

    started = time.time()
    written: list[Path] = []
    for index, image in enumerate(engine.generate(request, TerminalContext())):
        if args.out and args.batch == 1:
            target = args.out
        elif args.out:
            target = args.out.with_name(f"{args.out.stem}-{index + 1}{args.out.suffix}")
        else:
            target = config.outputs_dir / f"forge-{int(time.time())}-{image.seed}.png"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(image.png)
        written.append(target)

    if not args.quiet:
        print(f"\r  rendered {len(written)} image(s) in {time.time() - started:.1f}s"
              + " " * 20)
    for path in written:
        print(path)
    return 0


def _print_catalogue() -> int:
    from .catalogue import CATALOGUE

    print("Models Forge can install for you:\n")
    for entry in CATALOGUE:
        flags = []
        if entry.photoreal_people:
            flags.append("photoreal people")
        if entry.gated:
            flags.append("gated")
        if entry.requires:
            flags.append(f"needs {entry.requires}")
        print(f"  {entry.id:<13} {entry.kind:<6} ~{entry.approx_gb:.1f}GB  "
              f"{entry.vram_gb:.0f}GB VRAM  {entry.name}")
        print(f"                {entry.good_for}")
        if flags:
            print(f"                ({', '.join(flags)})")
        if entry.notes:
            print(f"                {entry.notes}")
        print(f"                licence: {entry.licence}")
        print()
    print("Install one with:  python3 run.py models --install <id>")
    print("Any hub repo works too:  python3 run.py models --install owner/name")
    return 0


def _install(args: argparse.Namespace) -> int:
    from .installer import InstallError, install_by_name

    config = config_from_args(args)
    state = {"line": ""}

    def on_event(kind: str, payload: dict) -> None:
        if kind == "start":
            print(f"Installing {payload['repo']} "
                  f"({payload['files']} files) into {payload['target']}")
            print("Downloads go through the same audited gate as everything else.\n")
        elif kind == "file":
            state["line"] = f"  [{payload['index']}/{payload['of']}] {payload['file']}"
            # Padded, so a longer previous filename is fully overwritten.
            print("\r" + state["line"].ljust(78), end="", flush=True)
        elif kind == "progress" and payload.get("total"):
            share = payload["done"] / payload["total"]
            line = f"{state['line']}  {share * 100:5.1f}%"
            print("\r" + line.ljust(78), end="", flush=True)
        elif kind == "skip":
            line = (f"  [{payload['index']}/{payload['of']}] {payload['file']}  "
                    "(already here)")
            print("\r" + line.ljust(78))
        elif kind == "warn":
            print(f"\n  note: {payload['message']}")
        elif kind == "done":
            print("\r" + " " * 78 + "\r", end="")
            size_gb = payload["bytes"] / 1e9
            summary = f"{payload['downloaded']} file(s) downloaded"
            if payload["skipped"]:
                summary += f", {payload['skipped']} already present"
            print(f"\nDone. {summary} ({size_gb:.2f} GB).")
            print(f"Installed at {payload['target']}")

    try:
        result = install_by_name(args.install, config, on_event=on_event)
    except InstallError as exc:
        print(f"\n{exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\nInterrupted. Re-run the same command to resume.", file=sys.stderr)
        return 1

    entry = result.get("entry")
    print("\nStart Forge and pick it in the studio:  python3 run.py")
    if entry and entry.get("kind") == "video" and "image-to-video" in (entry.get("notes") or ""):
        print("This one is image-to-video: attach a reference or a still to animate.")
    return 0


def cmd_models(args: argparse.Namespace) -> int:
    if getattr(args, "catalogue", False):
        return _print_catalogue()
    if getattr(args, "install", None):
        return _install(args)

    config = config_from_args(args)
    registry = EngineRegistry(config)
    print(f"Scanning {config.models_dir} (and the Hugging Face cache) - no network access.\n")
    for engine in registry.all():
        state = "ready" if engine.available() else f"unavailable: {engine.unavailable_reason()}"
        print(f"{engine.label}  [{state}]")
        if engine.available():
            found = engine.models()
            if not found:
                print("    (no weights found)")
            for model in found:
                size = model.get("size_bytes") or 0
                size_text = f"{size / 1e9:.1f} GB" if size else "-"
                print(f"    {model['id']:<34} {model['kind']:<11} {size_text:>8}  {model['path']}")
        print()

    # Two different problems, and conflating them sends people the wrong way.
    from . import models as model_registry

    on_disk = model_registry.discover(config.models_dir)
    torch_ready = any(e.available() for e in registry.all() if e.is_neural)

    if on_disk and not torch_ready:
        print(f"{len(on_disk)} model(s) are on disk, but torch and diffusers are "
              "not installed,\nso Forge cannot run them yet:\n")
        print("  pip install -r requirements-local-models.txt")
    elif not on_disk:
        print("No trained model weights are installed, so Forge is using its "
              "built-in\nprocedural renderer. That renders abstract fields - it "
              "cannot draw people\nor photorealistic scenes, and no setting "
              "will make it.\n")
        print("To generate realistic images or video:")
        print("  python3 run.py models --catalogue      # what is available")
        print("  python3 run.py models --install sdxl   # photoreal stills")
        print("  python3 run.py models --install svd    # realistic video from a still")
    return 0


def cmd_connectors(args: argparse.Namespace) -> int:
    from .connectors import ConnectorHub, ConnectorStore

    config = config_from_args(args)
    hub = ConnectorHub(config, ConnectorStore(config.connectors_path))
    described = hub.describe()

    print(f"Live connectors are {'ON' if described['online'] else 'OFF'}"
          + (" (forced by --online)" if described["online_forced"] else ""))
    print(f"Settings   {config.connectors_path}")
    print(f"Reachable  {', '.join(described['allowed_domains']) or 'nothing'}")
    print("\nGeneration never uses the network, whatever is switched on here.\n")

    for connector in described["connectors"]:
        if connector["configured"]:
            state = "ready" if connector["enabled"] else "off"
        else:
            state = "needs " + ", ".join(connector["missing"])
        print(f"  {connector['id']:<11} {state:<32} {connector['label']}")
        if connector["note"]:
            print(f"              note: {connector['note']}")
        if not connector["configured"] and connector["docs_url"]:
            print(f"              keys: {connector['docs_url']}")

    if not args.check:
        print("\nRun with --check to make one real request per connector.")
        return 0

    if not described["online"]:
        print("\nCannot check anything while live connectors are off. "
              "Re-run with --online.")
        return 1

    targets = [c["id"] for c in described["connectors"]
               if c["enabled"] and c["configured"]]
    if args.only:
        targets = [t for t in targets if t == args.only]
        if not targets:
            print(f"\n{args.only!r} is not an enabled, configured connector.")
            return 1

    print("\nChecking live endpoints:")
    failures = 0
    for connector_id in targets:
        result = hub.probe(connector_id)
        mark = "ok  " if result["ok"] else "FAIL"
        print(f"  [{mark}] {connector_id:<11} {result['ms']:>5}ms  {result['detail']}")
        failures += 0 if result["ok"] else 1

    print(f"\n{len(targets) - failures}/{len(targets)} connector(s) responded.")
    return 1 if failures else 0


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    known = {"serve", "generate", "models", "connectors"}
    if not argv or (argv[0].startswith("-") and argv[0] not in ("-h", "--help", "--version")):
        argv.insert(0, "serve")  # `forge --port 9000` should still serve
    elif argv[0] not in known and not argv[0].startswith("-"):
        argv.insert(0, "serve")

    args = build_parser().parse_args(argv)
    command = args.command or "serve"
    commands = {
        "serve": cmd_serve,
        "generate": cmd_generate,
        "models": cmd_models,
        "connectors": cmd_connectors,
    }
    return commands[command](args)


if __name__ == "__main__":
    raise SystemExit(main())
