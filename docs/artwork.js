/* Generative hero artwork, one piece per event.
 *
 * Seeded from the event title, so a given event always looks like itself, and
 * palettes are chosen per category so a gig and a workshop read differently at
 * a glance rather than being the same picture in a different hue.
 *
 * One WebGL context paints every card. Browsers cap live contexts at around
 * sixteen and start dropping the oldest, so a context per card would quietly
 * break once the listing grew. Each frame the shared canvas is redrawn per
 * card and blitted into that card's own 2D canvas.
 *
 * Only cards actually on screen are drawn, the loop runs at 30fps rather than
 * 60, and it stops entirely when the tab is hidden or the reader has asked for
 * reduced motion.
 */
window.EventArtwork = (() => {
  const W = 480;
  const H = 320;
  const FPS = 30;
  const LOOP_SECONDS = 628.31853; // 200pi, matches LOOP in the shader

  // Inigo Quilez cosine palettes: colour = a + b * cos(2pi * (c * t + d)).
  // Each category gets its own, so the difference between them is the shape of
  // the whole ramp, not just where it starts on the colour wheel.
  const PALETTES = {
    music:     { a: [.50, .34, .60], b: [.45, .34, .42], c: [1, 1, 1], d: [.10, .20, .45] },
    arts:      { a: [.60, .45, .40], b: [.40, .35, .35], c: [1, 1, 1], d: [.00, .12, .22] },
    talk:      { a: [.52, .50, .44], b: [.40, .34, .34], c: [1, 1, 1], d: [.32, .20, .08] },
    film:      { a: [.44, .50, .60], b: [.34, .34, .40], c: [1, 1, 1], d: [.55, .60, .72] },
    food:      { a: [.62, .40, .34], b: [.38, .30, .26], c: [1, 1, 1], d: [.02, .10, .16] },
    market:    { a: [.50, .56, .40], b: [.34, .34, .30], c: [1, 1, 1], d: [.26, .20, .10] },
    sport:     { a: [.44, .55, .58], b: [.34, .34, .36], c: [1, 1, 1], d: [.46, .52, .62] },
    nightlife: { a: [.44, .34, .58], b: [.44, .34, .46], c: [1, 1, 1], d: [.20, .36, .56] },
    festival:  { a: [.55, .50, .55], b: [.45, .45, .45], c: [1, 1, 1], d: [.00, .33, .67] },
    community: { a: [.48, .56, .46], b: [.34, .34, .30], c: [1, 1, 1], d: [.30, .24, .14] },
    other:     { a: [.52, .52, .56], b: [.38, .38, .40], c: [1, 1, 1], d: [.10, .26, .46] },
  };

  const VERT = `
    attribute vec2 a_pos;
    void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
  `;

  const FRAG = `
    #ifdef GL_FRAGMENT_PRECISION_HIGH
    precision highp float;
    #else
    precision mediump float;
    #endif

    uniform vec2 u_res;
    uniform vec2 u_seed;
    uniform float u_mode;
    uniform float u_time;
    uniform float u_dark;
    uniform vec3 u_a;
    uniform vec3 u_b;
    uniform vec3 u_c;
    uniform vec3 u_d;

    const float LOOP = 628.31853;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
    }

    float noise(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
                 mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
    }

    // Four octaves with a fast amplitude falloff. More than this and the domain
    // warp below turns to speckle instead of flow.
    float fbm(vec2 p) {
      float v = 0.0;
      float a = 0.55;
      for (int i = 0; i < 4; i++) {
        v += a * noise(p);
        p *= 2.02;
        a *= 0.42;
      }
      return v;
    }

    vec3 pal(float t) {
      return u_a + u_b * cos(6.28318 * (u_c * t + u_d));
    }

    void main() {
      vec2 uv = gl_FragCoord.xy / u_res;
      vec2 p = uv * 2.0 - 1.0;
      p.x *= u_res.x / u_res.y;

      // Low frequency on purpose: the forms should be larger than the card, so
      // each piece looks like a crop of something bigger.
      float scale = 0.5 + u_seed.x * 0.16;

      // Motion is a drift through the noise field rather than a scroll, so it
      // never runs out of material. Both rates are whole numbers of turns per
      // LOOP, which is what keeps the wrap seamless — 96 turns is a circle
      // roughly every 6.5s, 61 every 10s, and the two together stop it reading
      // as an obvious cycle.
      //
      // The drift has to be fed into every warp stage. Applying it only to the
      // first one meant the movement was attenuated by each stage in turn and
      // arrived as about one part in 255 per second: technically animated,
      // visually a still image.
      float a1 = 6.28318 * 96.0 * u_time / LOOP;
      float a2 = 6.28318 * 61.0 * u_time / LOOP;
      vec2 d1 = vec2(cos(a1), sin(a1)) * 0.90;
      vec2 d2 = vec2(sin(a2), cos(a2)) * 0.60;

      // Two rounds of domain warping — feeding noise back into its own input is
      // what gives it structure rather than flat cloud.
      vec2 q = vec2(fbm(p * scale + u_seed + d1),
                    fbm(p * scale + u_seed + 5.2 + d2));
      vec2 r = vec2(fbm(p * scale + 1.7 * q + 1.7 + u_seed.y + d2),
                    fbm(p * scale + 1.7 * q + 9.2 - u_seed.x - d1));
      float f = fbm(p * scale + 1.5 * r + 0.35 * d1);

      // fbm clusters around the middle; stretching it spreads the palette over
      // its full sweep instead of one muddy band.
      f = (f - 0.38) * 2.6;

      float band = sin((p.x * 1.6 + f * 1.8 + u_seed.x * 10.0) * (0.9 + u_mode * 2.2));
      f = mix(f, f * 0.7 + 0.42 * (band * 0.5 + 0.5), 0.38);

      // Same per-channel offset as the page backdrop, so the artwork and the
      // background read as one family.
      float disp = 0.045;
      vec3 col = vec3(pal(f + disp).r, pal(f).g, pal(f - disp).b);

      col += 0.13 * smoothstep(0.9, 0.0, length(p * 0.75));
      col = mix(col, col * 0.46, u_dark);

      gl_FragColor = vec4(col, 1.0);
    }
  `;

  let gl = null;
  let uniforms = null;
  let source = null;
  let failed = false;

  function init() {
    if (gl || failed) return gl;

    source = document.createElement("canvas");
    source.width = W;
    source.height = H;

    gl = source.getContext("webgl", {
      antialias: false, depth: false, stencil: false,
      preserveDrawingBuffer: true, powerPreference: "low-power",
    });
    if (!gl) { failed = true; return null; }

    const compile = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        console.error("artwork shader:", gl.getShaderInfoLog(sh));
        return null;
      }
      return sh;
    };

    const vs = compile(gl.VERTEX_SHADER, VERT);
    const fs = compile(gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) { failed = true; gl = null; return null; }

    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error("artwork link:", gl.getProgramInfoLog(program));
      failed = true;
      gl = null;
      return null;
    }
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(program, "a_pos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    uniforms = {};
    for (const name of ["res", "seed", "mode", "time", "dark", "a", "b", "c", "d"]) {
      uniforms[name] = gl.getUniformLocation(program, "u_" + name);
    }

    gl.viewport(0, 0, W, H);
    gl.uniform2f(uniforms.res, W, H);
    return gl;
  }

  // FNV-1a, so two events whose titles share a long prefix still land far apart.
  function seedFrom(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    h = (h ^ (h >>> 15)) >>> 0;
    return {
      x: ((h % 1000) / 1000) * 8,
      y: (((h >>> 10) % 1000) / 1000) * 8,
      mode: ((h >>> 20) % 1000) / 1000,
    };
  }

  const entries = [];
  let observer = null;
  let frame = null;
  let lastDraw = 0;
  const startedAt = performance.now();

  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const prefersDark = matchMedia("(prefers-color-scheme: dark)");

  function drawEntry(entry, seconds) {
    const pal = PALETTES[entry.category] || PALETTES.other;
    gl.uniform2f(uniforms.seed, entry.seed.x, entry.seed.y);
    gl.uniform1f(uniforms.mode, entry.seed.mode);
    gl.uniform1f(uniforms.time, seconds);
    gl.uniform1f(uniforms.dark, prefersDark.matches ? 1 : 0);
    gl.uniform3fv(uniforms.a, pal.a);
    gl.uniform3fv(uniforms.b, pal.b);
    gl.uniform3fv(uniforms.c, pal.c);
    gl.uniform3fv(uniforms.d, pal.d);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    entry.ctx.drawImage(source, 0, 0);
  }

  function drawAll(seconds, visibleOnly) {
    for (const entry of entries) {
      if (visibleOnly && !entry.visible) continue;
      drawEntry(entry, seconds);
    }
  }

  function loop(now) {
    frame = requestAnimationFrame(loop);
    if (now - lastDraw < 1000 / FPS) return;
    lastDraw = now;
    drawAll(((now - startedAt) / 1000) % LOOP_SECONDS, true);
  }

  function play() {
    if (frame !== null || !gl || !entries.length) return;
    if (reducedMotion.matches) { drawAll(0, false); return; }
    frame = requestAnimationFrame(loop);
  }

  function pause() {
    if (frame === null) return;
    cancelAnimationFrame(frame);
    frame = null;
  }

  function ensureObserver() {
    if (observer) return observer;
    observer = new IntersectionObserver((records) => {
      for (const record of records) {
        const entry = entries.find((e) => e.canvas === record.target);
        if (entry) entry.visible = record.isIntersecting;
      }
    }, { rootMargin: "200px" });
    return observer;
  }

  /** Register a card canvas and start animating it. Returns false if WebGL is
   *  unavailable, so the caller can fall back to a plain gradient. */
  function attach(canvas, text, category) {
    if (!init()) return false;

    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    if (!ctx) return false;

    const entry = {
      canvas, ctx, category,
      seed: seedFrom(text || "event"),
      visible: true,
    };
    entries.push(entry);
    ensureObserver().observe(canvas);

    // Paint one frame immediately so nothing pops in blank.
    drawEntry(entry, reducedMotion.matches ? 0 : (performance.now() - startedAt) / 1000);
    play();
    return true;
  }

  /** Drop every registered canvas. Called before the grid is re-rendered. */
  function reset() {
    pause();
    if (observer) {
      for (const entry of entries) observer.unobserve(entry.canvas);
    }
    entries.length = 0;
  }

  document.addEventListener("visibilitychange", () => (document.hidden ? pause() : play()));
  reducedMotion.addEventListener("change", () => { pause(); play(); });

  return { attach, reset };
})();
