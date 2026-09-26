"""Structural checks that catch whole classes of mistake cheaply.

Each of these exists because the mistake it catches actually happened during
development, in code that no runtime test reached: a dataclass field renamed
in one place but not another, a test class appended after the entry point and
silently never run, JavaScript reaching for an element that no longer exists.

They are static, so they cost nothing and cover the parts of the app a test
environment cannot execute.
"""

from __future__ import annotations

import ast
import dataclasses
import importlib
import pkgutil
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import avernal_forge  # noqa: E402
from avernal_forge.engines.base import GeneratedMedia  # noqa: E402


def python_sources() -> list[Path]:
    return sorted((ROOT / "avernal_forge").rglob("*.py"))


class TestTestFilesCollect(unittest.TestCase):
    def test_no_class_is_defined_after_the_entry_point(self):
        """`unittest.main()` runs where it appears, so anything defined below
        it is never collected - the file passes while testing less than it
        looks like it does."""
        offenders = []
        for path in sorted((ROOT / "tests").glob("test_*.py")):
            tree = ast.parse(path.read_text())
            main_line = None
            for node in tree.body:
                if isinstance(node, ast.If) and "__main__" in ast.dump(node.test):
                    main_line = node.lineno
            if main_line is None:
                continue
            stranded = [n.name for n in tree.body
                        if isinstance(n, ast.ClassDef) and n.lineno > main_line]
            if stranded:
                offenders.append(f"{path.name}: {stranded}")
        self.assertEqual(offenders, [], "test classes defined after unittest.main()")


class TestMediaConstruction(unittest.TestCase):
    def test_every_construction_uses_real_field_names(self):
        """The engines cannot all be executed here, so a renamed field would
        otherwise only show up on a machine with a GPU."""
        fields = {f.name for f in dataclasses.fields(GeneratedMedia)}
        offenders = []
        for path in python_sources():
            for node in ast.walk(ast.parse(path.read_text())):
                if (isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
                        and node.func.id in ("GeneratedMedia", "GeneratedImage")):
                    unknown = {kw.arg for kw in node.keywords if kw.arg} - fields
                    if unknown:
                        offenders.append(
                            f"{path.name}:{node.lineno} unknown {sorted(unknown)}")
        self.assertEqual(offenders, [])


class TestModules(unittest.TestCase):
    def test_every_module_imports_on_its_own(self):
        broken = []
        for module in pkgutil.walk_packages(avernal_forge.__path__,
                                            "avernal_forge."):
            try:
                importlib.import_module(module.name)
            except Exception as exc:
                broken.append(f"{module.name}: {type(exc).__name__}: {exc}")
        self.assertEqual(broken, [])

    def test_no_module_imports_torch_at_module_level(self):
        """Forge must start on a machine with nothing installed, so the heavy
        optional dependencies stay inside functions."""
        offenders = []
        for path in python_sources():
            tree = ast.parse(path.read_text())
            for node in tree.body:                      # top level only
                names = []
                if isinstance(node, ast.Import):
                    names = [a.name for a in node.names]
                elif isinstance(node, ast.ImportFrom):
                    names = [node.module or ""]
                for name in names:
                    if name.split(".")[0] in ("torch", "diffusers", "PIL",
                                              "numpy", "transformers"):
                        offenders.append(f"{path.name}:{node.lineno} {name}")
        self.assertEqual(offenders, [])


class TestServerRoutes(unittest.TestCase):
    def test_every_route_has_a_handler(self):
        from avernal_forge.server import ForgeHandler

        missing = [name for _, _, name in ForgeHandler.ROUTES
                   if not hasattr(ForgeHandler, name)]
        self.assertEqual(missing, [])

    def test_no_two_routes_share_a_method_and_pattern(self):
        from avernal_forge.server import ForgeHandler

        seen = [(method, pattern.pattern)
                for method, pattern, _ in ForgeHandler.ROUTES]
        self.assertEqual(len(seen), len(set(seen)))


class TestWebAssets(unittest.TestCase):
    def test_every_element_the_scripts_reach_for_exists(self):
        """A renamed or removed id shows up as a null dereference at runtime,
        in whichever panel happens to be opened."""
        html = (ROOT / "web" / "index.html").read_text()
        present = set(re.findall(r'id="([^"]+)"', html))

        offenders = []
        for name in ("app.js", "references.js"):
            source = (ROOT / "web" / name).read_text()
            # Ids the scripts create themselves are legitimate.
            created = set(re.findall(r'\.id\s*=\s*"([^"]+)"', source))
            used = set(re.findall(r'\$\("([^"]+)"\)', source))
            used |= set(re.findall(r'getElementById\("([^"]+)"\)', source))
            for identifier in sorted(used - present - created):
                offenders.append(f"{name}: #{identifier}")
        self.assertEqual(offenders, [])

    def test_the_page_loads_both_scripts(self):
        html = (ROOT / "web" / "index.html").read_text()
        self.assertIn('src="/app.js"', html)
        self.assertIn('src="/references.js"', html)

    def test_nothing_is_loaded_from_a_cdn(self):
        """The studio has to work with no network at all."""
        for name in ("index.html", "app.js", "references.js", "style.css"):
            source = (ROOT / "web" / name).read_text()
            for marker in ("https://cdn", "http://cdn", "unpkg.com",
                           "jsdelivr", "googleapis.com/css", "cdnjs"):
                self.assertNotIn(marker, source, f"{name} reaches off-machine")


class TestConnectorContract(unittest.TestCase):
    def test_every_connector_is_well_formed(self):
        import tempfile

        from avernal_forge.config import Config
        from avernal_forge.connectors import ConnectorHub, ConnectorStore

        home = Path(tempfile.mkdtemp())
        hub = ConnectorHub(Config(home=home), ConnectorStore(home / "c.json"))
        seen_ids = set()
        for connector in hub.connectors:
            self.assertTrue(connector.id, "a connector has no id")
            self.assertNotIn(connector.id, seen_ids, f"duplicate {connector.id}")
            seen_ids.add(connector.id)
            self.assertTrue(connector.label, connector.id)
            self.assertTrue(connector.description, connector.id)
            for field in connector.credential_fields:
                self.assertTrue(field.name, connector.id)
                self.assertTrue(field.label, connector.id)
            # A connector with no fixed domains must derive them from settings.
            if not connector.domains:
                self.assertTrue(
                    hasattr(connector, "extra_domains"),
                    f"{connector.id} can reach nothing and cannot widen",
                )

    def test_credential_fields_are_unique_per_connector(self):
        import tempfile

        from avernal_forge.config import Config
        from avernal_forge.connectors import ConnectorHub, ConnectorStore

        home = Path(tempfile.mkdtemp())
        hub = ConnectorHub(Config(home=home), ConnectorStore(home / "c.json"))
        for connector in hub.connectors:
            names = [f.name for f in connector.credential_fields]
            self.assertEqual(len(names), len(set(names)), connector.id)


if __name__ == "__main__":
    unittest.main(verbosity=2)
