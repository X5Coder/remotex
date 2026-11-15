"use strict";
/**
 * 16-bit sequence numbers with wraparound (master.md §3).
 *
 * The agent must drop fast messages that are older than the last seen seq.
 * With u16 arithmetic, "newer" is defined as a forward distance in [1, 32767].
 * A distance of 0 is a duplicate; a distance in [32768, 65535] is "in the past".
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SeqCounter = exports.SeqTracker = void 0;
exports.seqDistance = seqDistance;
function seqDistance(a, b) {
    // forward distance from b to a, in [0, 65535]
    return (a - b + 0x10000) % 0x10000;
}
class SeqTracker {
    constructor() {
        this.last = -1;
    }
    /** True iff `seq` is strictly newer than the last accepted seq. */
    accept(seq) {
        seq = seq & 0xffff;
        if (this.last < 0) {
            this.last = seq;
            return true;
        }
        const d = seqDistance(seq, this.last);
        if (d === 0 || d >= 0x8000)
            return false; // duplicate or older
        this.last = seq;
        return true;
    }
    peek() {
        return this.last;
    }
    reset() {
        this.last = -1;
    }
}
exports.SeqTracker = SeqTracker;
/** Monotonic u16 counter used by senders of fast messages. */
class SeqCounter {
    constructor() {
        this.value = (Math.random() * 0x10000) | 0;
    }
    next() {
        const v = this.value;
        this.value = (this.value + 1) & 0xffff;
        return v;
    }
}
exports.SeqCounter = SeqCounter;
