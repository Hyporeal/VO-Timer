#!/usr/bin/env python3
"""VO Timer project maker.

Turns a script (.docx, .txt or .md, laid out as in FORMAT.md) into a VO Timer project file.

  With --audio   every line is timed from a rough read (needs ffmpeg and faster-whisper).
  Without it     the times written in the script are used.

Writes to --out:
  <name>.votimer.json   project file for the app
  <name>_TIMED.docx     the script with times written above each section
  <name>_report.txt     summary table and anything worth checking

  python3 tools/make_project.py script.docx --audio rough.mp3 --title "Spot name" --out out/
  python3 tools/make_project.py script.docx --dry-run      # show how the script was split, then stop
"""
import argparse, base64, datetime, difflib, hashlib, json, os, re, statistics, subprocess, sys

FORMAT = 'vo-timer/1'
TIME_ONLY = re.compile(r'^\s*((?:\d+:)?\d+(?:\.\d+)?)\s*(!{2,3})?\s*$')
LINE_TIME = re.compile(r'\s*\[\s*((?:\d+:)?\d+(?:\.\d+)?)\s*(!{2,3})?\s*\]\s*$')
TITLE_MAX_WORDS = 6


def parse_time(s):
    if ':' in s:
        m, sec = s.split(':', 1)
        return int(m) * 60 + float(sec)
    return float(s)


# ---------------------------------------------------------------- reading

def read_docx(path):
    from docx import Document
    from docx.oxml.ns import qn
    doc = Document(path)

    def struck(r):
        rpr = r.find(qn('w:rPr'))
        if rpr is None:
            return False
        for tag in ('w:strike', 'w:dstrike'):
            e = rpr.find(qn(tag))
            if e is not None and e.get(qn('w:val')) not in ('0', 'false', 'none'):
                return True
        return False

    def list_level(p):
        ppr = p._p.pPr
        num = ppr.numPr if ppr is not None else None
        if num is None and p.style is not None and p.style.element.pPr is not None:
            num = p.style.element.pPr.numPr
        if num is None:
            return None
        ilvl = num.ilvl
        return int(ilvl.val) if ilvl is not None else 0

    items = []
    for p in doc.paragraphs:
        parts = []
        for r in p._p.iter(qn('w:r')):
            par = r.getparent()
            if par is not None and par.tag in (qn('w:del'), qn('w:moveFrom')):
                continue
            if struck(r):
                continue
            for node in r:
                if node.tag == qn('w:t'):
                    parts.append(node.text or '')
                elif node.tag in (qn('w:br'), qn('w:cr')):
                    parts.append('\n')
                elif node.tag == qn('w:tab'):
                    parts.append(' ')
        text = ''.join(parts).replace('​', '')
        style = (p.style.name if p.style is not None else '') or ''
        if re.match(r'(?i)(heading|title)', style) and text.strip():
            items.append({'kind': 'heading', 'text': text.strip()})
            continue
        level = list_level(p)
        segs = text.split('\n')
        if not text.strip():
            items.append({'kind': 'blank'})
            continue
        for k, seg in enumerate(segs):
            if not seg.strip():
                items.append({'kind': 'blank'})
            else:
                items.append({'kind': 'text', 'text': seg.strip(), 'level': level if k == 0 else (level if level is not None else None)})
    return items


