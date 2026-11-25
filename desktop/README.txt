DATACORE RUNNER SCREENSAVER - TEST BUILD
========================================

Windows 10 or 11, 64-bit.

INSTALL
1. Unzip the whole DatacoreRunner folder somewhere it can stay
   (for example C:\Users\<you>\DatacoreRunner). Keep all the files together.
2. Right-click DatacoreRunner.scr and choose Install.
   Windows opens its screensaver settings with Datacore Runner selected.
3. Set the wait time and press OK.

Windows may show a blue "Windows protected your PC" box the first time,
because this test build is not signed. Choose More info, then Run anyway.

TRY IT WITHOUT INSTALLING
Double-click DatacoreRunner.scr. Move the mouse or press a key to exit.

SETTINGS
Right-click DatacoreRunner.scr and choose Configure, or press Settings in
the Windows screensaver dialog.
- Mode: Clean system (all green) or Under attack (turns red as it passes).
- Show PC stats: CPU, memory, GPU and frame rate in the corner.
- Main display only: other displays go black.

KNOWN LIMITS OF THIS TEST BUILD
- The small preview monitor in the Windows dialog stays blank.
- PC stats show no CPU temperature on Windows.
- GPU stats only appear with an NVIDIA card.
- It needs a working graphics card. In a virtual machine, over remote
  desktop, or with missing graphics drivers it runs very slowly and
  uses a lot of CPU.

WHAT TO EXPECT
- On slower graphics the first few seconds can be choppy. It measures the
  frame rate, lowers its resolution once, and should then run smoothly.

PLEASE REPORT
- The whole screen turning solid red for a second or two. This was seen
  twice on one laptop during testing and has not been tracked down.
- Choppy animation that does not settle. Turn on Show PC stats and note
  the fps and render scale numbers.
- Anything odd with more than one monitor. That has not been tested.

REMOVE
Pick a different screensaver in Windows, then delete the folder.
Settings and a log file are in %APPDATA%\Datacore Runner.

IF SOMETHING GOES WRONG
Send the file %APPDATA%\Datacore Runner\datacore.log along with what you saw.
