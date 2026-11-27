#!/usr/bin/env python3
"""Exercise render staging without launching office or Poppler."""
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.parse import unquote, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import check_deck


class RenderPathsTest(unittest.TestCase):
    def exercise(self, platform, pages=2):
        with tempfile.TemporaryDirectory(prefix="render-path-test-", dir="/tmp") as folder:
            root = Path(folder).resolve()
            source = root / "external volume with spaces" / "deck with spaces.pptx"
            source.parent.mkdir()
            source.write_bytes(b"presentation input")
            output = root / "requested output with spaces"
            output.mkdir()
            old_image = output / "slide-99.png"
            old_image.write_bytes(b"previous successful render")
            wrapper = root / "safe-converter.py"
            wrapper.touch()
            stages, profiles, commands = [], [], []

            def fake_run(command, timeout=60):
                commands.append(command)
                if command[0] == "/fake/pdftoppm":
                    pdf, prefix = Path(command[-2]), Path(command[-1])
                    self.assertEqual(pdf, stages[0] / "input.pdf")
                    self.assertEqual(prefix.parent.parent, output)
                    for number in range(1, pages + 1):
                        prefix.with_name(f"slide-{number}.png").write_bytes(b"preview")
                    return
                staged_input = Path(command[2] if platform == "darwin" else command[-1])
                self.assertNotEqual(staged_input, source)
                self.assertNotIn(" ", str(staged_input))
                self.assertEqual(staged_input.name, "input.pptx")
                self.assertEqual(staged_input.parent.parent, Path("/tmp").resolve())
                self.assertEqual(staged_input.read_bytes(), source.read_bytes())
                stages.append(staged_input.parent)
                if platform == "darwin":
                    self.assertEqual(command[1], str(wrapper))
                else:
                    profile_arg = next(arg for arg in command if arg.startswith("-env:UserInstallation="))
                    profile = Path(unquote(urlparse(profile_arg.split("=", 1)[1]).path))
                    self.assertTrue(profile.is_dir())
                    self.assertNotIn(" ", str(profile))
                    self.assertEqual(profile.parent.resolve(), Path("/tmp").resolve())
                    profiles.append(profile)
                destination = Path(command[command.index("--outdir") + 1])
                self.assertEqual(destination, staged_input.parent)
                (destination / "input.pdf").write_bytes(b"converted PDF")

            with patch.object(check_deck.sys, "platform", platform), \
                    patch.object(check_deck, "locate", side_effect=lambda name: "/fake/" + name), \
                    patch.object(check_deck, "run", side_effect=fake_run):
                if pages != 2:
                    with self.assertRaisesRegex(RuntimeError, "rendered 1 pages for 2 slides"):
                        check_deck.render(source, output, 2, safe_converter=wrapper)
                    self.assertEqual(old_image.read_bytes(), b"previous successful render")
                    self.assertFalse((output / "slide-1.png").exists())
                else:
                    report = check_deck.render(source, output, 2, safe_converter=wrapper)
                    self.assertEqual(report["status"], "passed")
                    self.assertEqual(Path(report["pdf"]), output / "deck with spaces.pdf")
                    self.assertEqual(Path(report["pdf"]).read_bytes(), b"converted PDF")
                    self.assertEqual([Path(p).name for p in report["pngs"]], ["slide-1.png", "slide-2.png"])
                    self.assertTrue(all(Path(p).parent == output for p in report["pngs"]))
                    self.assertFalse(old_image.exists())
            self.assertEqual(len(commands), 2)
            self.assertTrue(all(not p.exists() for p in stages + profiles))
            self.assertFalse(list(output.glob(".deck-preview-*")))
            self.assertEqual(source.read_bytes(), b"presentation input")

    def test_linux_copies_space_path_and_isolates_profile(self):
        self.exercise("linux")

    def test_mac_passes_temp_copy_to_safe_wrapper(self):
        self.exercise("darwin")

    def test_incomplete_render_keeps_previous_previews(self):
        self.exercise("linux", pages=1)


if __name__ == "__main__":
    unittest.main()