def read_text(path):
    raw = open(path, encoding='utf-8-sig').read().splitlines()
    rows = []
    for line in raw:
        line = line.replace('\t', '    ').rstrip()
        if not line.strip():
            rows.append(('blank', None, None))
            continue
        m = re.match(r'^(\s*)(?:[-*•]|\d+[.)])\s+(.*)$', line)
        if m:
            rows.append(('bullet', len(m.group(1)), m.group(2)))
        elif line.lstrip().startswith('#'):
            rows.append(('heading', None, line.lstrip().lstrip('#').strip()))
        else:
            rows.append(('text', None, line.strip()))
    indents = sorted({r[1] for r in rows if r[0] == 'bullet'})
    items = []
    for kind, ind, txt in rows:
        if kind == 'blank':
            items.append({'kind': 'blank'})
            continue
        txt = re.sub(r'~~.*?~~', '', txt)
        txt = re.sub(r'(\*\*|__)(.+?)\1', r'\2', txt).strip()
        if not txt:
            continue
        if kind == 'heading':
            items.append({'kind': 'heading', 'text': txt})
        else:
            items.append({'kind': 'text', 'text': txt, 'level': indents.index(ind) if kind == 'bullet' else None})
    return items


def read_script(path):
    ext = os.path.splitext(path)[1].lower()
    if ext == '.docx':
        return read_docx(path)
    if ext in ('.txt', '.md', '.markdown', ''):
        return read_text(path)
    raise SystemExit(f'Unsupported script type: {ext} (use .docx, .txt or .md)')


# ---------------------------------------------------------------- structure

def build_sections(items):
    """Split reader items into sections of lines, following FORMAT.md."""
    sections, cur = [], None
    pending_time, pending_heading = None, None
    ignored = []

    def has_children(i):
        lvl = items[i].get('level')
        for j in range(i + 1, len(items)):
            it = items[j]
            if it['kind'] == 'blank':
                continue
            return it['kind'] == 'text' and it.get('level') is not None and it['level'] > lvl
        return False

    def open_section():
        nonlocal cur, pending_time, pending_heading
        cur = {'label': pending_heading, 'target': None, 'mark': '', 'lines': []}
        if pending_time:
            cur['target'], cur['mark'] = pending_time
        pending_time, pending_heading = None, None
        sections.append(cur)

    for i, it in enumerate(items):
        k = it['kind']
        if k == 'blank':
            cur = None
            continue
        if k == 'heading':
            cur = None
            pending_heading = it['text']
            continue
        t = it['text'].strip()
        if t.upper() == '[END]':
            break
        if t.startswith('//') or t.upper().startswith('[SKIP]') or (t.startswith('[') and t.endswith(']') and not LINE_TIME.fullmatch(t)):
            ignored.append(t)
            continue
        m = TIME_ONLY.match(t)
        if m:
            cur = None
            pending_time = (parse_time(m.group(1)), m.group(2) or '')
            continue
        line = {'text': t, 'title': False, 'target': None, 'mark': ''}
        lm = LINE_TIME.search(t)
        if lm:
            line['text'] = t[:lm.start()].rstrip()
            line['target'], line['mark'] = parse_time(lm.group(1)), lm.group(2) or ''
        lvl = it.get('level')
        if lvl is not None and has_children(i):
            open_section()
            line['title'] = True
        elif cur is None:
            open_section()
            if line['text'].endswith(':') and len(line['text'].split()) <= TITLE_MAX_WORDS:
                line['title'] = True
        if line['title'] and not cur['label']:
            cur['label'] = line['text'].rstrip(':').strip()
        cur['lines'].append(line)
    return [s for s in sections if s['lines']], ignored


# ---------------------------------------------------------------- syllables & tokens

_pron = None


def syllables(word):
    global _pron
    if _pron is None:
        try:
            import pronouncing as _p
            _pron = _p
        except ImportError:
            _pron = False
    w = word.strip("'")
    if not w:
        return 0
    if w.isdigit():
        return max(1, len(w))
    if w.isupper() and w.isalpha() and len(w) <= 5:
        return sum(3 if c == 'W' else 1 for c in w)
    pieces = re.findall(r'[A-Z]+(?![a-z])|[A-Z]?[a-z]+', w)
    if len(pieces) > 1:
        return sum(syllables(p) for p in pieces)
    lw = w.lower()
    if _pron:
        ph = _pron.phones_for_word(lw)
        if ph:
            return _pron.syllable_count(ph[0])
    groups = re.findall(r'[aeiouy]+', re.sub(r'(?<=[^aeiou])e$', '', lw))
    return max(1, len(groups))


