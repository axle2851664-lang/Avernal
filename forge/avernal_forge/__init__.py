"""Avernal Forge - a fully local image generation app that is its own API provider.

No third-party generation APIs are ever contacted. Everything runs on the
machine that starts the server, and the server itself speaks an
OpenAI-compatible images API so other tools can use it as their provider.
"""

__version__ = "0.1.0"
__all__ = ["__version__"]
