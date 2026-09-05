// The ONE id mint for interactively created members. Time alone is not
// an identity (the raw-timestamp tool paths collided within a
// millisecond), and a small random suffix alone is not either (1000
// same-instant draws from 1e4 birthday-collide) - so the mint carries
// time + a monotonic sequence + randomness: the sequence guarantees
// in-session uniqueness, the time+random guard cross-session ids in the
// persisted doc. Deliberately impure - clocks stay out of the pure
// object/selection modules, which take the mint as a callback.
let seq = 0;
export function mintId(prefix: string): string {
  seq = (seq + 1) % 1e6;
  return `${prefix}${Math.floor(performance.now() * 10) % 1e9}-${seq}-${Math.floor(Math.random() * 1e4)}`;
}