def words_of(text):
    return re.findall(r"[A-Za-z0-9']+", text)


def norm(w):
    return w.lower().replace("'", '')


def line_syllables(text):
    return sum(syllables(w) for w in words_of(text))


# ---------------------------------------------------------------- audio

def load_audio(path, sr=16000):
    import numpy as np
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-f', 'f32le', '-ac', '1', '-ar', str(sr), '-'],
                         check=True, capture_output=True).stdout
    return np.frombuffer(raw, dtype='float32')


_model = None


def transcribe(audio, offset=0.0, model_name='small.en'):
    global _model
    from faster_whisper import WhisperModel
    if _model is None:
        _model = WhisperModel(model_name, device='cpu', compute_type='int8')
    segs, _ = _model.transcribe(audio, word_timestamps=True, beam_size=5, vad_filter=False)
    out = []
    for s in segs:
        for w in s.words:
            out.append({'word': w.word.strip(), 'start': w.start + offset, 'end': w.end + offset})
    return out


def token_stream(words):
    toks, owner = [], []
    for i, w in enumerate(words):
        for t in words_of(w['word']):
            toks.append(norm(t))
            owner.append(i)
    return toks, owner


def align(script_toks, trans_toks):
    """Map each script token to a transcript token index (or None). Returns (match, fuzzy)."""
    sm = difflib.SequenceMatcher(None, script_toks, trans_toks, autojunk=False)
    match, fuzzy = [None] * len(script_toks), [False] * len(script_toks)
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == 'equal':
            for k in range(i2 - i1):
                match[i1 + k] = j1 + k
        elif tag == 'replace':
            n1, n2 = i2 - i1, j2 - j1
            if max(n1, n2) <= 2 * min(n1, n2):
                for k in range(n1):
                    match[i1 + k] = j1 + min(n2 - 1, int(k * n2 / n1))
                    fuzzy[i1 + k] = True
    return match, fuzzy


