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
lives in this repository. The app makes no requests to other sites: fonts ship with it.

## Project files

A project file is JSON with `"format": "vo-timer/1"`: sections, lines, each line's start/end in the
reference audio, target duration, room after, and optional pace marks (`!!`, `!!!`). The reference
audio can be embedded as base64 or opened alongside as an mp3.

## Keys

Space / Enter: arm or cancel · Arrow keys / Page Up / Page Down: previous or next line · P: play.
Bluetooth page-turner pedals that send arrow or page keys work for moving between lines.

## Making a project file

`tools/make_project.py` turns a script into a project file. See [FORMAT.md](FORMAT.md) for how to lay
out the script.

```
pip install faster-whisper pronouncing python-docx      # ffmpeg must be installed too
python3 tools/make_project.py script.docx --dry-run                     # check how it was split
python3 tools/make_project.py script.docx --audio rough.mp3 --title "Spot name" --out out/
python3 tools/make_project.py timed_script.docx --out out/              # times already in the script
```

It writes the project file, a copy of the script with times written in, and a report listing
anything worth checking (lines not found in the read, possible misreads).
