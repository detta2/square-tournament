'use strict';
/* SFX via Web Audio API — murni oscillator + noise prosedural, tanpa file eksternal.
 * Pakai: Sfx.play('bounce'|'burn'|'gate'|'go'|'win'|'click')
 * Aman dipanggil kapan saja: tidak error kalau AudioContext belum diizinkan
 * (resume otomatis saat interaksi pertama). */
const Sfx = (function () {
  let ctx = null, master = null, streamDest = null, muted = false;

  function ac() {
    if (ctx) return ctx;
    try {
      if (typeof window === 'undefined') return null;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.35;   // volume sedang
      master.connect(ctx.destination);
      // cabang audio untuk perekaman video (MediaRecorder)
      try { streamDest = ctx.createMediaStreamDestination(); master.connect(streamDest); }
      catch (e) { streamDest = null; }
    } catch (e) { ctx = null; }
    return ctx;
  }
  function unlock() {
    const c = ac();
    if (c && c.state === 'suspended') { c.resume().catch(function () {}); }
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
  }

  function tone(freq, dur, type, vol, slideTo, delay) {
    const c = ac(); if (!c) return;
    const t0 = c.currentTime + (delay || 0);
    const o = c.createOscillator(), g = c.createGain();
    o.type = type || 'square';
    o.frequency.setValueAtTime(freq, t0);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(30, slideTo), t0 + dur);
    g.gain.setValueAtTime(vol || 0.4, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    o.connect(g); g.connect(master);
    o.start(t0); o.stop(t0 + dur + 0.02);
  }

  /* noise prosedural (buffer acak, bukan file) — untuk whoosh/crackle */
  let noiseBuf = null;
  function getNoiseBuf() {
    const c = ac(); if (!c) return null;
    if (!noiseBuf) {
      noiseBuf = c.createBuffer(1, c.sampleRate * 1, c.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    return noiseBuf;
  }
  function noise(dur, vol, freq, slideTo, delay) {
    const c = ac(); if (!c) return;
    const buf = getNoiseBuf(); if (!buf) return;
    const t0 = c.currentTime + (delay || 0);
    const src = c.createBufferSource(); src.buffer = buf; src.loop = true;
    const f = c.createBiquadFilter(); f.type = 'lowpass';
    f.frequency.setValueAtTime(freq || 2000, t0);
    if (slideTo) f.frequency.exponentialRampToValueAtTime(Math.max(40, slideTo), t0 + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(vol || 0.4, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    src.connect(f); f.connect(g); g.connect(master);
    src.start(t0); src.stop(t0 + dur + 0.02);
  }

  const S = {
    // pantulan dinding: blip pendek
    bounce: function () { tone(300, 0.07, 'triangle', 0.35, 160); },
    // bakar: whoosh + crackle
    burn: function () {
      noise(0.45, 0.45, 3500, 300);
      for (let i = 0; i < 6; i++) noise(0.05, 0.35, 5000, 1200, i * 0.07);
      tone(220, 0.4, 'sawtooth', 0.2, 60);
    },
    // gerbang kebuka: fanfare pendek
    gate: function () {
      tone(523, 0.12, 'square', 0.35);
      tone(659, 0.12, 'square', 0.35, null, 0.12);
      tone(784, 0.28, 'square', 0.35, null, 0.24);
    },
    // countdown GO!
    go: function () { tone(880, 0.2, 'square', 0.45, 1320); },
    // pemenang heat: jingel
    win: function () {
      const n = [523, 659, 784, 1047, 784, 1047];
      for (let i = 0; i < n.length; i++) tone(n[i], 0.16, 'triangle', 0.45, null, i * 0.13);
    },
    // klik tombol UI
    click: function () { tone(1250, 0.045, 'square', 0.22); },
  };

  function initButton() {
    try {
      if (typeof document === 'undefined') return;
      const bar = document.getElementById('controls');
      if (!bar || document.getElementById('btn-mute')) return;
      const b = document.createElement('button');
      b.id = 'btn-mute'; b.className = 'pbtn'; b.title = 'Suara on/off';
      b.textContent = '🔊';
      b.addEventListener('click', function () {
        const m = Sfx.toggleMute();
        b.textContent = m ? '🔇' : '🔊';
      });
      bar.appendChild(b);
      // bunyi klik untuk semua tombol UI
      document.addEventListener('click', function (e) {
        if (e.target && e.target.closest && e.target.closest('.pbtn')) Sfx.play('click');
      });
    } catch (e) {}
  }
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading')
      document.addEventListener('DOMContentLoaded', initButton);
    else initButton();
  }

  return {
    play: function (name) {
      if (muted) return;
      try { if (S[name]) S[name](); } catch (e) {}
    },
    toggleMute: function () { muted = !muted; return muted; },
    get muted() { return muted; },
    /* stream audio untuk perekam video (null kalau belum tersedia) */
    getCaptureStream: function () {
      const c = ac();
      return (c && streamDest) ? streamDest.stream : null;
    },
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Sfx: Sfx };
}
