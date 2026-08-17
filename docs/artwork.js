/* Generative hero images.
 *
 * Each event without a flyer photo gets its own piece of abstract artwork,
 * seeded from its title so the same event always produces the same image.
 *
 * One WebGL context does all the painting and the result is copied into each
 * card's own 2D canvas. Browsers cap live WebGL contexts at around sixteen, so
 * a context per card would start dropping the oldest ones as the listing grows.
 * The images are painted once and left static — a listings page does not need
 * a dozen animation loops running on someone's phone.
 */
window.EventArtwork = (() => {
  const W = 600;
  const H = 400;

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
    uniform float u_hue;
    uniform float u_mode;
    uniform float u_dark;

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

    // Four octaves, and the amplitude falls away fast. More octaves or a slower
    // falloff turns the warp below into speckle rather than flow.
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

    vec3 pal(float t, float hue) {
      return 0.55 + 0.42 * cos(6.28318 * (t + hue + vec3(0.0, 0.26, 0.52)));
    }

    void main() {
      vec2 uv = gl_FragCoord.xy / u_res;
      vec2 p = uv * 2.0 - 1.0;
      p.x *= u_res.x / u_res.y;

      // Kept deliberately low frequency: the shapes should be bigger than the
      // card, so each piece reads as a detail crop of something larger rather
      // than a busy pattern shrunk to fit.
      float scale = 0.5 + u_seed.x * 0.16;

      // Two rounds of domain warping. Feeding noise back into its own input is
      // what turns flat cloud into something with structure and flow.
      vec2 q = vec2(fbm(p * scale + u_seed),
                    fbm(p * scale + u_seed + 5.2));
      vec2 r = vec2(fbm(p * scale + 1.7 * q + 1.7 + u_seed.y),
                    fbm(p * scale + 1.7 * q + 9.2 - u_seed.x));
      float f = fbm(p * scale + 1.5 * r);

      // fbm sits in a narrow band around the middle; stretching it is what
      // spreads the palette across the full sweep instead of one muddy hue.
      f = (f - 0.38) * 2.6;

      // A slow banding pass, at a frequency the seed picks, so some pieces read
      // as strata and others stay cloudy.
      float band = sin((p.x * 1.6 + f * 1.8 + u_seed.x * 10.0) * (0.9 + u_mode * 2.2));
      f = mix(f, f * 0.7 + 0.42 * (band * 0.5 + 0.5), 0.38);

      // Same per-channel offset trick as the page backdrop, so the artwork and
      // the background read as one family.
      float d = 0.045;
      vec3 col = vec3(pal(f + d, u_hue).r, pal(f, u_hue).g, pal(f - d, u_hue).b);

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

    uniforms = {
      res: gl.getUniformLocation(program, "u_res"),
      seed: gl.getUniformLocation(program, "u_seed"),
      hue: gl.getUniformLocation(program, "u_hue"),
      mode: gl.getUniformLocation(program, "u_mode"),
      dark: gl.getUniformLocation(program, "u_dark"),
    };

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
    return [
      (h % 1000) / 1000,
      ((h >>> 10) % 1000) / 1000,
      ((h >>> 20) % 1000) / 1000,
    ];
  }

  function paint(target, text, hue, dark) {
    if (!init()) return false;

    const [sx, sy, mode] = seedFrom(text || "event");
    gl.uniform2f(uniforms.seed, sx * 8.0, sy * 8.0);
    gl.uniform1f(uniforms.hue, hue);
    gl.uniform1f(uniforms.mode, mode);
    gl.uniform1f(uniforms.dark, dark ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    target.width = W;
    target.height = H;
    const ctx = target.getContext("2d");
    if (!ctx) return false;
    ctx.drawImage(source, 0, 0);
    return true;
  }

  return { paint };
})();
