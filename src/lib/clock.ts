/**
 * The simulation clock. It advances by the real frame time (so motion stays perfectly even),
 * and in live mode it quietly slews towards the system clock instead of jumping to it.
 */
export class SimClock {
  ms = Date.now();
  live = true;
  paused = false;
  speed = 1;
  private last = 0;

  tick(now: number): number {
    const raw = this.last ? Math.min(now - this.last, 250) : 0;
    this.last = now;
    if (this.live) {
      this.ms += raw;
      const err = Date.now() - this.ms;
      this.ms += Math.abs(err) > 1500 ? err : err * 0.04;
    } else if (!this.paused) {
      this.ms += raw * this.speed;
    }
    return this.ms;
  }

  goLive() {
    this.live = true;
    this.paused = false;
    this.speed = 1;
    this.ms = Date.now();
  }

  set(ms: number) {
    this.live = false;
    this.ms = ms;
  }

  shift(seconds: number) {
    this.live = false;
    this.ms += seconds * 1000;
  }

  setSpeed(speed: number) {
    this.speed = speed;
    this.paused = false;
    if (speed !== 1) this.live = false;
  }

  togglePause() {
    if (this.live) {
      this.live = false;
      this.paused = true;
    } else this.paused = !this.paused;
  }
}
