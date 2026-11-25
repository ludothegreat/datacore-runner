'use strict';

// Windows starts a screensaver with one of three switches:
//   /s            run it full screen
//   /p <hwnd>     draw a preview inside the little monitor in the settings dialog
//   /c or /c:<hwnd>, or nothing at all: show its settings
// Letters can be either case and the prefix can be / or -.

/**
 * @param {string[]} argv everything after the program name
 * @returns {{mode: 'run' | 'preview' | 'config', hwnd: string | null}}
 */
function parseArgs(argv) {
  for (let i = 0; i < argv.length; i++) {
    const m = /^[/-]([scp])(?::(\d+))?$/i.exec(argv[i]);
    if (!m) continue;
    const letter = m[1].toLowerCase();
    const next = /^\d+$/.test(argv[i + 1] ?? '') ? argv[i + 1] : null;
    const hwnd = m[2] ?? next;
    if (letter === 's') return { mode: 'run', hwnd: null };
    if (letter === 'p') return { mode: 'preview', hwnd };
    return { mode: 'config', hwnd };
  }
  return { mode: 'config', hwnd: null };
}

module.exports = { parseArgs };
