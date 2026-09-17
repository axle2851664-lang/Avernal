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

    listing = subparsers.add_parser("models", help="list the models found on this machine")
    _add_common(listing)
    return parser


def config_from_args(args: argparse.Namespace) -> Config:
    config = Config()
    if getattr(args, "home", None):
        config.home = args.home.expanduser()
    if getattr(args, "models_dir", None):
        config.models_dir_override = args.models_dir.expanduser()
    for name in ("device", "engine", "model", "sd_config", "offload", "quiet",
                 "host", "port", "workers", "api_key", "cors"):
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


def cmd_models(args: argparse.Namespace) -> int:
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
    return 0


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    known = {"serve", "generate", "models"}
    if not argv or (argv[0].startswith("-") and argv[0] not in ("-h", "--help", "--version")):
        argv.insert(0, "serve")  # `forge --port 9000` should still serve
    elif argv[0] not in known and not argv[0].startswith("-"):
        argv.insert(0, "serve")

    args = build_parser().parse_args(argv)
    command = args.command or "serve"
    return {"serve": cmd_serve, "generate": cmd_generate, "models": cmd_models}[command](args)


if __name__ == "__main__":
    raise SystemExit(main())
