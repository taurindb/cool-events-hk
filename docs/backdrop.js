/* Iridescent backdrop.
 *
 * Soft vertical bands of colour with a prismatic fringe between them, drifting
 * slowly. Raw WebGL rather than a library, so the site keeps its no-dependency
 * rule. If anything here fails the page just keeps its flat CSS background.
 */
(() => {
  const canvas = document.getElementById("backdrop");
  if (!canvas) return;

  const gl = canvas.getContext("webgl", {
    antialias: false, depth: false, stencil: false, powerPreference: "low-power",
  });
  if (!gl) return;

  const VERT = `
    attribute vec2 a_pos;
    void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
  `;

  const FRAG = `
    // mediump is genuinely 16-bit on most mobile GPUs. With a clock that only
    // ever grows, the per-frame change in sin() eventually falls below what
    // mediump can represent and the whole thing freezes into a flat colour —
    // it renders once, then stops moving. highp where the hardware offers it.
    #ifdef GL_FRAGMENT_PRECISION_HIGH
    precision highp float;
    #else
    precision mediump float;
    #endif

    uniform vec2 u_res;
    uniform float u_time;
    uniform float u_dark;

    float hash(float n) { return fract(sin(n) * 43758.5453123); }

    float vnoise(float x) {
      float i = floor(x);
      float f = fract(x);
      f = f * f * (3.0 - 2.0 * f);
      return mix(hash(i), hash(i + 1.0), f);
    }

    // Where a given column sits along the spectrum. Layered sines at unrelated
    // frequencies keep the banding from ever looking like it repeats.
    // The clock is wrapped at LOOP seconds so it never grows large enough to
    // lose precision. Every rate below is chosen to come back to where it
    // started at exactly that moment, so the wrap is invisible: the sine rates
    // are multiples of 0.01 (and 0.01 * 200pi = 2pi), and the noise advances by
    // exactly 19 lattice cells over one period.
    const float LOOP = 628.31853;

    float field(float x, float y, float t) {
      float v = 0.0;
      v += sin(x * 4.7 + t * 0.11) * 0.50;
      v += sin(x * 9.3 - t * 0.07 + y * 0.5) * 0.30;
      v += sin(x * 17.1 + t * 0.17) * 0.16;
      v += vnoise(x * 3.1 - t * (19.0 / LOOP)) * 0.90;
      v += y * 0.15;
      return v;
    }

    // Kept high-key on purpose: the palette never bottoms out, so the masthead
    // text stays legible wherever the bands happen to drift.
    vec3 pal(float t) {
      return 0.58 + 0.40 * cos(6.28318 * (t + vec3(0.00, 0.26, 0.52)));
    }

    void main() {
      vec2 uv = gl_FragCoord.xy / u_res;
      float t = u_time;

      // Each channel reads the field a little further along the x axis. That
      // offset is what produces the prismatic edge where two bands meet.
      float d = 0.030 + 0.014 * sin(t * 0.05);

      float fr = field(uv.x - d, uv.y, t);
      float fg = field(uv.x,     uv.y, t);
      float fb = field(uv.x + d, uv.y, t);

      vec3 col = vec3(pal(fr).r, pal(fg).g, pal(fb).b);

      // Light falling down a column: brighter through the middle, dimmer at the
      // extremes, so the bands read as lit rather than flat.
      float bloom = smoothstep(-0.15, 0.5, uv.y) * smoothstep(1.25, 0.55, uv.y);
      col += bloom * 0.14;

      col = mix(col, col * 0.40, u_dark);
      gl_FragColor = vec4(col, 1.0);
    }
  `;

  function compile(type, src) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error("backdrop shader:", gl.getShaderInfoLog(shader));
      return null;
    }
    return shader;
  }

  const vs = compile(gl.VERTEX_SHADER, VERT);
  const fs = compile(gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) return;

  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error("backdrop link:", gl.getProgramInfoLog(program));
    return;
  }
  gl.useProgram(program);

  // One oversized triangle covers the viewport with no index buffer.
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(program, "a_pos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const uRes = gl.getUniformLocation(program, "u_res");
  const uTime = gl.getUniformLocation(program, "u_time");
  const uDark = gl.getUniformLocation(program, "u_dark");

  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const darkScheme = matchMedia("(prefers-color-scheme: dark)");

  function resize() {
    // Capping the pixel ratio keeps a full-screen fragment shader affordable on
    // a phone; at this blur nobody can tell it is not rendering at 3x.
    const dpr = Math.min(devicePixelRatio || 1, 1.5);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
    gl.uniform2f(uRes, canvas.width, canvas.height);
  }

  function draw(seconds) {
    resize();
    gl.uniform1f(uTime, seconds);
    gl.uniform1f(uDark, darkScheme.matches ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  let frame = null;
  const start = performance.now();
  const LOOP_SECONDS = 628.31853; // 200pi — matches LOOP in the shader

  function loop(now) {
    draw(((now - start) / 1000) % LOOP_SECONDS);
    frame = requestAnimationFrame(loop);
  }

  function play() {
    if (frame !== null) return;
    if (reducedMotion.matches) { draw(0); return; }
    frame = requestAnimationFrame(loop);
  }

  function pause() {
    if (frame === null) return;
    cancelAnimationFrame(frame);
    frame = null;
  }

  addEventListener("resize", () => { if (frame === null) draw(0); }, { passive: true });
  document.addEventListener("visibilitychange", () => (document.hidden ? pause() : play()));
  reducedMotion.addEventListener("change", () => { pause(); play(); });
  darkScheme.addEventListener("change", () => { if (frame === null) draw(0); });

  play();
})();
