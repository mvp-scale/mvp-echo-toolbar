/**
 * Capture-ready "talk now" cue — a short rising two-note chirp (C5 → G5).
 *
 * Deliberately distinct from the single high "done" ding (playCompletionSound,
 * 880 Hz): RISING = "go / start talking", a single high tone = "done". This is
 * fired only when the mic is CONFIRMED live (frames flowing + track unmuted),
 * not on keypress — so it's the authoritative signal for when to start speaking.
 */
export const playStartSound = () => {
  try {
    const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();

    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    osc.connect(gain);
    gain.connect(audioContext.destination);

    const t = audioContext.currentTime;
    osc.type = 'sine';
    // Two quick rising notes on one oscillator: C5 then G5.
    osc.frequency.setValueAtTime(523, t);
    osc.frequency.setValueAtTime(784, t + 0.09);

    // Soft envelope with a dip between the notes so it reads as "di-dit".
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.07, t + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.02, t + 0.085);
    gain.gain.setValueAtTime(0.07, t + 0.092);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);

    osc.start(t);
    osc.stop(t + 0.22);
    osc.onended = () => audioContext.close();
  } catch (e) {
    console.warn('Could not play start sound:', e);
  }
};
