"use client";

import { useEffect, useRef } from "react";
import styles from "./DitherField.module.css";

/**
 * The ambient background: a handful of long undulating bodies swimming through
 * a flow field, rendered into a small offscreen buffer, thresholded to pure
 * black-and-white through a 4x4 Bayer matrix, then blown back up with
 * smoothing off. That last part is the whole trick — the dither pattern stays
 * crisp and the result reads as 1-bit print rather than a smooth gradient.
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

/**
 * Population.
 *
 * The field this replaced ran `area / 230` capped at 900, which was right for
 * one-pixel specks: the look came from having hundreds of them. A snake is a
 * body you are meant to follow, so the count is the opposite problem — past
 * roughly sixteen the screen reads as tangle rather than as a few things
 * swimming, and the divisor has to be three orders of magnitude larger to get
 * there. Set so a 1440x900 laptop lands around twelve and anything 1080p or
 * wider sits at the cap.
 */
const SNAKE_AREA = 12000;
const SNAKE_MIN = 10;
const SNAKE_MAX = 16;

/**
 * Body length in points. One point is appended per frame, so this doubles as
 * the number of frames of history a body holds, and the drawn arc length is
 * `(len - 1) * speed` buffer pixels — around 40, or 120 CSS pixels at PIX 3,
 * before the fade trail behind it.
 */
const BODY_MIN = 26;
const BODY_MAX = 40;

/**
 * Stroke width at the head, in buffer pixels, and the shape of the taper
 * behind it.
 *
 * A linear taper to zero does not survive the threshold. Sub-pixel widths
 * reach the Bayer block as low coverage — a 0.2px line lands around value 40,
 * which clears only three of the sixteen cells — so the back half of every
 * body dissolved into dots and the field read as dashes rather than as
 * snakes. The exponent holds the width up through the body and drops it only
 * at the very tip, which keeps the whole length above the roughly 0.7px where
 * a stroke stops reading as solid, and leaves the erosion to the fade.
 */
const HEAD_WIDTH = 2.8;
const TAPER_CURVE = 0.55;

/**
 * Bands the taper is quantised into.
 *
 * Canvas cannot vary line width inside one stroked path, and one stroke call
 * per segment would be ~39 calls per snake per frame. Instead each band is a
 * single width, and every snake contributes its slice of that band to one
 * shared path — so the whole field costs TAPER_BANDS stroke calls per frame
 * rather than six hundred.
 */
const TAPER_BANDS = 6;

/** How hard the shared flow field steers a snake, in radians per frame. */
const FLOW_PULL = 0.03;

/**
 * Edge containment.
 *
 * Respawning on contact alone is not enough to keep the population steady.
 * Speed is absolute in buffer space while the buffer scales with the viewport,
 * so a small screen gets crossed fast: measured over a simulated minute at
 * 390x844, snakes lived 1.8s and only two of ten were ever at full length —
 * the field spent most of its time mid-respawn, which is the failure mode a
 * body you can follow cannot afford.
 *
 * So inside TURN_MARGIN of an edge a snake steers back inward, harder the
 * closer it gets. The same simulated minute then respawns nothing at all on
 * desktop and never more than one snake on a frame anywhere. Respawn stays as
 * the fallback for whatever still slips out — mostly a head taking a corner
 * at full speed.
 *
 * TURN_MARGIN needs to exceed the turning circle: at EDGE_TURN and a typical
 * speed a snake reverses in ~22 frames, covering ~29 buffer pixels. Capped so
 * a large buffer does not spend half its area in the turn zone, floored so a
 * small one still has room to come about.
 */
const EDGE_TURN = 0.2;
const TURN_MARGIN_FRAC = 0.26;
const TURN_MARGIN_CAP = 70;
const TURN_MARGIN_MIN = 16;

/** Buffer-space margin. A head past this respawns; a spawn starts exactly on it. */
const EDGE = 4;

/** Inward heading for each spawn edge: left, right, top, bottom. +y is down. */
const INWARD = [0, Math.PI, Math.PI / 2, -Math.PI / 2];

type Snake = {
  /** Path points, head first. Grows to `len` and stays there. */
  body: { x: number; y: number }[];
  /**
   * Target body length. Per snake rather than global so a respawned body
   * regrows to its own size, and so the field holds a mix of lengths.
   */
  len: number;
  /** Current direction of travel, radians. */
  heading: number;
  /** Randomised per snake so no two undulate in step. */
  wigglePhase: number;
  wiggleFreq: number;
  wiggleAmp: number;
  speed: number;
};

