/**
 * Soft completion sound - gentle synthesized chime
 * Plays when transcription is complete and copied to clipboard
 */
export const playCompletionSound = () => {
  try {
    const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();

    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);

    // Soft sine wave at A5 (880 Hz)
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(880, audioContext.currentTime);

    // Very soft volume with gentle fade out
    gainNode.gain.setValueAtTime(0.08, audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.5);

    oscillator.start(audioContext.currentTime);
    oscillator.stop(audioContext.currentTime + 0.5);

    oscillator.onended = () => audioContext.close();
  } catch (e) {
    console.warn('Could not play completion sound:', e);
  }
};