def time_lines_from_audio(sections, audio_path, model_name, log):
    import numpy as np
    sr = 16000
    audio = load_audio(audio_path, sr)
    duration = len(audio) / sr
    log(f'Transcribing {duration:.1f} s of audio with {model_name}...')
    words = transcribe(audio, 0.0, model_name)
    trans_toks, owner = token_stream(words)

    flat = [ln for s in sections for ln in s['lines']]
    s_toks, s_line, s_orig = [], [], []
    for li, ln in enumerate(flat):
        for w in words_of(ln['text']):
            s_toks.append(norm(w)); s_line.append(li); s_orig.append(w)
    match, fuzzy = align(s_toks, trans_toks)

    misreads, missing_words = [], {}
    for li, ln in enumerate(flat):
        idx = [k for k in range(len(s_toks)) if s_line[k] == li]
        ln['_tok'] = idx
        got = [k for k in idx if match[k] is not None]
        ln['_cov'] = len(got) / max(1, len(idx))
        ln['_hits'] = got

    def place(ln, wlist, hits, toks_match, toks_orig, used):
        """Set start/end from matched words. Script words at either edge that weren't matched
        take the timing of unclaimed transcript words next to them (usually the same word,
        misheard); failing that, a syllable-based estimate."""
        first, last = hits[0], hits[-1]
        i0, i1 = toks_match(first), toks_match(last)
        start, end = wlist[i0]['start'], wlist[i1]['end']
        end = min(end, wlist[i1]['start'] + 0.15 + 0.22 * syllables(toks_orig(last)))
        lead = [k for k in ln['_tok'] if k < first]
        trail = [k for k in ln['_tok'] if k > last]
        if lead:
            j, n = i0 - 1, 0
            while j >= 0 and n <= len(lead) and j not in used and wlist[j + 1]['start'] - wlist[j]['end'] < 0.6:
                start = wlist[j]['start']; j -= 1; n += 1
            if n == 0:
                start -= 0.2 * sum(syllables(toks_orig(k)) for k in lead)
        if trail:
            j, n = i1 + 1, 0
            while j < len(wlist) and n <= len(trail) and j not in used and wlist[j]['start'] - wlist[j - 1]['end'] < 0.6:
                end = wlist[j]['start'] + 0.15 + 0.22 * syllables(wlist[j]['word'] or 'a'); j += 1; n += 1
            if n == 0:
                end += 0.2 * sum(syllables(toks_orig(k)) for k in trail)
        ln['start'], ln['end'] = start, end

    kept = []
    used = {owner[m] for m in match if m is not None}
    for li, ln in enumerate(flat):
        if ln['_cov'] >= 0.5:
            place(ln, words, ln['_hits'], lambda k: owner[match[k]], lambda k: s_orig[k], used)
            ln['_status'] = 'ok'
            kept.append(li)
        else:
            ln['_status'] = 'missing'

    # second pass: lines between two placed lines that the full transcript missed
    if kept:
        for li, ln in enumerate(flat):
            if ln['_status'] != 'missing' or li < kept[0] or li > kept[-1]:
                continue
            prev = max(k for k in kept if k < li); nxt = min(k for k in kept if k > li)
            t0, t1 = flat[prev]['end'], flat[nxt]['start']
            if t1 - t0 < 0.3:
                continue
            seg = audio[int(max(0, t0 - 0.1) * sr):int((t1 + 0.1) * sr)]
            ww = transcribe(seg, max(0, t0 - 0.1), model_name)
            tt, own = token_stream(ww)
            lt = [s_toks[k] for k in ln['_tok']]
            m2, f2 = align(lt, tt)
            hits = [ln['_tok'][j] for j in range(len(lt)) if m2[j] is not None]
            if ww and len(hits) / max(1, len(lt)) >= 0.34:
                pos = {ln['_tok'][j]: m2[j] for j in range(len(lt))}
                place(ln, ww, hits, lambda k: own[pos[k]], lambda k: s_orig[k], set())
                ln['_status'] = 'recovered'
                kept.append(li); kept.sort()

    for k in range(len(s_toks)):
        ln = flat[s_line[k]]
        if ln['_status'] != 'ok':
            continue
        if match[k] is None:
            missing_words.setdefault(s_line[k], []).append(s_orig[k])
        elif fuzzy[k]:
            heard = words[owner[match[k]]]['word'].strip(' .,;:!?')
            if difflib.SequenceMatcher(None, norm(s_orig[k]), norm(heard)).ratio() < 0.8:
                misreads.append((s_line[k], s_orig[k], heard))

    # drop what was never read, then tidy overlaps and compute room
    dropped = [ln for ln in flat if ln['_status'] == 'missing']
    for s in sections:
        s['lines'] = [ln for ln in s['lines'] if ln['_status'] != 'missing']
    sections[:] = [s for s in sections if s['lines']]
    flat = [ln for s in sections for ln in s['lines']]
    for i, ln in enumerate(flat):
        ln['start'] = max(0.0, ln['start'])
        if i and ln['start'] < flat[i - 1]['end']:
            ln['start'] = flat[i - 1]['end']
        if i + 1 < len(flat) and ln['end'] > flat[i + 1]['start']:
            ln['end'] = max(ln['start'] + 0.1, flat[i + 1]['start'])
    for i, ln in enumerate(flat):
        nxt = flat[i + 1]['start'] if i + 1 < len(flat) else duration
        ln['dur'] = ln['end'] - ln['start']
        ln['roomAfter'] = max(0.0, nxt - ln['end'])
    for si, s in enumerate(sections):
        s['start'], s['end'] = s['lines'][0]['start'], s['lines'][-1]['end']
        s['dur'] = s['end'] - s['start']
        nxt = sections[si + 1]['lines'][0]['start'] if si + 1 < len(sections) else duration
        s['roomAfter'] = max(0.0, nxt - s['end'])
    return {
        'duration': duration,
        'dropped': [ln['text'] for ln in dropped],
        'recovered': [ln['text'] for ln in flat if ln['_status'] == 'recovered'],
        'misreads': misreads, 'missing_words': missing_words,
    }