export function DitherField() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const view = canvasRef.current;
    if (!view) return;

    const vctx = view.getContext("2d");
    const buf = document.createElement("canvas");
    const bctx = buf.getContext("2d", { willReadFrequently: true });

    /**
     * Where the thresholded frame lands, so `buf` stays greyscale.
     *
     * The threshold used to be written back over the buffer it was read from,
     * which quietly disabled the fade. A lit pixel is 255; one fade step takes
     * it to 255 * 0.915 = 233; the largest value BAYER can ask for is
     * (15 + 0.5) * 13.5 = 209.25. 233 clears that, so the pixel was written
     * back at full brightness every frame and never decayed — anything ever
     * touched stayed lit for the life of the page. Measured on the particle
     * field this replaced: 12% of the buffer lit two seconds in, 64% at one
     * minute, by which point the headline sits behind grey static.
     *
     * Keeping the accumulation buffer and the displayed frame apart is the
     * whole fix. The fade constant and the Bayer block below are untouched.
     */
    const out = document.createElement("canvas");
    const octx = out.getContext("2d");

    if (!vctx || !bctx || !octx) return;

    let width = 0;
    let height = 0;
    let bufW = 0;
    let bufH = 0;
    /** Distance from an edge at which a snake starts turning back. */
    let turnMargin = 0;
    let time = 0;
    let snakes: Snake[] = [];
    /** Viewport size the current snake set was seeded for. */
    let seededW = 0;
    let seededH = 0;
    let raf: number | null = null;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;

    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");

    /**
     * Put a snake back on the board from one of the four edges, heading in.
     *
     * The fallback path, not the common one — containment keeps most snakes in
     * frame indefinitely. It still runs for a head that takes a corner too
     * fast, and for a snake left outside the buffer by a window shrink.
     *
     * Entering from an edge rather than appearing at a random interior point
     * is what keeps the population from visibly blinking: the body regrows
     * over its first `len` frames, and those frames are spent swimming into
     * frame, which reads as arrival rather than as something materialising in
     * the middle of the screen.
     */
    function spawn(s: Snake) {
      const side = Math.floor(Math.random() * 4);

      if (side === 0) {
        s.body = [{ x: -EDGE, y: Math.random() * bufH }];
      } else if (side === 1) {
        s.body = [{ x: bufW + EDGE, y: Math.random() * bufH }];
      } else if (side === 2) {
        s.body = [{ x: Math.random() * bufW, y: -EDGE }];
      } else {
        s.body = [{ x: Math.random() * bufW, y: bufH + EDGE }];
      }

      // Spread is kept under a right angle so the first step is always inward
      // and the snake cannot re-trigger its own edge test on the next frame.
      s.heading = INWARD[side] + (Math.random() - 0.5) * 1.6;
    }

    /**
     * Back-fill a full-length body along the path this snake would have taken
     * to arrive at (x, y), running the same wiggle backwards.
     *
     * Seed-time only. Without it the first frame after load is a field of
     * single dots that takes half a second to grow into bodies, which is the
     * one moment a visitor is most likely to be looking at the background.
     */
    function fillBody(s: Snake, x: number, y: number) {
      s.body = [{ x, y }];

      let h = s.heading;
      let bx = x;
      let by = y;

      for (let i = 1; i < s.len; i++) {
        h -= Math.sin(s.wigglePhase - i * s.wiggleFreq * 0.012) * s.wiggleAmp;
        bx -= Math.cos(h) * s.speed;
        by -= Math.sin(h) * s.speed;
        s.body.push({ x: bx, y: by });
      }
    }

    function seed() {
      // Anchor the re-seed test to the size the field was built for, not to
      // the last resize. Otherwise a run of individually-small height changes
      // each clears the threshold and the snake count never catches up with
      // the viewport.
      seededW = width;
      seededH = height;

      const count = Math.max(
        SNAKE_MIN,
        Math.min(Math.round((bufW * bufH) / SNAKE_AREA), SNAKE_MAX),
      );

      snakes = Array.from({ length: count }, () => {
        const s: Snake = {
          body: [],
          len: Math.round(BODY_MIN + Math.random() * (BODY_MAX - BODY_MIN)),
          heading: Math.random() * Math.PI * 2,
          // Full-circle phase, independent frequency and amplitude: the three
          // together are what stop the field pulsing as one organism, and what
          // stagger the edge crossings so several never respawn on one frame.
          wigglePhase: Math.random() * Math.PI * 2,
          wiggleFreq: 8 + Math.random() * 7,
          wiggleAmp: 0.07 + Math.random() * 0.06,
          speed: 0.9 + Math.random() * 0.8,
        };

        fillBody(s, Math.random() * bufW, Math.random() * bufH);
        return s;
      });
    }

    /**
     * Fit both canvases to the viewport, re-seeding only when the viewport
     * genuinely changed shape.
     *
     * Setting canvas.width/.height ALWAYS clears the bitmap, so the fade
     * trails are lost on every resize whatever we do — that part is not
     * fixable. What is fixable is the snake set: keeping it means the field
     * carries on from where it was and the trails redraw over a handful of
     * frames, instead of the whole thing restarting every time a phone hides
     * its URL bar.
     *
     * Kept snakes hold BUFFER-space coordinates, so a height shrink can leave
     * a head past the new bottom edge. That needs no handling here: the edge
     * test in step() catches it on the next frame and respawns that snake from
     * a fresh edge, which is the same relocation we would otherwise be doing
     * by hand.
     */
    function resize() {
      const nextW = window.innerWidth;
      const nextH = window.innerHeight;

      const reseed =
        snakes.length === 0 ||
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
      out.width = bufW;
      out.height = bufH;

      turnMargin = Math.max(
        TURN_MARGIN_MIN,
        Math.min(Math.min(bufW, bufH) * TURN_MARGIN_FRAC, TURN_MARGIN_CAP),
      );

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
      // Fade rather than clear, so a snake's old position erodes into the
      // dither behind it instead of vanishing.
      bctx!.globalCompositeOperation = "source-over";
      bctx!.fillStyle = "rgba(0,0,0,0.085)";
      bctx!.fillRect(0, 0, bufW, bufH);

      for (const s of snakes) {
        const head = s.body[0];

        // The snake's own undulation. Amplitude is per-frame turn rate, so the
        // heading sweeps back and forth by roughly 2 * amp / (0.012 * freq)
        // radians per cycle — tuned to put about one wave along a body.
        s.heading += Math.sin(time * s.wiggleFreq + s.wigglePhase) * s.wiggleAmp;

        // Then a light pull toward the shared field, so sixteen independent
        // wiggles still read as one current. sin(target - heading) is the
        // shortest-arc correction: angleAt returns several radians either way,
        // and a plain difference would snap the wrong way around the circle.
        s.heading +=
          Math.sin(angleAt(head.x, head.y, time) - s.heading) * FLOW_PULL;

        // Then containment. Build the inward direction as a vector so a corner
        // pushes diagonally rather than fighting between two axes, ramping
        // from nothing at the margin to full strength at the edge itself.
        let ix = 0;
        let iy = 0;
        if (head.x < turnMargin) ix = 1 - head.x / turnMargin;
        else if (head.x > bufW - turnMargin)
          ix = -(1 - (bufW - head.x) / turnMargin);
        if (head.y < turnMargin) iy = 1 - head.y / turnMargin;
        else if (head.y > bufH - turnMargin)
          iy = -(1 - (bufH - head.y) / turnMargin);

        if (ix !== 0 || iy !== 0) {
          s.heading +=
            Math.sin(Math.atan2(iy, ix) - s.heading) *
            EDGE_TURN *
            Math.min(1, Math.hypot(ix, iy));
        }

        const nx = head.x + Math.cos(s.heading) * s.speed;
        const ny = head.y + Math.sin(s.heading) * s.speed;

        if (nx < -EDGE || nx > bufW + EDGE || ny < -EDGE || ny > bufH + EDGE) {
          spawn(s);
        } else {
          s.body.unshift({ x: nx, y: ny });
          if (s.body.length > s.len) s.body.pop();
        }
      }

      bctx!.strokeStyle = "rgba(255,255,255,0.85)";
      bctx!.lineJoin = "round";
      bctx!.lineCap = "round";

      // Outer loop is the width band, inner loop is the snakes, so each band
      // is one path holding every snake's slice of it.
      for (let b = 0; b < TAPER_BANDS; b++) {
        // Midpoint of the band's share of the taper, head band first.
        bctx!.lineWidth =
          HEAD_WIDTH * Math.pow(1 - (b + 0.5) / TAPER_BANDS, TAPER_CURVE);
        bctx!.beginPath();

        for (const s of snakes) {
          const segs = s.body.length - 1;
          if (segs < 1) continue;

          const from = Math.floor((b * segs) / TAPER_BANDS);
          const to = Math.min(segs, Math.ceil(((b + 1) * segs) / TAPER_BANDS));
          if (to <= from) continue;

          // Bands share their end points, so the width steps butt together
          // rather than leaving gaps between them.
          bctx!.moveTo(s.body[from].x, s.body[from].y);
          for (let i = from + 1; i <= to; i++) {
            bctx!.lineTo(s.body[i].x, s.body[i].y);
          }
        }

        bctx!.stroke();
      }

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
      // To `out`, never back to `buf` — see the note where `out` is created.
      octx!.putImageData(img, 0, 0);

      vctx!.clearRect(0, 0, width, height);
      vctx!.imageSmoothingEnabled = false;
      vctx!.globalAlpha = 0.55;
      vctx!.drawImage(out, 0, 0, bufW, bufH, 0, 0, bufW * PIX, bufH * PIX);
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
        // re-rolling whether or not the snakes survived.
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
