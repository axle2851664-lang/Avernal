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
    one.add_argument("--video", action="store_true", help="render a clip, not a still")
    one.add_argument("--frames", type=int, default=24, help="clip length in frames")
    one.add_argument("--fps", type=float, default=12.0)
    one.add_argument("--motion", type=float, default=1.0,
                     help="how much the clip moves, 0-2")
    one.add_argument("--video-format", dest="video_format", default="auto",
                     choices=["auto", "mp4", "apng"])
    one.add_argument("--style", default="none",
                     help="a Look preset id, e.g. portrait (trained models only)")
    one.add_argument("--detail", action="store_true", dest="detail_pass",
                     help="extra detail pass; sharpens faces, slower")
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
    connectors.add_argument("--login", metavar="ID",
                            help="sign in to a connector that needs an account, "
                                 "such as gmail")
    connectors.add_argument("--no-browser", action="store_true",
                            dest="no_browser",
                            help="print the consent URL instead of opening it")
    connectors.add_argument("--set", metavar="ID", dest="set_id",
                            help="configure a connector: --set custom key=value ...")
    connectors.add_argument("settings", nargs="*", metavar="KEY=VALUE",
                            help="settings for --set")
    connectors.add_argument("--inspect", metavar="URL",
                            help="fetch a JSON API once and report how to map it")
    connectors.add_argument("--header", action="append", default=[],
                            metavar="NAME:VALUE",
                            help="header for --inspect, repeatable")
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
    want_video = bool(getattr(args, "video", False))
    engine = registry.resolve(config.engine, want_video=want_video)
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
            "kind": "video" if want_video else "image",
            "frames": args.frames,
            "fps": args.fps,
            "motion": args.motion,
            "video_format": args.video_format,
            "style": args.style,
            "detail_pass": args.detail_pass,
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
    for index, media in enumerate(engine.generate(request, TerminalContext())):
        if args.out and args.batch == 1:
            target = args.out
        elif args.out:
            target = args.out.with_name(f"{args.out.stem}-{index + 1}{args.out.suffix}")
        else:
            # The extension follows the media: a clip is .mp4 or .png (APNG).
            target = (config.outputs_dir /
                      f"forge-{int(time.time())}-{media.seed}{media.ext}")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(media.data)
        written.append(target)
        if media.meta.get("note") and not args.quiet:
            print(f"\r  note: {media.meta['note']}".ljust(60))

    if not args.quiet:
        noun = "clip" if want_video else "image"
        plural = "" if len(written) == 1 else "s"
        print(f"\r  rendered {len(written)} {noun}{plural} in "
              f"{time.time() - started:.1f}s".ljust(60))
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

    from . import models as model_registry

    config = config_from_args(args)
    registry = EngineRegistry(config)
    print(f"Scanning {config.models_dir} (and the Hugging Face cache) "
          "- no network access.\n")

    # Weights on disk are listed whether or not an engine can currently run
    # them: installing a model and then not seeing it named is baffling.
    on_disk = model_registry.discover(config.models_dir)
    if on_disk:
        print("Weights on this machine:")
        for model in on_disk:
            size = model.get("size_bytes") or 0
            size_text = f"{size / 1e9:.1f} GB" if size else "-"
            print(f"  {model['id']:<30} {model.get('media', 'image'):<6} "
                  f"{model['kind']:<11} {size_text:>8}  {model['path']}")
        print()
    else:
        print("No model weights on this machine.\n")

    print("Engines:")
    for engine in registry.all():
        if engine.available():
            state = "ready"
        else:
            state = f"unavailable - {engine.unavailable_reason()}"
        print(f"  {engine.label}")
        print(f"      {state}")
        if engine.available() and engine.models():
            usable = ", ".join(m["id"] for m in engine.models())
            print(f"      can use: {usable}")
    print()

    torch_ready = any(e.available() for e in registry.all() if e.is_neural)
    if on_disk and not torch_ready:
        print("Those weights cannot run yet: torch and diffusers are not "
              "installed.\n")
        print("  pip install -r requirements-local-models.txt")
    elif not on_disk:
        print("Forge is using its built-in procedural renderer. That renders "
              "abstract\nfields - it cannot draw people or photorealistic "
              "scenes, and no setting\nwill make it.\n")
        print("To generate realistic images or video:")
        print("  python3 run.py models --catalogue      # what is available")
        print("  python3 run.py models --install sdxl   # photoreal stills")
        print("  python3 run.py models --install svd    # realistic video from a still")
    return 0


