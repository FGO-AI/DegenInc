"use client";

import { useEffect, useRef } from "react";
import styles from "./DitherField.module.css";

/**
 * The ambient background: a flow field of particles rendered into a small
 * offscreen buffer, thresholded to pure black-and-white through a 4x4 Bayer
 * matrix, then blown back up with smoothing off. That last part is the whole
 * trick — the dither pattern stays crisp and the result reads as 1-bit print
 * rather than a smooth gradient.
 *
 * Runs at 1/PIX resolution, so the per-frame getImageData stays cheap.
 */

/** Buffer downscale. Each buffer pixel paints a PIX x PIX block on screen. */
const PIX = 3;

/** Ordered-dither threshold map. Values 0-15, tiled across the buffer. */
const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

/** Frames simulated for the single static render under reduced motion. */
const STATIC_FRAMES = 90;

/**
 * Height slack, in CSS pixels, before a resize counts as a new viewport.
 *
 * Mobile browsers fire `resize` when the URL bar slides away — a height-only
 * change of roughly 60-110px that is not a new layout. Re-seeding there
 * restarted the entire field mid-scroll, which reads as a glitch rather than
 * as ambience. Larger than any browser chrome transition, smaller than a real
 * orientation change.
 */
const HEIGHT_SLACK = 120;

type Particle = {
  x: number;
  y: number;
  /** Previous position — each frame draws the segment from there to here. */
  px: number;
  py: number;
  /** Speed multiplier. */
  sp: number;
  /** Frames until this particle respawns somewhere else. */
  life: number;
};