def mark_for(sps, room):
    if sps >= 7.5 or (sps >= 7.0 and room < 0.5):
        return '!!!'
    if sps >= 6.5 or (sps >= 6.0 and room < 0.5):
        return '!!'
    return ''


def apply_marks(sections):
    for s in sections:
        for ln in s['lines']:
            ln['syl'] = line_syllables(ln['text'])
            ln['sps'] = ln['syl'] / ln['dur'] if ln['dur'] > 0 else 0
            ln['mark'] = '' if ln['title'] else mark_for(ln['sps'], ln['roomAfter'])
        body = [ln for ln in s['lines'] if not ln['title']] or s['lines']
        s['mark'] = max((ln['mark'] for ln in body), key=len)


def apply_script_times(sections):
    """Script-only mode: targets come from the script; split section times by syllables."""
    dropped = []
    for s in sections:
        for ln in s['lines']:
            ln['syl'] = line_syllables(ln['text'])
        known = [ln for ln in s['lines'] if ln['target'] is not None]
        if s['target'] is None and len(known) == len(s['lines']):
            s['target'] = sum(ln['target'] for ln in known)
        if s['target'] is None:
            dropped.append(s)
            continue
        rest = [ln for ln in s['lines'] if ln['target'] is None]
        left = max(0.0, s['target'] - sum(ln['target'] for ln in known))
        tot = sum(ln['syl'] for ln in rest) or 1
        for ln in s['lines']:
            if ln['target'] is None:
                ln['dur'], ln['est'] = left * ln['syl'] / tot, len(rest) > 1
            else:
                ln['dur'], ln['est'] = ln['target'], False
            ln['roomAfter'] = 0.0
            ln['sps'] = ln['syl'] / ln['dur'] if ln['dur'] > 0 else 0
        s['dur'], s['roomAfter'] = s['target'], 0.0
        if not s['mark']:
            s['mark'] = max((ln['mark'] for ln in s['lines']), key=len)
    for s in dropped:
        sections.remove(s)
    return [ln['text'] for s in dropped for ln in s['lines']]


# ---------------------------------------------------------------- output

def tc(x):
    return f'{int(x // 60)}:{x % 60:05.2f}'