def _login(args: argparse.Namespace) -> int:
    """Run a connector's OAuth flow and store only the refresh token."""
    import getpass

    from .connectors import ConnectorHub, ConnectorStore
    from .connectors.net import NetworkGate
    from .connectors.oauth import OAuthError, authorise

    config = config_from_args(args)
    store = ConnectorStore(config.connectors_path)
    hub = ConnectorHub(config, store)

    connector = hub.get(args.login)
    if connector is None:
        print(f"Unknown connector {args.login!r}.", file=sys.stderr)
        return 1
    if not hasattr(connector, "endpoints"):
        print(f"{connector.label} does not sign in; set its keys in the studio "
              "instead.", file=sys.stderr)
        return 1

    print(f"Signing in to {connector.label}.\n")
    print("You need an OAuth client of type 'Desktop app' from")
    print(f"  {connector.docs_url}")
    print("with the Gmail API enabled on that project.\n")

    credentials = store.credentials(connector.id)
    client_id = credentials.get("client_id") or input("  Client ID: ").strip()
    client_secret = (credentials.get("client_secret")
                     or getpass.getpass("  Client secret (hidden): ").strip())
    if not client_id or not client_secret:
        print("\nBoth a client id and secret are needed.", file=sys.stderr)
        return 1

    # A gate opened only for this connector, only for this command.
    class _LoginConfig:
        online = True
        allow_private_hosts = bool(getattr(config, "allow_private_hosts", False))

    gate = NetworkGate(_LoginConfig())
    gate.set_allowed_domains(set(connector.domains))

    def on_event(kind: str, payload: dict) -> None:
        if kind == "consent":
            print("\nOpening your browser to approve read-only access.")
            print("If it does not open, visit this URL yourself:\n")
            print(f"  {payload['url']}\n")
            print("Waiting for the redirect...")
        elif kind == "exchange":
            print("Approved. Exchanging the code for a token...")

    try:
        tokens = authorise(
            connector.endpoints(), client_id, client_secret, gate,
            connector=connector.id,
            open_browser=not getattr(args, "no_browser", False),
            on_event=on_event,
        )
    except OAuthError as exc:
        print(f"\n{exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\nCancelled. Nothing was saved.", file=sys.stderr)
        return 1

    # Only the refresh token is kept; access tokens are fetched as needed.
    hub.set_credentials(connector.id, {
        "client_id": client_id,
        "client_secret": client_secret,
        "refresh_token": tokens["refresh_token"],
    })
    enabled = set(hub.enabled_ids)
    enabled.add(connector.id)
    hub.set_enabled(sorted(enabled))

    print(f"\nSigned in. Credentials saved to {config.connectors_path} (0600).")
    print(f"{connector.label} is switched on.\n")
    print("Turn live connectors on in the studio, or start with --online, then")
    print("search it from the Live references tab.")
    return 0


