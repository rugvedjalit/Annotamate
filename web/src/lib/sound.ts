// A short, quiet two-tone chime for incoming messages (opt-in via the notify_sound preference).
let ctx: AudioContext | null = null

export function playChime(): void {
  try {
    const AudioCtx = window.AudioContext
    if (!AudioCtx) return
    ctx ??= new AudioCtx()
    const now = ctx.currentTime
    for (const [i, freq] of [880, 1320].entries()) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      const t = now + i * 0.09
      gain.gain.setValueAtTime(0, t)
      gain.gain.linearRampToValueAtTime(0.06, t + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18)
      osc.connect(gain).connect(ctx.destination)
      osc.start(t)
      osc.stop(t + 0.2)
    }
  } catch {
    // Audio is best-effort (autoplay policies may block it).
  }
}