def write_docx(path, title, sections, mode):
    from docx import Document
    from docx.shared import RGBColor, Pt
    from docx.oxml import parse_xml
    gray = RGBColor(0x80, 0x80, 0x80)
    doc = Document()
    doc.add_heading(title, level=1)
    p = doc.add_paragraph()
    r = p.add_run(('Timed from the rough read. ' if mode == 'audio' else 'Times from the script. ')
                  + 'Gray number above each section = its time; small gray number after a line = that line alone.')
    r.font.size = Pt(9); r.font.color.rgb = gray
    for s in sections:
        p = doc.add_paragraph()
        r = p.add_run(f"{s['dur']:.2f}0{s['mark']}"); r.font.color.rgb = gray
        if mode == 'audio':
            r = p.add_run(f"   starts {tc(s['start'])} · room after {s['roomAfter']:.2f} s"); r.font.color.rgb = gray; r.font.size = Pt(9)
        if s['label'] and not s['lines'][0]['title']:
            q = doc.add_paragraph(); q.add_run(s['label']).bold = True
        for ln in s['lines']:
            q = doc.add_paragraph()
            run = q.add_run(ln['text']); run.bold = ln['title']
            if len(s['lines']) > 1 or ln['title']:
                g = q.add_run(f"   {'~' if ln.get('est') else ''}{ln['dur']:.2f}{ln['mark']}"); g.font.color.rgb = gray; g.font.size = Pt(9)
        doc.add_paragraph()
    doc.add_page_break()
    doc.add_paragraph().add_run('Timing summary').bold = True
    t = doc.add_table(rows=1, cols=6)
    t._tbl.tblPr.append(parse_xml('<w:tblBorders xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
                                   + ''.join(f'<w:{e} w:val="single" w:sz="4" w:color="BFBFBF"/>' for e in ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'])
                                   + '</w:tblBorders>'))
    for c, txt in zip(t.rows[0].cells, ['Section', 'Starts', 'Time', 'Room after', 'Peak syl/s', 'Mark']):
        c.text = txt
    for i, s in enumerate(sections):
        row = t.add_row().cells
        name = s['label'] or s['lines'][0]['text']
        peak = max((ln['sps'] for ln in s['lines'] if not ln['title']), default=0)
        vals = [name[:48], tc(s['start']) if mode == 'audio' else '', f"{s['dur']:.2f}0", f"{s['roomAfter']:.2f}" if mode == 'audio' else '', f'{peak:.1f}', s['mark']]
        for c, txt in zip(row, vals):
            c.text = txt
    doc.save(path)


def main():
    ap = argparse.ArgumentParser(description='Make a VO Timer project file from a script.')
    ap.add_argument('script')
    ap.add_argument('--audio', help='rough read (mp3, wav, ...) to time the lines from')
    ap.add_argument('--title', help='project title shown in the app (default: script file name)')
    ap.add_argument('--out', default='.', help='output folder')
    ap.add_argument('--model', default='small.en', help='faster-whisper model (default small.en)')
    ap.add_argument('--no-embed', action='store_true', help="don't build the reference audio into the project file")
    ap.add_argument('--dry-run', action='store_true', help='show how the script was split, then stop')
    a = ap.parse_args()

    items = read_script(a.script)
    sections, ignored = build_sections(items)
    if not sections:
        raise SystemExit('No lines found in the script.')

    if a.dry_run:
        for i, s in enumerate(sections, 1):
            tgt = f"  target {s['target']:.2f}{s['mark']}" if s['target'] is not None else ''
            print(f"S{i}  {s['label'] or ''}{tgt}")
            for ln in s['lines']:
                extra = f"  [{ln['target']:.2f}{ln['mark']}]" if ln['target'] is not None else ''
                print(f"    {'T ' if ln['title'] else '- '}{ln['text']}{extra}")
        if ignored:
            print('\nIgnored:', *ignored, sep='\n    ')
        return

    os.makedirs(a.out, exist_ok=True)
    stem = a.title or os.path.splitext(os.path.basename(a.script))[0]
    slug = re.sub(r'[^\w\-]+', '_', stem).strip('_') or 'project'
    log = lambda m: print(m, file=sys.stderr)
    notes = []
    if a.audio:
        mode = 'audio'
        info = time_lines_from_audio(sections, a.audio, a.model, log)
        apply_marks(sections)
        title = a.title or f'{stem} — rough'
    else:
        mode = 'script'
        dropped = apply_script_times(sections)
        if not sections:
            raise SystemExit('No timing found in the script. Add section times (e.g. "6.20!!" above a section) or pass --audio.')
        info = {'dropped': dropped, 'recovered': [], 'misreads': [], 'missing_words': {}, 'duration': None}
        title = a.title or stem

    flat = [ln for s in sections for ln in s['lines']]
    r3 = lambda x: round(x, 3)
    out_sections = []
    n = 0
    for si, s in enumerate(sections, 1):
        lines = []
        for ln in s['lines']:
            n += 1
            d = {'id': f'L{n}', 'text': ln['text'], 'title': ln['title'], 'dur': r3(ln['dur']), 'roomAfter': r3(ln['roomAfter']),
                 'syl': ln['syl'], 'sps': round(ln['sps'], 2), 'mark': ln['mark'], 'est': bool(ln.get('est'))}
            if mode == 'audio':
                d['start'], d['end'] = r3(ln['start']), r3(ln['end'])
            lines.append(d)
        sec = {'id': f'S{si}', 'label': s['label'], 'dur': r3(s['dur']), 'roomAfter': r3(s['roomAfter']), 'mark': s['mark'], 'lines': lines}
        if mode == 'audio':
            sec['start'], sec['end'] = r3(s['start']), r3(s['end'])
        out_sections.append(sec)

    ident = hashlib.sha1((title + '|' + '|'.join(ln['text'] for ln in flat)).encode()).hexdigest()[:12]
    proj = {'format': FORMAT, 'id': ident, 'title': title, 'created': datetime.date.today().isoformat(),
            'source': {'mode': mode}, 'sections': out_sections}
    if mode == 'audio':
        proj['audio'] = {'name': os.path.basename(a.audio), 'duration': r3(info['duration']), 'mime': 'audio/mpeg'}
        if not a.no_embed:
            enc = subprocess.run(['ffmpeg', '-v', 'error', '-i', a.audio, '-ac', '1', '-b:a', '96k', '-f', 'mp3', '-'],
                                 check=True, capture_output=True).stdout
            proj['audio']['data'] = base64.b64encode(enc).decode()
    jpath = os.path.join(a.out, f'{slug}.votimer.json')
    json.dump(proj, open(jpath, 'w'), ensure_ascii=False)
    dpath = os.path.join(a.out, f'{slug}_TIMED.docx')
    write_docx(dpath, title, sections, mode)

    # report
    L = [f'{title}', f"Mode: {'timed from rough read' if mode == 'audio' else 'times from script'}", '']
    if mode == 'audio':
        body = [ln['sps'] for ln in flat if not ln['title'] and ln['dur'] > 0.3]
        if body:
            L.append(f'Median pace: {statistics.median(body):.1f} syllables/s. Marks: !! at about 6.5+, !!! at about 7.5+, one level higher with under 0.5 s of room after.')
        L.append('Times are usually within about 0.15 s. A line right after a long pause can be off by up to about 0.3 s (word edges come from speech recognition).')
        L.append('')
    L.append(f"{'Section':42} {'Starts':>9} {'Time':>8} {'Room':>6} {'Peak':>5} Mark")
    for s in sections:
        peak = max((ln['sps'] for ln in s['lines'] if not ln['title']), default=0)
        name = (s['label'] or s['lines'][0]['text'])[:42]
        L.append(f"{name:42} {tc(s['start']) if mode == 'audio' else '':>9} {s['dur']:8.2f} {s['roomAfter'] if mode == 'audio' else 0:6.2f} {peak:5.1f} {s['mark']}")
    if info['dropped']:
        L += ['', 'Not in the read (left out):' if mode == 'audio' else 'No timing in the script (left out):'] + ['    ' + t for t in info['dropped']]
    if info['recovered']:
        L += ['', 'Found on a second listen. Check these times:'] + ['    ' + t for t in info['recovered']]
    if info['misreads']:
        L += ['', 'Possible misreads (or speech-recognition errors). Worth a listen:']
        for li, said, heard in info['misreads']:
            L.append(f'    "{said}" heard as "{heard}"')
    if ignored:
        L += ['', 'Ignored as notes or directions:'] + ['    ' + t for t in ignored]
    est = [ln['text'] for ln in flat if ln.get('est')]
    if est:
        L += ['', 'Line times estimated from the section time by syllable count:'] + ['    ' + t for t in est]
    rpath = os.path.join(a.out, f'{slug}_report.txt')
    open(rpath, 'w').write('\n'.join(L) + '\n')
    print(jpath); print(dpath); print(rpath)


if __name__ == '__main__':
    main()
