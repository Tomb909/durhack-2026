// Keeps the picture smooth on any machine. When frames take too long it draws
// fewer pixels (a softer picture, the same world); when there is time to spare
// it gives them back. No graphics in here: frame times in, a scale out.

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

export class QualityGovernor {
  /** Share of the chosen sharpness to draw at: 1 = all of it, down to `least`. */
  scale = 1;
  private pace = FAST; // smoothed seconds per frame
  private slow = 0; // seconds spent struggling
  private fast = 0; // seconds spent comfortable
  private wait = FIRST_WAIT;
  private sinceUp = Infinity;

  constructor(readonly least = 0.4) {}

  /** Start again from full sharpness (the user chose a new quality). */
  reset(): void {
    this.scale = 1;
    this.pace = FAST;
    this.slow = this.fast = 0;
    this.wait = FIRST_WAIT;
    this.sinceUp = Infinity;
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
    seconds = Math.min(seconds, 2 * SLOW);
    this.pace += (seconds - this.pace) * (1 - Math.exp(-seconds / 0.4));
    this.sinceUp += seconds;
    if (this.pace > SLOW) {
      this.fast = 0;
      this.slow += seconds;
      if (this.slow < PATIENCE || this.scale <= this.least) return false;
      // Sharpening just now is what did it: wait longer before trying that again.
      if (this.sinceUp < TRIAL) this.wait = Math.min(LONGEST_WAIT, this.wait * 2);
      this.scale = Math.max(this.least, this.scale * STEP_DOWN);
      this.settle();
      return true;
    }
    this.slow = 0;
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