export function DitherField() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const view = canvasRef.current;
    if (!view) return;

    const vctx = view.getContext("2d");
    const buf = document.createElement("canvas");
    const bctx = buf.getContext("2d", { willReadFrequently: true });
    if (!vctx || !bctx) return;

    let width = 0;
    let height = 0;
    let bufW = 0;
    let bufH = 0;
    let time = 0;
    let particles: Particle[] = [];
    /** Viewport size the current particle set was seeded for. */
    let seededW = 0;
    let seededH = 0;
    let raf: number | null = null;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;

    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");

    function seed() {
      // Anchor the re-seed test to the size the field was built for, not to
      // the last resize. Otherwise a run of individually-small height changes
      // each clears the threshold and the particle count never catches up
      // with the viewport.
      seededW = width;
      seededH = height;

      const count = Math.max(
        140,
        Math.min(Math.round((bufW * bufH) / 230), 900),
      );
      particles = Array.from({ length: count }, () => ({
        x: Math.random() * bufW,
        y: Math.random() * bufH,
        px: 0,
        py: 0,
        sp: 0.25 + Math.random() * 0.85,
        life: Math.random() * 260,
      }));
    }

    /**
     * Fit both canvases to the viewport, re-seeding only when the viewport
     * genuinely changed shape.
     *
     * Setting canvas.width/.height ALWAYS clears the bitmap, so the trails are
     * lost on every resize whatever we do — that part is not fixable. What is
     * fixable is the particle set: keeping it means the field carries on from
     * where it was and the trails redraw over a handful of frames, instead of
     * the whole thing restarting every time a phone hides its URL bar.
     *
     * Kept particles hold BUFFER-space coordinates, so a height shrink can
     * leave a few of them past the new bottom edge. That needs no handling
     * here: the `gone` test in step() catches them on the next frame and
     * respawns them with their trail reset, which is the same relocation we
     * would otherwise be doing by hand.
     */
    function resize() {
      const nextW = window.innerWidth;
      const nextH = window.innerHeight;

      const reseed =
        particles.length === 0 ||
        nextW !== seededW ||
        Math.abs(nextH - seededH) > HEIGHT_SLACK;

      width = nextW;
      height = nextH;
      view!.width = width;
      view!.height = height;

      bufW = Math.ceil(width / PIX);
      bufH = Math.ceil(height / PIX);
      buf.width = bufW;
      buf.height = bufH;

      // Both canvases were just cleared to transparent by the assignments
      // above; the buffer has to go back to opaque black or the first fade
      // leaves it grey.
      bctx!.fillStyle = "#000";
      bctx!.fillRect(0, 0, bufW, bufH);
      vctx!.imageSmoothingEnabled = false;

      if (reseed) seed();
    }

    /** Three summed sine waves — a cheap, seamless, slowly rotating flow field. */
    function angleAt(x: number, y: number, at: number) {
      return (
        Math.sin(x * 0.021 + at * 0.28) * 1.6 +
        Math.cos(y * 0.026 - at * 0.19) * 1.6 +
        Math.sin((x + y) * 0.008 + at * 0.11) * 1.2
      );
    }

    function step() {
      // Fade rather than clear, so particles leave trails.
      bctx!.globalCompositeOperation = "source-over";
      bctx!.fillStyle = "rgba(0,0,0,0.085)";
      bctx!.fillRect(0, 0, bufW, bufH);

      bctx!.strokeStyle = "rgba(255,255,255,0.85)";
      bctx!.lineWidth = 1;
      bctx!.beginPath();

      for (const p of particles) {
        p.px = p.x;
        p.py = p.y;

        const a = angleAt(p.x, p.y, time);
        p.x += Math.cos(a) * p.sp;
        // Slight vertical bias so the field drifts downward like falling ash.
        p.y += Math.sin(a) * p.sp * 0.85 + 0.06;
        p.life -= 1;

        const gone =
          p.life < 0 ||
          p.x < -4 ||
          p.x > bufW + 4 ||
          p.y < -4 ||
          p.y > bufH + 4;

        if (gone) {
          p.x = Math.random() * bufW;
          p.y = Math.random() * bufH;
          p.life = 180 + Math.random() * 280;
          // Reset the trail too, or the respawn draws a streak across the screen.
          p.px = p.x;
          p.py = p.y;
        }

        bctx!.moveTo(p.px, p.py);
        bctx!.lineTo(p.x, p.y);
      }
      bctx!.stroke();

      // Threshold to 1-bit through the Bayer matrix.
      const img = bctx!.getImageData(0, 0, bufW, bufH);
      const d = img.data;
      for (let y = 0; y < bufH; y++) {
        const row = BAYER[y & 3];
        for (let x = 0; x < bufW; x++) {
          const o = (y * bufW + x) * 4;
          const threshold = (row[x & 3] + 0.5) * 13.5;
          const v = d[o] > threshold ? 255 : 0;
          d[o] = v;
          d[o + 1] = v;
          d[o + 2] = v;
        }
      }
      bctx!.putImageData(img, 0, 0);

      vctx!.clearRect(0, 0, width, height);
      vctx!.imageSmoothingEnabled = false;
      vctx!.globalAlpha = 0.55;
      vctx!.drawImage(buf, 0, 0, bufW, bufH, 0, 0, bufW * PIX, bufH * PIX);
      vctx!.globalAlpha = 1;

      time += 0.012;
    }

    function loop() {
      step();
      raf = requestAnimationFrame(loop);
    }

    function stop() {
      if (raf !== null) {
        cancelAnimationFrame(raf);
        raf = null;
      }
    }

    /** Animate, or settle on one pre-rolled static frame if motion is reduced. */
    function play() {
      stop();
      if (motion.matches) {
        for (let i = 0; i < STATIC_FRAMES; i++) step();
      } else {
        loop();
      }
    }

    const onResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        // Nothing actually moved. Mobile Safari fires resize on scroll
        // direction changes where innerHeight lands back where it started,
        // and reassigning canvas.width there would wipe the buffer for
        // nothing.
        if (window.innerWidth === width && window.innerHeight === height) {
          return;
        }

        resize();
        // Resizing wipes the buffer either way, so a static render needs
        // re-rolling whether or not the particles survived.
        if (motion.matches) play();
      }, 180);
    };

    const onVisibility = () => {
      if (document.hidden) stop();
      else if (!motion.matches && raf === null) loop();
    };

    resize();
    play();

    window.addEventListener("resize", onResize);
    document.addEventListener("visibilitychange", onVisibility);
    motion.addEventListener("change", play);

    return () => {
      stop();
      clearTimeout(resizeTimer);
      window.removeEventListener("resize", onResize);
      document.removeEventListener("visibilitychange", onVisibility);
      motion.removeEventListener("change", play);
    };
  }, []);

  return <canvas ref={canvasRef} className={styles.field} aria-hidden="true" />;
}
