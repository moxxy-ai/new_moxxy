/**
 * SpectroBackground — the recording visualiser that fills the active
 * panel behind the controls.
 *
 * Bar visualiser styled to match the user reference: many thin vertical
 * bars rising from the bottom, each one a pink-bottom to violet/blue-top
 * gradient with a soft glow. Heavy CSS blur fuses neighbouring bars into
 * a continuous luminous wave while keeping the "frequency-tower"
 * silhouette readable.
 */

import { useEffect, useRef } from 'react';

const SPECTRO_BARS = 64;

export function SpectroBackground({
  analyser,
}: {
  readonly analyser: AnalyserNode;
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const ampsRef = useRef<number[]>(new Array(SPECTRO_BARS).fill(0));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const bufferLength = analyser.frequencyBinCount;
    const data = new Uint8Array(bufferLength);
    let raf = 0;

    const sizeCanvas = (): void => {
      const dpr = window.devicePixelRatio || 1;
      const cssW = canvas.clientWidth;
      const cssH = canvas.clientHeight;
      if (cssW === 0 || cssH === 0) return;
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    sizeCanvas();
    const ro = new ResizeObserver(sizeCanvas);
    ro.observe(canvas);

    const draw = (): void => {
      raf = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(data);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w === 0 || h === 0) return;

      // Log-ish bin mapping: low frequencies (voice fundamentals)
      // get more bars; high end is grouped.
      const useableBins = Math.min(bufferLength, 256);
      const amps = ampsRef.current;
      for (let i = 0; i < SPECTRO_BARS; i++) {
        const start = Math.floor(Math.pow(i / SPECTRO_BARS, 1.6) * useableBins);
        const end = Math.floor(
          Math.pow((i + 1) / SPECTRO_BARS, 1.6) * useableBins,
        );
        let sum = 0;
        const count = Math.max(1, end - start);
        for (let j = start; j < end; j++) sum += data[j] ?? 0;
        const amp = sum / count / 255;
        // EMA smoothing for breathing motion.
        amps[i] = (amps[i] ?? 0) * 0.75 + amp * 0.25;
      }

      ctx.clearRect(0, 0, w, h);

      const gap = 1;
      const totalGap = gap * (SPECTRO_BARS - 1);
      const barW = Math.max(1, (w - totalGap) / SPECTRO_BARS);
      const maxBarH = h * 0.95;
      const minBarH = h * 0.06;

      // Each bar gets the same vertical gradient — pink → fuchsia
      // → blue/cyan at the very top (matches the reference image's
      // cool-top warm-bottom blend). Built once, reused for every
      // bar by translating.
      const gradient = ctx.createLinearGradient(0, 0, 0, h);
      gradient.addColorStop(0, 'rgba(96, 165, 250, 0.95)'); // sky blue top
      gradient.addColorStop(0.35, 'rgba(167, 139, 250, 0.95)'); // violet
      gradient.addColorStop(0.7, 'rgba(236, 72, 153, 0.95)'); // pink
      gradient.addColorStop(1, 'rgba(244, 114, 182, 0.8)'); // soft pink
      ctx.fillStyle = gradient;

      // Strong glow per bar — the secret to the "music video"
      // look. Pink shadow on a violet/blue gradient bar reads as
      // electric / luminous.
      ctx.shadowColor = 'rgba(236, 72, 153, 0.85)';
      ctx.shadowBlur = 20;

      for (let i = 0; i < SPECTRO_BARS; i++) {
        const amp = amps[i] ?? 0;
        const barH = Math.max(minBarH, amp * maxBarH);
        const x = i * (barW + gap);
        const y = h - barH;
        // Thin rounded-top bars — single fillRect with rounded top
        // via a clipped path looks too busy; a simple rect plus
        // shadow + outer blur reads as luminous on its own.
        ctx.fillRect(x, y, barW, barH);
      }
      ctx.shadowBlur = 0;
    };
    draw();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [analyser]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        zIndex: 0,
        pointerEvents: 'none',
        // Strong outer blur fuses the 64 thin bars into a
        // continuous luminous cloud. Boosted saturation pushes
        // the pink/violet/blue to the front against the white
        // panel.
        filter: 'blur(10px) saturate(1.35)',
        WebkitFilter: 'blur(10px) saturate(1.35)',
        opacity: 0.95,
      }}
    />
  );
}