def _set_credentials(args: argparse.Namespace) -> int:
    """Configure a connector from the command line instead of the studio."""
    from .connectors import ConnectorHub, ConnectorStore

    config = config_from_args(args)
    hub = ConnectorHub(config, ConnectorStore(config.connectors_path))
    connector = hub.get(args.set_id)
    if connector is None:
        print(f"Unknown connector {args.set_id!r}.", file=sys.stderr)
        return 1

    known = {field.name for field in connector.credential_fields}
    if not args.settings:
        print(f"{connector.label} takes:\n")
        for field in connector.credential_fields:
            need = "required" if field.required else "optional"
            hint = f"  e.g. {field.placeholder}" if field.placeholder else ""
            print(f"  {field.name:<18} {need:<8} {field.label}{hint}")
        print("\nFor example:")
        print(f"  python3 run.py connectors --set {connector.id} \\")
        print("      base_url=https://helix.example.com \\")
        print("      'search_path=/api/search?q={query}&limit={limit}'")
        print("\nQuote any value containing & or ? so the shell keeps it intact.")
        return 0

    values: dict[str, str] = {}
    for pair in args.settings:
        if "=" not in pair:
            print(f"{pair!r} is not key=value.", file=sys.stderr)
            return 1
        key, value = pair.split("=", 1)
        key = key.strip()
        if key not in known:
            print(f"{connector.label} has no field {key!r}. "
                  f"Known: {', '.join(sorted(known))}", file=sys.stderr)
            return 1
        values[key] = value

    hub.set_credentials(connector.id, values)
    enabled = set(hub.enabled_ids)
    enabled.add(connector.id)
    hub.set_enabled(sorted(enabled))

    credentials = hub.store.credentials(connector.id)
    missing = connector.missing_fields(credentials)
    # Use the described label, so a connector that was just given a name
    # reports under that name rather than its generic one.
    label = connector.describe(credentials).get("label", connector.label)
    # Values are echoed back as set/not set, never printed.
    print(f"Saved {len(values)} setting(s) for {label}.")
    for field in connector.credential_fields:
        state = "set" if credentials.get(field.name) else "-"
        print(f"  {field.name:<18} {state}")
    if missing:
        print(f"\nStill needs: {', '.join(missing)}")
        return 0
    print(f"\n{label} is configured and switched on.")
    print("Check it reaches your service with:")
    print(f"  python3 run.py connectors --check --only {connector.id} --online")
    return 0


def _inspect_api(args: argparse.Namespace) -> int:
    """Fetch a JSON API once and report the mapping it needs.

    Working out where the title and image live in someone else's response is
    the fiddly part of connecting an in-house service, so this does it rather
    than leaving it to trial and error.
    """
    import json as _json
    import urllib.parse

    from .connectors.custom import GUESSES, find_results, first_present
    from .connectors.net import NetworkError, NetworkGate

    config = config_from_args(args)
    url = args.inspect

    headers = {}
    for raw in args.header:
        if ":" not in raw:
            print(f"{raw!r} is not NAME:VALUE.", file=sys.stderr)
            return 1
        name, value = raw.split(":", 1)
        headers[name.strip()] = value.strip()

    class _InspectConfig:
        online = True
        allow_private_hosts = bool(getattr(config, "allow_private_hosts", False))

    host = urllib.parse.urlsplit(url).netloc.split(":")[0]
    gate = NetworkGate(_InspectConfig())
    gate.set_allowed_domains({host})

    print(f"Fetching {url}\n")
    try:
        payload = gate.json(url, connector="inspect", headers=headers,
                            user_directed=True, timeout=30.0)
    except NetworkError as exc:
        print(f"{exc}", file=sys.stderr)
        return 1

    if isinstance(payload, dict):
        print(f"Top-level keys: {', '.join(list(payload)[:12])}\n")

    records = find_results(payload)
    if records is None:
        print("No list of records found in that response.")
        print("If the results are somewhere unusual, set 'Path to results' to")
        print("the dotted path, for example data.items. The response begins:\n")
        print(_json.dumps(payload, indent=2)[:900])
        return 1

    print(f"Found {len(records)} record(s) automatically.")
    if not records:
        print("The list was empty - try a query that matches something.")
        return 0

    sample = records[0]
    print(f"Fields on the first record: {', '.join(list(sample)[:14])}\n")

    detected = {kind: first_present(sample, "", kind) for kind in GUESSES}
    print("Auto-detected:")
    for kind in ("title", "image", "thumb", "page", "summary", "author"):
        value = detected.get(kind) or ""
        shown = (value[:58] + "...") if len(value) > 58 else value
        print(f"  {kind:<8} {shown or '(not found)'}")

    gaps = [k for k in ("title", "image") if not detected.get(k)]
    print()
    if not gaps:
        print("Nothing to map by hand - the defaults read this API correctly.")
    else:
        print(f"Set these by hand, since auto-detection missed them: "
              f"{', '.join(gaps)}")
        print("Pick the right key from the record above; dotted paths work,")
        print("for example media.large or images.0.url.")
    return 0


def cmd_connectors(args: argparse.Namespace) -> int:
    if getattr(args, "login", None):
        return _login(args)
    if getattr(args, "set_id", None):
        return _set_credentials(args)
    if getattr(args, "inspect", None):
        return _inspect_api(args)

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
