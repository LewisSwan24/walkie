# Refuses the PlatformIO targets that would write outside app1. Loaded by platformio.ini (extra_scripts = pre:guard.py).
Import("env")  # noqa: F821
from SCons.Script import COMMAND_LINE_TARGETS

hit = {"erase", "uploadfs", "uploadfsota"}.intersection(COMMAND_LINE_TARGETS)
if hit:
    print("walkie: refusing 'pio run -t %s': it would overwrite flash outside app1 (on-the-beat lives in app0). "
          "Use tools/flash.mjs and tools/boot.mjs." % ", ".join(sorted(hit)))
    env.Exit(1)  # noqa: F821
