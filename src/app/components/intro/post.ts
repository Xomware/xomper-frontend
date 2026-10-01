import {
  BufferGeometry,
  DepthTexture,
  Float32BufferAttribute,
  HalfFloatType,
  LinearFilter,
  Matrix4,
  Mesh,
  NoBlending,
  OrthographicCamera,
  PerspectiveCamera,
  Scene,
  ShaderMaterial,
  Vector2,
  WebGLRenderTarget,
  WebGLRenderer,
} from 'three'

/** Per-frame camera and film settings for the finishing pass. */
export interface Lens {
  /** Distance in scene units that is in focus. */
  focus: number
  /** Blur radius in pixels (at 1000 px tall) for something at infinity. */
  aperture: number
  bloom: number
  exposure: number
  /** 0-1 fade to black, applied after grain so black is truly black. */
  fade: number
  time: number
  /** The camera's view-projection when the shutter opened, for motion blur. */
  shutter: Matrix4
}

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = position.xy * 0.5 + 0.5;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

// Keeps only what is brighter than the threshold, with a soft knee so
// highlights don't switch on with a hard edge.
const PREFILTER = /* glsl */ `
  uniform sampler2D tSrc;
  uniform vec2 texel;
  uniform float threshold;
  varying vec2 vUv;
  void main() {
    vec3 c = texture2D(tSrc, vUv + texel * vec2(-0.5, -0.5)).rgb
      + texture2D(tSrc, vUv + texel * vec2(0.5, -0.5)).rgb
      + texture2D(tSrc, vUv + texel * vec2(-0.5, 0.5)).rgb
      + texture2D(tSrc, vUv + texel * vec2(0.5, 0.5)).rgb;
    c *= 0.25;
    float l = max(c.r, max(c.g, c.b));
    float knee = threshold * 0.5;
    float soft = clamp(l - threshold + knee, 0.0, 2.0 * knee);
    soft = soft * soft / (4.0 * knee + 1e-4);
    float w = max(soft, l - threshold) / max(l, 1e-4);
    gl_FragColor = vec4(min(c * w, vec3(40.0)), 1.0);
  }
`

// Dual-filter (Kawase) down and up samples: cheap, wide, no ringing.
const DOWN = /* glsl */ `
  uniform sampler2D tSrc;
  uniform vec2 texel;
  varying vec2 vUv;
  void main() {
    vec3 c = texture2D(tSrc, vUv).rgb * 4.0;
    c += texture2D(tSrc, vUv - texel).rgb;
    c += texture2D(tSrc, vUv + texel).rgb;
    c += texture2D(tSrc, vUv + vec2(texel.x, -texel.y)).rgb;
    c += texture2D(tSrc, vUv - vec2(texel.x, -texel.y)).rgb;
    gl_FragColor = vec4(c / 8.0, 1.0);
  }
`

const UP = /* glsl */ `
  uniform sampler2D tSrc;
  uniform sampler2D tAdd;
  uniform vec2 texel;
  varying vec2 vUv;
  void main() {
    vec3 c = texture2D(tSrc, vUv + vec2(-texel.x * 2.0, 0.0)).rgb;
    c += texture2D(tSrc, vUv + vec2(-texel.x, texel.y)).rgb * 2.0;
    c += texture2D(tSrc, vUv + vec2(0.0, texel.y * 2.0)).rgb;
    c += texture2D(tSrc, vUv + vec2(texel.x, texel.y)).rgb * 2.0;
    c += texture2D(tSrc, vUv + vec2(texel.x * 2.0, 0.0)).rgb;
    c += texture2D(tSrc, vUv + vec2(texel.x, -texel.y)).rgb * 2.0;
    c += texture2D(tSrc, vUv + vec2(0.0, -texel.y * 2.0)).rgb;
    c += texture2D(tSrc, vUv + vec2(-texel.x, -texel.y)).rgb * 2.0;
    gl_FragColor = vec4(c / 12.0 + texture2D(tAdd, vUv).rgb, 1.0);
  }
`

// Camera motion blur: reproject each pixel to where it was when the shutter
// opened and smear along the difference.
const MOTION = /* glsl */ `
  uniform sampler2D tSrc;
  uniform sampler2D tDepth;
  uniform mat4 invViewProj;
  uniform mat4 shutter;
  varying vec2 vUv;
  void main() {
    float z = texture2D(tDepth, vUv).x;
    vec4 world = invViewProj * vec4(vUv * 2.0 - 1.0, z * 2.0 - 1.0, 1.0);
    world /= world.w;
    vec4 then = shutter * world;
    vec2 vel = vUv - (then.xy / then.w * 0.5 + 0.5);
    float len = length(vel);
    if (len > 0.03) vel *= 0.03 / len;
    // Interleaved-gradient jitter turns the eight copies into a smooth smear.
    float j = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    vec3 sum = vec3(0.0);
    for (int i = 0; i < 8; i++) {
      sum += texture2D(tSrc, vUv - vel * ((float(i) + j) / 8.0 - 0.5)).rgb;
    }
    gl_FragColor = vec4(sum / 8.0, 1.0);
  }
`

