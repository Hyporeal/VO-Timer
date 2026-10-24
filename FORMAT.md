# VO Timer formats

Two formats: the **script format** (how a script is laid out so it can be split into sections and
lines) and the **project file** (what the app loads).

## 1. Script format (v1)

Works in `.docx`, `.txt` and `.md`. A normal client script usually needs little or no editing.

### Sections and lines

| In the script | Meaning |
|---|---|
| Each paragraph, or each line inside a paragraph | One **line** to time |
| A blank line | Ends the current **section** |
| A top-level bullet that has sub-bullets under it | Starts a new section; the bullet is the section's spoken **title** (e.g. `Speed Mode:`) |
| A line ending in `:` at the start of a section | Spoken title for that section |
| A heading (`# Name` in text, Heading style in Word) | Section **name** shown in the app; not spoken |

### Things that are not read

| In the script | Meaning |
|---|---|
| ~~Strikethrough~~ text (Word) | Ignored |
| A line starting with `//` | Note; ignored |
| A line wrapped entirely in square brackets, e.g. `[Music swells]` | Direction; ignored |
| A line starting with `[SKIP]` | Ignored |
| A line that is exactly `[END]` | Everything after it is ignored |

When a rough read is supplied, lines that never appear in the read (a document title, an
alternate version at the bottom) are dropped automatically and listed in the report.

### Timing written in the script (for scripts without a rough read)

| In the script | Meaning |
|---|---|
| A line that is only a time, optionally with marks, directly above a section: `6.20!!` | That section's target time and pace mark |
| A time in brackets at the end of a line: `Line text [2.30]` or `[2.30!!]` | That line's target time and mark |

Times are seconds (`6.2`, `6.200`) or minutes and seconds (`1:04.5`).
Marks: `!!` = fast, `!!!` = very fast.
If only a section time is given, its lines get a share of it by syllable count (shown as estimates).

### Example (`.txt`)

```
# Opening
6.20!!
Welcome to the new way of working.
Every tool you need, in one place.

Speed Mode:
- Finishes routine work in seconds [2.10]
- Learns how your team works [2.40!!]

// Client may cut the next line
[SKIP] Available on all plans.

[END]
Alternate ending for the long version.
```

## 2. Project file (`vo-timer/1`)

JSON. File extension `.votimer.json` by convention.

```jsonc
{
  "format": "vo-timer/1",
  "id": "a1b2c3d4e5f6",          // stable id; takes are stored per id
  "title": "Spot name — rough",
  "created": "2026-10-24",
  "source": { "mode": "audio" },  // "audio" (timed from a rough read) or "script" (times written in the script)
  "audio": {                       // optional; omit for script-only projects
    "name": "reference.mp3", "duration": 92.4, "mime": "audio/mpeg",
    "data": "<base64>"             // optional; if absent, open the mp3 alongside the project file
  },
  "sections": [
    {
      "id": "S1", "label": null,   // label = spoken title or heading, or null
      "start": 1.2, "end": 7.4, "dur": 6.2, "roomAfter": 0.6, "mark": "!!",
      "lines": [
        { "id": "L1", "text": "First line of the script", "title": false,
          "start": 1.2, "end": 3.5, "dur": 2.3, "roomAfter": 0.4,
          "syl": 11, "sps": 4.78, "mark": "", "est": false }
      ]
    }
  ]
}
```

- `dur` is the target in **Strict** mode. **Window** mode adds `roomAfter`.
- `start`/`end` are positions in the reference audio (absent in script-only projects).
- `est: true` marks a target that was estimated rather than measured.
