// VO Timer — voice activity timing engine.
// Fed one level reading (dBFS) per analysis frame, with the frame's start time
// taken from the audio clock. Start and end are both measured on that same
// clock, so input latency cancels out of every duration.
(function (root) {
  'use strict';

  class Detector {
    /**
     * @param {object} o
     * @param {number} o.thresholdDb   level that counts as voice onset
     * @param {number} o.releaseDb     dB below threshold that still counts as voice (catches word tails)
     * @param {number} o.attackMs      sound must stay above threshold this long to start the clock
     * @param {number} o.resumeMs      sound after a gap must last this long to count as speech again
     * @param {number} o.holdMs        silence this long ends the take
     * @param {number} o.pauseMinMs    gaps at least this long are recorded as pauses
     * @param {number} o.quietMs       after arming, the room must be quiet this long before listening starts
     * @param {number} o.minMs         never stop before this much time since the start (pauses before it can't end the take)
     * @param {number} o.maxMs         safety stop
     */
    constructor(o) {
      this.o = Object.assign({ thresholdDb: -45, releaseDb: 4, attackMs: 60, resumeMs: 40, holdMs: 700, pauseMinMs: 120, quietMs: 200, minMs: 0, maxMs: 120000 }, o || {});
      this.reset();
    }

    reset() {
      this.state = 'armed';      // armed -> speaking -> done
      this.ready = !(this.o.quietMs > 0);   // armed and the room has been quiet long enough to listen
      this.quietRun = 0;
      this.runStart = null;      // first frame of the current above-threshold run
      this.runLen = 0;
      this.start = null;
      this.lastSound = null;     // end time of the last confirmed sound
      this.gapStart = null;      // start of the current silence (null while sounding)
      this.resumeStart = null;
      this.resumeLen = 0;
      this.pauses = [];          // [{start, end}] gaps inside the take
      this.end = null;
      this.now = null;
    }

    /** Returns 'start' | 'stop' | null for this frame. */
    push(t, db, frameSec) {
      const o = this.o;
      this.now = t + frameSec;
      if (this.state === 'done') return null;

      if (this.state === 'armed') {
        // Wait for the room to be quiet first (a speaker tail or echo can't start the clock).
        if (!this.ready) {
          if (db < o.thresholdDb) { this.quietRun += frameSec; if (this.quietRun * 1000 >= o.quietMs) this.ready = true; }
          else this.quietRun = 0;
          return null;
        }
        if (db >= o.thresholdDb) {
          if (this.runStart === null) this.runStart = t;
          this.runLen += frameSec;
          if (this.runLen * 1000 >= o.attackMs) {
            this.state = 'speaking';
            this.start = this.runStart;
            this.lastSound = t + frameSec;
            return 'start';
          }
        } else {
          this.runStart = null;
          this.runLen = 0;
        }
        return null;
      }

      // speaking
      const voiced = db >= o.thresholdDb - o.releaseDb;
      if (voiced) {
        if (this.gapStart === null) {
          this.lastSound = t + frameSec;            // continuous speech
        } else {
          if (this.resumeStart === null) this.resumeStart = t;
          this.resumeLen += frameSec;
          if (this.resumeLen * 1000 >= o.resumeMs) { // speech has resumed after a gap
            const gap = this.resumeStart - this.gapStart;
            if (gap * 1000 >= o.pauseMinMs) this.pauses.push({ start: this.gapStart, end: this.resumeStart });
            this.gapStart = null;
            this.resumeStart = null;
            this.resumeLen = 0;
            this.lastSound = t + frameSec;
          }
        }
      } else {
        if (this.gapStart === null) this.gapStart = this.lastSound;
        this.resumeStart = null;
        this.resumeLen = 0;
      }

      const sinceStart = (this.now - this.start) * 1000;
      const silent = (this.now - this.lastSound) * 1000 >= o.holdMs;
      if ((silent && sinceStart >= o.minMs) || sinceStart >= o.maxMs) {
        this.state = 'done';
        this.end = this.lastSound;
        return 'stop';
      }
      return null;
    }

    /** End the take now (the reader tapped to finish). The end is the last sound, as with an automatic stop. */
    finish() {
      if (this.state !== 'speaking') return false;
      this.state = 'done';
      this.end = this.lastSound;
      return true;
    }

    /** Seconds since the start, held at the last sound once there's been quiet for pauseSec. */
    shown(pauseSec) {
      if (this.start === null) return 0;
      if (this.state === 'done') return this.end - this.start;
      return (this.now - this.lastSound > pauseSec ? this.lastSound : this.now) - this.start;
    }

    get elapsed() {
      if (this.start === null) return 0;
      return (this.state === 'done' ? this.end : this.now) - this.start;
    }

    get duration() { return this.state === 'done' ? this.end - this.start : null; }

    /**
     * Split a finished take into n parts at its n-1 longest pauses.
     * Returns [{start, end, dur}] or null when there are too few pauses.
     */
    split(n) {
      if (this.state !== 'done') return null;
      if (n <= 1) return [{ start: this.start, end: this.end, dur: this.end - this.start }];
      const inside = this.pauses.filter(p => p.end <= this.end);
      if (inside.length < n - 1) return null;
      const cuts = inside.slice().sort((a, b) => (b.end - b.start) - (a.end - a.start)).slice(0, n - 1)
        .sort((a, b) => a.start - b.start);
      const parts = [];
      let s = this.start;
      for (const c of cuts) { parts.push({ start: s, end: c.start, dur: c.start - s }); s = c.end; }
      parts.push({ start: s, end: this.end, dur: this.end - s });
      return parts;
    }
  }

  /** Threshold from a room-tone sample and a voice sample (arrays of dB readings). */
  function suggestThreshold(roomDb, voiceDb) {
    const pct = (arr, p) => { const a = arr.slice().sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p * a.length))]; };
    const floor = pct(roomDb, 0.95);
    if (!voiceDb || !voiceDb.length) return Math.round(floor + 10);
    const voice = pct(voiceDb, 0.6);
    const thr = floor + Math.max(6, (voice - floor) * 0.35);
    return Math.round(Math.min(thr, voice - 6));
  }

  /** Colour band for a take. */
  function grade(measured, target, tol) {
    const d = measured - target;
    return { delta: d, band: d <= 0 ? 'good' : d <= tol ? 'close' : 'over' };
  }

  const api = { Detector, suggestThreshold, grade };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.VOT = api;
})(typeof self !== 'undefined' ? self : this);
