// Keeps the picture smooth on any machine. When frames take too long it draws
// fewer pixels (a softer picture, the same world); when there is time to spare
// it gives them back. No graphics in here: frame times in, a scale out.
//
// Fewer pixels only help when drawing them is what is slow. Frames can be slow for
// other reasons (the rules being worked out while a card is dragged, a screen or a
// battery saver that caps the page at 30 frames a second), and then a softer picture
// buys nothing. So it checks that giving up pixels made frames faster, and if not,
// gives them back and leaves the picture alone for a while.

/** Frames slower than this are a struggle (under 45 a second)... */
const SLOW = 1 / 45;
/** ...and faster than this are comfortable (the screen's own pace, or better). */
const FAST = 1 / 57;
/** How long a struggle must last before pixels are given up, so one hitch changes nothing. */
const PATIENCE = 1.0;
/** How long things must run comfortably before trying a sharper picture again, to start with. */
const FIRST_WAIT = 4;
const LONGEST_WAIT = 60;
/** A struggle this soon after sharpening means the sharper picture was too much. */
const TRIAL = 3;
const STEP_DOWN = 0.8;
const STEP_UP = 1.15;
/** After this many steps down in a row, frames must be at least a tenth faster than before the first. */
const PROVE_AFTER = 2;
const WORTH_IT = 0.9;
/** How long to leave the picture alone after fewer pixels did not help, to start with (it doubles). */
const FIRST_REST = 30;
const LONGEST_REST = 600;

export class QualityGovernor {
  /** Share of the chosen sharpness to draw at: 1 = all of it, down to `least`. */
  scale = 1;
  private pace = FAST; // smoothed seconds per frame, with very long frames counted as merely slow
  private real = FAST; // the same without that cap: what a step down is judged by
  private calm = 0; // seconds since frames were last a struggle
  private slow = 0; // seconds spent struggling
  private fast = 0; // seconds spent comfortable
  private wait = FIRST_WAIT;
  private sinceUp = Infinity;
  /** The run of steps down under way: where it began, how slow frames were then, how many steps so far. */
  private runFrom = 1;
  private runPace = 0;
  private steps = 0;
  /** Seconds still to leave the picture alone, and how long the next such rest will be. */
  private rest = 0;
  private nextRest = FIRST_REST;

  constructor(readonly least = 0.4) {}

  /** Start again from full sharpness (the user chose a new quality). */
  reset(): void {
    this.scale = 1;
    this.pace = this.real = FAST;
    this.slow = this.fast = this.calm = 0;
    this.wait = FIRST_WAIT;
    this.sinceUp = Infinity;
    this.steps = 0;
    this.rest = 0;
    this.nextRest = FIRST_REST;
  }

  /**
   * Tell it how long the last frame took, in seconds. True when `scale` changed
   * (the caller then resizes what it draws into).
   */
  frame(seconds: number): boolean {
    // The window was hidden or the machine slept: that says nothing about drawing.
    if (!(seconds > 0) || seconds > 1) {
      this.slow = this.fast = 0;
      return false;
    }
    // One very long frame (a shader being built, a pause for housekeeping) counts as no more
    // than a plainly slow one: it takes a run of slow frames, not one bad one, to give up pixels.
    this.real += (seconds - this.real) * (1 - Math.exp(-seconds / 0.4));
    seconds = Math.min(seconds, 2 * SLOW);
    this.pace += (seconds - this.pace) * (1 - Math.exp(-seconds / 0.4));
    this.sinceUp += seconds;
    this.rest = Math.max(0, this.rest - seconds);
    if (this.pace > SLOW) {
      this.fast = this.calm = 0;
      if (this.rest > 0) return false; // fewer pixels did not help a moment ago: do not try again yet
      this.slow += seconds;
      if (this.slow < PATIENCE) return false;
      if (this.steps >= PROVE_AFTER && this.real > this.runPace * WORTH_IT) {
        // Well under half the pixels and frames are no faster: drawing is not what is slow.
        // Give the pixels back and leave the picture alone, for longer each time this happens.
        this.scale = this.runFrom;
        this.steps = 0;
        this.rest = this.nextRest;
        this.nextRest = Math.min(LONGEST_REST, this.nextRest * 2);
        this.settle();
        return true;
      }
      if (this.scale <= this.least) return false;
      if (this.steps === 0) {
        this.runFrom = this.scale;
        this.runPace = this.real;
      }
      // Sharpening just now is what did it: wait longer before trying that again.
      if (this.sinceUp < TRIAL) this.wait = Math.min(LONGEST_WAIT, this.wait * 2);
      this.scale = Math.max(this.least, this.scale * STEP_DOWN);
      this.steps++;
      this.settle();
      return true;
    }
    // Not struggling. Once that has lasted, whatever steps were taken did their job. (Not at once:
    // right after a step the smoothed pace starts afresh, and reads as fine for a moment.)
    this.slow = 0;
    this.calm += seconds;
    if (this.calm >= PATIENCE) this.steps = 0;
    if (this.pace < FAST && this.scale < 1) {
      this.fast += seconds;
      if (this.fast < this.wait) return false;
      this.scale = Math.min(1, this.scale * STEP_UP);
      this.settle();
      this.sinceUp = 0;
      return true;
    }
    this.fast = 0;
    return false;
  }

  /** After a change, judge the new size afresh rather than by the old size's frames. */
  private settle(): void {
    this.slow = this.fast = 0;
    this.pace = (SLOW + FAST) / 2;
  }
}
