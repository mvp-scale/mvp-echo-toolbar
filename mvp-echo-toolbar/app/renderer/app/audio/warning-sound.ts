/**
 * Warning sound variations for recording countdown.
 * All use Web Audio API oscillators — no external files needed.
 */

/** V1: Rising two-tone — gentle "boop-BOOP" (440 Hz → 523 Hz) */
export const playWarningV1 = () => {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();

    const osc1 = ctx.createOscillator();
    const gain1 = ctx.createGain();
    osc1.connect(gain1);
    gain1.connect(ctx.destination);
    osc1.type = 'sine';
    osc1.frequency.setValueAtTime(440, ctx.currentTime);
    gain1.gain.setValueAtTime(0.12, ctx.currentTime);
    gain1.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
    osc1.start(ctx.currentTime);
    osc1.stop(ctx.currentTime + 0.25);

    const osc2 = ctx.createOscillator();
    const gain2 = ctx.createGain();
    osc2.connect(gain2);
    gain2.connect(ctx.destination);
    osc2.type = 'sine';
    osc2.frequency.setValueAtTime(523, ctx.currentTime + 0.28);
    gain2.gain.setValueAtTime(0.001, ctx.currentTime);
    gain2.gain.setValueAtTime(0.12, ctx.currentTime + 0.28);
    gain2.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.55);
    osc2.start(ctx.currentTime + 0.28);
    osc2.stop(ctx.currentTime + 0.55);

    osc2.onended = () => ctx.close();
  } catch (e) {
    console.warn('Warning sound V1 failed:', e);
  }
};

/** V2: Triple pulse — three quick beeps at 660 Hz (original short version) */
export const playWarningV2 = () => {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const t = ctx.currentTime;

    for (let i = 0; i < 3; i++) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(660, t + i * 0.18);
      gain.gain.setValueAtTime(0.001, t);
      gain.gain.setValueAtTime(0.12, t + i * 0.18);
      gain.gain.exponentialRampToValueAtTime(0.001, t + i * 0.18 + 0.1);
      osc.start(t + i * 0.18);
      osc.stop(t + i * 0.18 + 0.1);
      if (i === 2) osc.onended = () => ctx.close();
    }
  } catch (e) {
    console.warn('Warning sound V2 failed:', e);
  }
};

/** V2b: Five rising pulses — escalating pitch (554 → 740 Hz), ~1s total */
export const playWarningV2b = () => {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const t = ctx.currentTime;
    const freqs = [554, 587, 622, 660, 740]; // C#5 → D5 → Eb5 → E5 → F#5

    for (let i = 0; i < 5; i++) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freqs[i], t + i * 0.18);
      gain.gain.setValueAtTime(0.001, t);
      gain.gain.setValueAtTime(0.13, t + i * 0.18);
      gain.gain.exponentialRampToValueAtTime(0.001, t + i * 0.18 + 0.12);
      osc.start(t + i * 0.18);
      osc.stop(t + i * 0.18 + 0.12);
      if (i === 4) osc.onended = () => ctx.close();
    }
  } catch (e) {
    console.warn('Warning sound V2b failed:', e);
  }
};

/** V2c: 3+2 grouped pulses with pause — "beep-beep-beep ... beep-beep", rising */
export const playWarningV2c = () => {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const t = ctx.currentTime;
    // First group of 3, then a gap, then 2 higher
    const timings = [0, 0.16, 0.32, 0.64, 0.80];
    const freqs =   [587, 587, 660, 740, 784]; // D5, D5, E5, F#5, G5

    for (let i = 0; i < 5; i++) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freqs[i], t + timings[i]);
      gain.gain.setValueAtTime(0.001, t);
      gain.gain.setValueAtTime(0.13, t + timings[i]);
      gain.gain.exponentialRampToValueAtTime(0.001, t + timings[i] + 0.10);
      osc.start(t + timings[i]);
      osc.stop(t + timings[i] + 0.10);
      if (i === 4) osc.onended = () => ctx.close();
    }
  } catch (e) {
    console.warn('Warning sound V2c failed:', e);
  }
};

/** V3: Sweep down — smooth descending "wooo" (1200 → 400 Hz) */
export const playWarningV3 = () => {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const t = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1200, t);
    osc.frequency.exponentialRampToValueAtTime(400, t + 0.8);
    gain.gain.setValueAtTime(0.12, t);
    gain.gain.setValueAtTime(0.12, t + 0.4);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
    osc.start(t);
    osc.stop(t + 0.9);

    osc.onended = () => ctx.close();
  } catch (e) {
    console.warn('Warning sound V3 failed:', e);
  }
};

/** V4: Wave/siren — rising-falling "woo-OO-oo" sweep */
export const playWarningV4 = () => {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const t = ctx.currentTime;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(500, t);
    osc.frequency.exponentialRampToValueAtTime(1000, t + 0.4);
    osc.frequency.exponentialRampToValueAtTime(450, t + 0.9);
    gain.gain.setValueAtTime(0.10, t);
    gain.gain.setValueAtTime(0.12, t + 0.35);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 1.0);
    osc.start(t);
    osc.stop(t + 1.0);

    osc.onended = () => ctx.close();
  } catch (e) {
    console.warn('Warning sound V4 failed:', e);
  }
};

/** V5: Ring/bell — layered harmonics with shimmer decay */
export const playWarningV5 = () => {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const t = ctx.currentTime;
    // Bell = fundamental + inharmonic partials
    const partials = [523, 1318, 1570, 2102]; // C5 + shimmer overtones
    const volumes = [0.10, 0.06, 0.04, 0.03];
    const decays =  [1.2, 0.8, 0.6, 0.4];

    partials.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(volumes[i], t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + decays[i]);
      osc.start(t);
      osc.stop(t + decays[i]);
      if (i === 0) osc.onended = () => ctx.close();
    });
  } catch (e) {
    console.warn('Warning sound V5 failed:', e);
  }
};

/** V6: Warble — vibrato ring, like a soft phone alert */
export const playWarningV6 = () => {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const t = ctx.currentTime;

    // Main tone
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(660, t);

    // LFO modulates the main frequency for warble
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.connect(lfoGain);
    lfoGain.connect(osc.frequency);
    lfo.type = 'sine';
    lfo.frequency.setValueAtTime(8, t);   // 8 Hz wobble rate
    lfoGain.gain.setValueAtTime(30, t);   // ±30 Hz pitch deviation

    gain.gain.setValueAtTime(0.12, t);
    gain.gain.setValueAtTime(0.12, t + 0.8);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 1.2);

    lfo.start(t);
    osc.start(t);
    lfo.stop(t + 1.2);
    osc.stop(t + 1.2);

    osc.onended = () => ctx.close();
  } catch (e) {
    console.warn('Warning sound V6 failed:', e);
  }
};

/** Default — warble (V6) chosen as the production warning sound */
export const playWarningSound = playWarningV6;