const DEPTH = /* glsl */ `
  uniform sampler2D tDepth;
  uniform float near;
  uniform float far;
  float viewDepth(vec2 uv) {
    float z = texture2D(tDepth, uv).x * 2.0 - 1.0;
    return 2.0 * near * far / (far + near - z * (far - near));
  }
`

// Depth of field at half resolution. A gather over a golden-angle disc where
// each tap only counts if its own blur circle reaches this pixel, and far taps
// can't bleed over a sharper near one.
const DOF = /* glsl */ `
  uniform sampler2D tSrc;
  uniform vec2 texel;
  uniform float focus;
  uniform float aperture;
  varying vec2 vUv;
  ${DEPTH}
  const float MAX_R = 14.0;
  float coc(float d) {
    return min(aperture * abs(d - focus) / max(d, 1e-3), MAX_R);
  }
  void main() {
    float d0 = viewDepth(vUv);
    float r0 = coc(d0);
    vec3 sum = texture2D(tSrc, vUv).rgb;
    float total = 1.0;
    float spread = r0;
    for (int i = 1; i < 28; i++) {
      float fi = float(i);
      float r = sqrt(fi / 28.0) * MAX_R;
      float a = fi * 2.39996;
      vec2 uv = vUv + vec2(cos(a), sin(a)) * r * texel;
      float d = viewDepth(uv);
      float rs = coc(d);
      if (d > d0) rs = min(rs, r0 * 2.0);
      float w = smoothstep(r - 1.0, r + 1.0, rs);
      sum += texture2D(tSrc, uv).rgb * w;
      total += w;
      spread = max(spread, rs * w);
    }
    gl_FragColor = vec4(sum / total, spread);
  }
`

const COMPOSITE = /* glsl */ `
  uniform sampler2D tSrc;
  uniform sampler2D tDof;
  uniform sampler2D tBloom;
  uniform vec2 resolution;
  uniform float bloom;
  uniform float exposure;
  uniform float fade;
  uniform float time;
  varying vec2 vUv;

  // Stephen Hill's fit of the ACES RRT + ODT.
  vec3 rrtOdt(vec3 v) {
    vec3 a = v * (v + 0.0245786) - 0.000090537;
    vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
    return a / b;
  }
  vec3 aces(vec3 c) {
    const mat3 inM = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
    const mat3 outM = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
    return clamp(outM * rrtOdt(inM * c), 0.0, 1.0);
  }
  vec3 srgb(vec3 c) {
    return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
  }
  float hash(vec2 p) {
    vec3 q = fract(vec3(p.xyx) * 0.1031);
    q += dot(q, q.yzx + 33.33);
    return fract((q.x + q.y) * q.z);
  }

  void main() {
    vec3 sharp = texture2D(tSrc, vUv).rgb;
    vec4 dof = texture2D(tDof, vUv);
    vec3 c = mix(sharp, dof.rgb, smoothstep(0.6, 2.2, dof.a));
    c += texture2D(tBloom, vUv).rgb * bloom;
    c *= exposure;

    vec2 p = vUv - 0.5;
    p.x *= resolution.x / resolution.y;
    c *= mix(1.0, smoothstep(1.05, 0.25, length(p)), 0.55);

    c = srgb(aces(c));

    // Grain, strongest in the mids like film, re-rolled every frame.
    float g = hash(gl_FragCoord.xy + fract(time * 24.0) * 917.0) - 0.5;
    float l = dot(c, vec3(0.299, 0.587, 0.114));
    c += g * 0.075 * (0.35 + l * (1.0 - l) * 2.6);

    gl_FragColor = vec4(c * (1.0 - fade), 1.0);
  }
`

const target = (w: number, h: number) =>
  new WebGLRenderTarget(w, h, { type: HalfFloatType, minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: false })

/**
 * The finishing pass: depth of field, bloom, ACES tone mapping, vignette and
 * grain. The scene renders linear HDR into a multisampled target; this turns
 * it into a graded frame on the canvas.
 */
export class Post {
  private readonly scene: WebGLRenderTarget
  private readonly dof: WebGLRenderTarget
  private readonly motion: WebGLRenderTarget
  private readonly invViewProj = new Matrix4()
  private readonly down: WebGLRenderTarget[] = []
  private readonly up: WebGLRenderTarget[] = []
  private readonly quad: Mesh<BufferGeometry, ShaderMaterial>
  private readonly cam = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private readonly mats: Record<'motion' | 'prefilter' | 'down' | 'up' | 'dof' | 'composite', ShaderMaterial>
  private readonly size = new Vector2()

