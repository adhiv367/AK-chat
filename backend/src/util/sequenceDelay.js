// Phase 7D — pulled out of services/sequenceScheduler.js so this pure
// conversion can be shared with routes/sequences.js's manual-enrollment
// handler WITHOUT that route also pulling in sequenceScheduler.js's
// module-level requires (queue/sendQueue.js -> ioredis/bullmq connect to
// Redis at require-time). This file has zero dependencies and zero
// side effects on require — safe to import from anywhere, including tests
// that never want a real Redis connection opened.
//
// Single definition of "what a delay step's delay_value/delay_unit means
// in wall-clock time" for the whole sequences feature — sequenceScheduler.js
// re-exports this same function rather than keeping its own copy, so there
// is exactly one place this ever needs to change.

const DELAY_MS_PER_UNIT = {
  minutes: 60 * 1000,
  hours: 60 * 60 * 1000,
  days: 24 * 60 * 60 * 1000,
};

function delayToMs(delayValue, delayUnit) {
  const perUnit = DELAY_MS_PER_UNIT[delayUnit];
  if (!perUnit || !Number.isFinite(Number(delayValue))) return 0;
  return Number(delayValue) * perUnit;
}

module.exports = { DELAY_MS_PER_UNIT, delayToMs };
