# Datacore Runner

A small browser game and Windows screensaver set inside a holographic mainframe. You fly a
red-team payload through a grid of data towers; everything you pass turns from green to red
while a blue-team defender tries to undo it.

Built with [three.js](https://threejs.org/). The screensaver wraps the same page in
[Electron](https://www.electronjs.org/).

This is a test build. Expect rough edges.

## Windows screensaver

Download `DatacoreRunner-windows-test.zip` from the Releases page, unzip the whole folder and
read the `README.txt` inside. In short:

- Double-click `DatacoreRunner.scr` to try it. Move the mouse or press a key to exit.
- Right-click it and choose Install to make it your screensaver.
- Right-click it and choose Configure for the settings: clean (all green) or under attack
  (turns red as the camera passes), a PC stats panel, and main display only.

The build is not signed, so Windows shows a "Windows protected your PC" box the first time.
Choose More info, then Run anyway.

## Run the game in a browser

Needs Node.js 22.13 or newer and Python 3.10 or newer. The stats panel reads CPU, memory and
temperatures from `/proc` and `/sys`, so the dev server is Linux only.

```sh
npm install
npm start
```

Then open <http://127.0.0.1:4173/index.html>.

| Key | Action |
| --- | --- |
| A / D or Left / Right | queue a turn for the next junction |
| W / Up | go straight |
| S / Down | reverse |
| [ and ] | speed |
| P | pause |
| R | new level |
| F | PC stats panel |

Options go on the end of the address:

| Option | Effect |
| --- | --- |
| `?mode=saver` | screensaver camera, no game |
| `?mode=saver&corrupt=1` | screensaver that turns red as it passes |
| `&stats=1` | start with the stats panel open |
| `&seed=42` | repeatable level |
| `&scale=0.75` | pin the render scale instead of adapting it |
| `&quiet` | no debug logging in the console |

`runner.html` is the first straight-line concept demo, kept for reference.

## Build the Windows package

On Linux, with `curl`, `zip` and `unzip` installed:

```sh
npm run build:windows
```

It runs the lint, type check and tests, bundles the page with esbuild, downloads the stock
Electron build for Windows, checks its checksum, and writes
`dist/DatacoreRunner-windows-test.zip`.

## Checks

```sh
npm run check   # eslint and the TypeScript checker over the JavaScript
npm test        # screensaver argument parsing
```

## Layout

| Path | What it is |
| --- | --- |
| `main.js`, `index.html` | the game and the screensaver scene |
| `serve.py` | dev server: static files plus PC stats for the F panel |
| `desktop/` | Electron wrapper that turns the page into a `.scr` |
| `scripts/build-windows.sh` | packaging |
| `concept/` | concept art and the prompts that produced it (AI generated) |

## Known limits

- The preview monitor in the Windows screensaver dialog stays blank.
- No CPU temperature on Windows; GPU stats only with an NVIDIA card.
- More than one monitor has not been tested.
- Without a working graphics card (virtual machine, remote desktop) it is very slow.
- A solid red screen for a second or two was seen twice on one Intel laptop during testing
  and has not been reproduced since. Reports are welcome.

## License

MIT, see `LICENSE`. three.js and Electron are also MIT licensed; the Windows package
includes their license files.
