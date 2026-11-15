/**
 * 16-bit sequence numbers with wraparound (master.md §3).
 *
 * The agent must drop fast messages that are older than the last seen seq.
 * With u16 arithmetic, "newer" is defined as a forward distance in [1, 32767].
 * A distance of 0 is a duplicate; a distance in [32768, 65535] is "in the past".
 */

export function seqDistance(a: number, b: number): number {
  // forward distance from b to a, in [0, 65535]
  return (a - b + 0x10000) % 0x10000;
}

export class SeqTracker {
  private last = -1;

  /** True iff `seq` is strictly newer than the last accepted seq. */
  accept(seq: number): boolean {
    seq = seq & 0xffff;
    if (this.last < 0) {
      this.last = seq;
      return true;
    }
    const d = seqDistance(seq, this.last);
    if (d === 0 || d >= 0x8000) return false; // duplicate or older
    this.last = seq;
    return true;
  }

  peek(): number {
    return this.last;
  }

  reset(): void {
    this.last = -1;
  }
}

/** Monotonic u16 counter used by senders of fast messages. */
export class SeqCounter {
  private value = (Math.random() * 0x10000) | 0;

  next(): number {
    const v = this.value;
    this.value = (this.value + 1) & 0xffff;
    return v;
  }
}
