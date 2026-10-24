# VO Timer

A script and timing guide for voice-over practice, built for a Galaxy Tab S6 in Chrome.

- Shows the script with a target time for every line.
- Plays any line or section of a reference read.
- **Arm**, then read: the clock starts on your first word and stops when you go quiet.
- Green = at or under target, yellow = slightly over, red = over.

The real recording happens on your own equipment. The tablet's mic is only used for timing.

## Privacy

Everything runs in the browser. Project files (script, reference audio, timings) are opened from the
tablet and stored only in that browser's local storage. Nothing is uploaded, and no script or audio
lives in this repository.

## Project files

A project file is JSON with `"format": "vo-timer/1"`: sections, lines, each line's start/end in the
reference audio, target duration, room after, and optional pace marks (`!!`, `!!!`). The reference
audio can be embedded as base64 or opened alongside as an mp3.

## Keys

Space / Enter: arm or cancel · Arrow keys / Page Up / Page Down: previous or next line · P: play.
Bluetooth page-turner pedals that send arrow or page keys work for moving between lines.