  constructor(private readonly renderer: WebGLRenderer) {
    this.scene = new WebGLRenderTarget(1, 1, {
      type: HalfFloatType,
      samples: 4,
      depthTexture: new DepthTexture(1, 1),
    })
    this.dof = target(1, 1)
    this.motion = target(1, 1)
    for (let i = 0; i < 5; i++) this.down.push(target(1, 1))
    for (let i = 0; i < 4; i++) this.up.push(target(1, 1))

    const make = (fragmentShader: string, uniforms: Record<string, { value: unknown }>) =>
      new ShaderMaterial({ vertexShader: VERT, fragmentShader, uniforms, depthTest: false, depthWrite: false, blending: NoBlending })
    this.mats = {
      motion: make(MOTION, {
        tSrc: { value: null },
        tDepth: { value: null },
        invViewProj: { value: this.invViewProj },
        shutter: { value: new Matrix4() },
      }),
      prefilter: make(PREFILTER, { tSrc: { value: null }, texel: { value: new Vector2() }, threshold: { value: 1.8 } }),
      down: make(DOWN, { tSrc: { value: null }, texel: { value: new Vector2() } }),
      up: make(UP, { tSrc: { value: null }, tAdd: { value: null }, texel: { value: new Vector2() } }),
      dof: make(DOF, {
        tSrc: { value: null },
        tDepth: { value: null },
        texel: { value: new Vector2() },
        focus: { value: 10 },
        aperture: { value: 0 },
        near: { value: 0.1 },
        far: { value: 100 },
      }),
      composite: make(COMPOSITE, {
        tSrc: { value: null },
        tDof: { value: null },
        tBloom: { value: null },
        resolution: { value: new Vector2() },
        bloom: { value: 0.5 },
        exposure: { value: 1 },
        fade: { value: 0 },
        time: { value: 0 },
      }),
    }

    const tri = new BufferGeometry()
    tri.setAttribute('position', new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3))
    this.quad = new Mesh(tri, this.mats.composite)
    this.quad.frustumCulled = false
  }

  setSize(width: number, height: number): void {
    this.size.set(width, height)
    this.scene.setSize(width, height)
    this.motion.setSize(width, height)
    this.dof.setSize(Math.ceil(width / 2), Math.ceil(height / 2))
    this.down.forEach((t, i) => t.setSize(Math.max(1, width >> (i + 1)), Math.max(1, height >> (i + 1))))
    this.up.forEach((t, i) => t.setSize(Math.max(1, width >> (i + 1)), Math.max(1, height >> (i + 1))))
  }

  render(scene: Scene, camera: PerspectiveCamera, lens: Lens): void {
    const r = this.renderer
    r.setRenderTarget(this.scene)
    r.render(scene, camera)

    const { width: w, height: h } = this.size
    const px = h / 1000

    this.invViewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).invert()
    const mo = this.mats.motion.uniforms
    mo['tSrc'].value = this.scene.texture
    mo['tDepth'].value = this.scene.depthTexture
    ;(mo['shutter'].value as Matrix4).copy(lens.shutter)
    this.pass(this.mats.motion, this.motion)
    const frame = this.motion.texture

    const dof = this.mats.dof.uniforms
    dof['tSrc'].value = frame
    dof['tDepth'].value = this.scene.depthTexture
    ;(dof['texel'].value as Vector2).set(2 / w, 2 / h)
    dof['focus'].value = lens.focus
    // Half resolution, so a pixel here is two on screen.
    dof['aperture'].value = (lens.aperture * px) / 2
    dof['near'].value = camera.near
    dof['far'].value = camera.far
    this.pass(this.mats.dof, this.dof)

    const pre = this.mats.prefilter.uniforms
    pre['tSrc'].value = frame
    ;(pre['texel'].value as Vector2).set(1 / w, 1 / h)
    this.pass(this.mats.prefilter, this.down[0])
    for (let i = 1; i < this.down.length; i++) {
      const u = this.mats.down.uniforms
      const src = this.down[i - 1]
      u['tSrc'].value = src.texture
      ;(u['texel'].value as Vector2).set(1 / src.width, 1 / src.height)
      this.pass(this.mats.down, this.down[i])
    }
    let src = this.down[this.down.length - 1]
    for (let i = this.up.length - 1; i >= 0; i--) {
      const u = this.mats.up.uniforms
      u['tSrc'].value = src.texture
      u['tAdd'].value = this.down[i].texture
      ;(u['texel'].value as Vector2).set(0.5 / src.width, 0.5 / src.height)
      this.pass(this.mats.up, this.up[i])
      src = this.up[i]
    }

    const c = this.mats.composite.uniforms
    c['tSrc'].value = frame
    c['tDof'].value = this.dof.texture
    c['tBloom'].value = this.up[0].texture
    ;(c['resolution'].value as Vector2).copy(this.size)
    c['bloom'].value = lens.bloom
    c['exposure'].value = lens.exposure
    c['fade'].value = lens.fade
    c['time'].value = lens.time
    this.pass(this.mats.composite, null)
  }

  dispose(): void {
    ;[this.scene, this.dof, this.motion, ...this.down, ...this.up].forEach((t) => t.dispose())
    Object.values(this.mats).forEach((m) => m.dispose())
    this.quad.geometry.dispose()
  }

  private pass(material: ShaderMaterial, out: WebGLRenderTarget | null): void {
    this.quad.material = material
    this.renderer.setRenderTarget(out)
    this.renderer.render(this.quad, this.cam)
  }
}
