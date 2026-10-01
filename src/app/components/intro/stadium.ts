import {
  AdditiveBlending,
  BackSide,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CatmullRomCurve3,
  Color,
  CylinderGeometry,
  DoubleSide,
  FogExp2,
  Group,
  HemisphereLight,
  InstancedMesh,
  LatheGeometry,
  Material,
  MathUtils,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NearestFilter,
  Object3D,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  RepeatWrapping,
  SRGBColorSpace,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  SpotLight,
  Texture,
  TubeGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three'

import { Post } from './post'
import { PAINT_X, PAINT_Z, SIDELINE, paintBall, paintField, paintLogo, paintRibbon, paintScore } from './textures'

// The shot, in seconds. Units in the world are yards; x runs down the field
// to the goal posts at +60, z across it, y up.
export const SCENE_LENGTH = 6
// Corner banks in build order: [-x-z, -x+z, +x-z, +x+z]. The shot opens on the last.
const TOWER_ON = [0.75, 0.6, 0.45, 0.2]
const TOWERS = [
  [-98, -74],
  [-98, 74],
  [98, -74],
  [98, 74],
] as const
const TOWER_H = 66
const DRAW_FROM = 1.25
const ERASE = [2.35, 2.65] as const
const KICK = 2.7
// The kick plays in slow motion off the foot, then ramps up to speed: the
// ball reaches the posts (1.05 s of flight) at ARRIVE.
const SLOW = 0.3
const RAMP = [0.35, 0.85] as const
const ARRIVE = KICK + 1.47
const SCORE = ARRIVE + 0.15
const LOGO = [4.85, 5.25] as const

const BOARD = { x: 94, y: 27, w: 30, h: 11.25 }
const POSTS_X = 60
const CROSSBAR = 10 / 3
const UPRIGHT_GAP = 18.5 / 3
const BALL_START = new Vector3(30.4, 1.0, -1.9)
const BALL_V = new Vector3(28.3, 11.6, 1.95)
const GRAVITY = 10.7

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const range = (t: number, a: number, b: number) => clamp01((t - a) / (b - a))
const smooth = (u: number) => u * u * (3 - 2 * u)
const easeInOut = (u: number) => (u < 0.5 ? 4 * u ** 3 : 1 - (-2 * u + 2) ** 3 / 2)

type Key = [number, Vector3] | [number, Vector3, Vector3]

/** Cubic Hermite through timed keys. A key's velocity defaults to Catmull-Rom, or 0 at the ends. */
function track(keys: readonly Key[], t: number, out: Vector3): Vector3 {
  if (t <= keys[0][0]) return out.copy(keys[0][1])
  const last = keys.length - 1
  if (t >= keys[last][0]) return out.copy(keys[last][1])
  let i = 0
  while (t > keys[i + 1][0]) i++
  const [t0, p0] = keys[i]
  const [t1, p1] = keys[i + 1]
  const tangent = (j: number) => {
    const set = keys[j][2]
    if (set) return set
    if (j === 0 || j === last) return new Vector3()
    const [ta, a] = keys[j - 1]
    const [tb, b] = keys[j + 1]
    return b.clone().sub(a).multiplyScalar(1 / (tb - ta))
  }
  const dt = t1 - t0
  const u = (t - t0) / dt
  const h00 = 2 * u ** 3 - 3 * u ** 2 + 1
  const h10 = u ** 3 - 2 * u ** 2 + u
  const h01 = -2 * u ** 3 + 3 * u ** 2
  const h11 = u ** 3 - u ** 2
  return out
    .copy(p0)
    .multiplyScalar(h00)
    .addScaledVector(tangent(i), h10 * dt)
    .addScaledVector(p1, h01)
    .addScaledVector(tangent(i + 1), h11 * dt)
}

const v = (x: number, y: number, z: number) => new Vector3(x, y, z)

/** A lamp u seconds after it's switched on: a strike, a dip as the arc settles, then full. */
function strike(u: number): number {
  if (u < 0) return 0
  if (u < 0.04) return 0.9
  if (u < 0.08) return 0.3
  return 0.55 + 0.45 * smooth(range(u, 0.08, 0.4))
}

function rand(seed: number): () => number {
  let a = seed * 7919
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Ball-clock seconds since the kick, after `s` seconds of the speed ramp. */
function ballClock(s: number): number {
  const w = RAMP[1] - RAMP[0]
  const u = clamp01((s - RAMP[0]) / w)
  return SLOW * s + (1 - SLOW) * (w * (u ** 3 - u ** 4 / 2) + Math.max(0, s - RAMP[1]))
}

/** How fast the ball clock runs against the scene clock. */
function ballRate(s: number): number {
  return SLOW + (1 - SLOW) * smooth(range(s, RAMP[0], RAMP[1]))
}

/** Where the ball is τ seconds after it leaves the foot. */
function ballAt(tau: number, out: Vector3): Vector3 {
  return out.copy(BALL_START).addScaledVector(BALL_V, tau).setY(BALL_START.y + BALL_V.y * tau - 0.5 * GRAVITY * tau * tau)
}

const NOISE = /* glsl */ `
  float hash12(vec2 p) {
    vec3 q = fract(vec3(p.xyx) * 0.1031);
    q += dot(q, q.yzx + 33.33);
    return fract((q.x + q.y) * q.z);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
  }
`

const FOG = /* glsl */ `
  uniform vec3 fogTint;
  uniform float fogDensity;
  vec3 fogged(vec3 c, float dist) {
    float f = 1.0 - exp(-fogDensity * fogDensity * dist * dist);
    return mix(c, fogTint, f);
  }
`

interface Stroke {
  points: Vector2[]
  start: number
  length: number
}

/** A hand-drawn chalk loop: a little more than a full turn, never quite round. */
function ring(cx: number, cz: number, r: number, seed: number): Vector2[] {
  const pts: Vector2[] = []
  const a0 = seed * 2.1
  for (let i = 0; i <= 30; i++) {
    const a = a0 + (i / 30) * Math.PI * 2.18
    const rr = r * (1 + 0.08 * Math.sin(a * 2 + seed) + i * 0.003)
    pts.push(new Vector2(cx + Math.cos(a) * rr * 0.9, cz + Math.sin(a) * rr))
  }
  return pts
}

function curve(ctrl: [number, number][], n = 24): Vector2[] {
  const c = new CatmullRomCurve3(ctrl.map(([x, z]) => v(x, 0, z)))
  return c.getPoints(n).map((p) => new Vector2(p.x, p.z))
}

/** Arrowhead strokes at the end of a path. */
function head(path: Vector2[], size = 0.75): Vector2[][] {
  const tip = path[path.length - 1]
  const dir = tip.clone().sub(path[path.length - 4]).normalize()
  const side = (s: number) => {
    const back = dir.clone().rotateAround(new Vector2(), s * 2.6).multiplyScalar(size)
    return [tip.clone(), tip.clone().add(back)]
  }
  return [side(1), side(-1)]
}

/** The play the telestrator draws, at the 10, kicking towards +x. */
function playbook(): Stroke[] {
  const strokes: Stroke[] = []
  let t = DRAW_FROM
  const add = (points: Vector2[], length: number, gap = 0.04) => {
    strokes.push({ points, start: t, length })
    t += gap
  }
  const los = 39.5
  ;[-3, -2, -1, 0, 1, 2, 3].forEach((z, i) => add(ring(los - 0.4, z * 1.9, 0.72, i + 1), 0.16, 0.035))
  add(ring(34.2, 0.9, 0.72, 9), 0.16)
  add(ring(31.8, -1.2, 0.72, 10), 0.16, 0.08)
  ;[-7.4, -4.2, -1.1, 1.1, 4.2, 7.4].forEach((z, i) => {
    const x = los + 2.2 + (i % 2) * 0.5
    const s = 0.62
    add([new Vector2(x - s, z - s), new Vector2(x + s, z + s)], 0.07, 0.015)
    add([new Vector2(x - s, z + s), new Vector2(x + s, z - s)], 0.07, 0.035)
  })
  // The edge rushers' paths at the holder.
  for (const s of [1, -1]) {
    const p = curve([
      [los + 2.2, 7.4 * s],
      [los - 1.8, 7.6 * s],
      [36.4, 3.6 * s],
    ])
    add(p, 0.3, 0)
    head(p).forEach((h) => add(h, 0.06, 0))
    t += 0.06
  }
  // And the kick itself: from the hold, through the uprights.
  const kick = curve(
    [
      [34.2, 0.9],
      [42, 0.6],
      [50, 0.2],
      [57.5, 0.05],
    ],
    40,
  )
  add(kick, 0.42, 0)
  head(kick, 1.1).forEach((h) => add(h, 0.08, 0))
  return strokes
}

/** One ribbon mesh for every chalk stroke; the shader reveals each along its length in time. */
function chalkGeometry(strokes: Stroke[], width: number): BufferGeometry {
  const pos: number[] = []
  const along: number[] = []
  const side: number[] = []
  const timing: number[] = []
  const index: number[] = []
  let base = 0
  strokes.forEach((s, si) => {
    const pts = s.points
    let total = 0
    const lens = [0]
    for (let i = 1; i < pts.length; i++) lens.push((total += pts[i].distanceTo(pts[i - 1])))
    pts.forEach((p, i) => {
      const a = pts[Math.max(0, i - 1)]
      const b = pts[Math.min(pts.length - 1, i + 1)]
      const n = new Vector2(-(b.y - a.y), b.x - a.x).normalize()
      // A hand never holds a line perfectly steady.
      const wob = Math.sin(lens[i] * 2.3 + si * 1.7) * 0.035
      // Square ends overhang a touch, like a marker stopped on the glass.
      const ext = i === 0 ? -width * 0.4 : i === pts.length - 1 ? width * 0.4 : 0
      const t = b.clone().sub(a).normalize().multiplyScalar(ext)
      for (const sgn of [-1, 1]) {
        pos.push(p.x + n.x * (sgn * width * 0.5 + wob) + t.x, 0.03, p.y + n.y * (sgn * width * 0.5 + wob) + t.y)
        along.push(lens[i] / Math.max(total, 1e-3), lens[i])
        side.push(sgn)
        timing.push(s.start, s.length)
      }
      if (i > 0) {
        const q = base + (i - 1) * 2
        index.push(q, q + 1, q + 2, q + 1, q + 3, q + 2)
      }
    })
    base += pts.length * 2
  })
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
  g.setAttribute('aAlong', new BufferAttribute(new Float32Array(along), 2))
  g.setAttribute('aSide', new BufferAttribute(new Float32Array(side), 1))
  g.setAttribute('aTiming', new BufferAttribute(new Float32Array(timing), 2))
  g.setIndex(index)
  return g
}

/** A rounded-rectangle bowl outline (superellipse), sampled by angle. */
function bowlPoint(a: number, ax: number, az: number, out: Vector2): Vector2 {
  const c = Math.cos(a)
  const s = Math.sin(a)
  const e = 2 / 7
  return out.set(ax * Math.sign(c) * Math.abs(c) ** e, az * Math.sign(s) * Math.abs(s) ** e)
}

/**
 * A ring of seating: `rows` rows climbing from (inset, y0) to (inset + depth,
 * y1). UV x is yards along the ring, y is the row number.
 */
function tier(inset: number, depth: number, y0: number, y1: number, rows: number): BufferGeometry {
  const N = 220
  const pos: number[] = []
  const uv: number[] = []
  const index: number[] = []
  const p = new Vector2()
  const q = new Vector2()
  let dist = 0
  let prev = new Vector2()
  for (let i = 0; i <= N; i++) {
    const a = (i / N) * Math.PI * 2
    bowlPoint(a, 74 + inset, 42 + inset, p)
    bowlPoint(a + 0.001, 74 + inset, 42 + inset, q)
    const n = new Vector2(q.y - p.y, -(q.x - p.x)).normalize()
    if (i > 0) dist += p.distanceTo(prev)
    prev = p.clone()
    pos.push(p.x, y0, p.y, p.x + n.x * depth, y1, p.y + n.y * depth)
    uv.push(dist, 0, dist, rows)
    if (i < N) {
      const k = i * 2
      index.push(k, k + 2, k + 1, k + 1, k + 2, k + 3)
    }
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2))
  g.setIndex(index)
  return g
}

/** A floodlight's face: the arc tube's hot core, faceted reflector, dark rim. Linear values. */
function reflectorTexture(): CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')
  if (g) {
    g.fillStyle = 'rgb(10,10,10)'
    g.fillRect(0, 0, 128, 128)
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 60)
    grad.addColorStop(0, 'rgb(255,255,255)')
    grad.addColorStop(0.12, 'rgb(255,255,255)')
    grad.addColorStop(0.2, 'rgb(120,120,120)')
    grad.addColorStop(0.85, 'rgb(70,70,70)')
    grad.addColorStop(0.92, 'rgb(25,25,25)')
    grad.addColorStop(1, 'rgb(10,10,10)')
    g.fillStyle = grad
    g.beginPath()
    g.arc(64, 64, 60, 0, Math.PI * 2)
    g.fill()
    g.strokeStyle = 'rgba(0,0,0,0.35)'
    g.lineWidth = 1.5
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2
      g.beginPath()
      g.moveTo(64 + Math.cos(a) * 14, 64 + Math.sin(a) * 14)
      g.lineTo(64 + Math.cos(a) * 54, 64 + Math.sin(a) * 54)
      g.stroke()
    }
  }
  return new CanvasTexture(c)
}

function radialTexture(): CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')
  if (g) {
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64)
    grad.addColorStop(0, 'rgba(255,255,255,1)')
    grad.addColorStop(0.08, 'rgba(255,255,255,0.55)')
    grad.addColorStop(0.3, 'rgba(255,255,255,0.12)')
    grad.addColorStop(1, 'rgba(255,255,255,0)')
    g.fillStyle = grad
    g.fillRect(0, 0, 128, 128)
  }
  return new CanvasTexture(c)
}

interface Tower {
  lens: InstancedMesh
  strikes: number[]
  glare: Mesh<PlaneGeometry, ShaderMaterial>
  beam: Mesh<CylinderGeometry, ShaderMaterial>
  lights: SpotLight[]
}

export interface StadiumOptions {
  logo: HTMLImageElement
  tagline: string
}

/**
 * The landing intro as a three.js scene: a lit stadium at night, a
 * telestrator play on the turf, a field goal, and the scoreboard turning to
 * the logo. `render(t)` is a pure function of time, so a dropped frame or a
 * capture harness lands on the right picture.
 */
export class Stadium {
  private readonly scene = new Scene()
  private readonly camera = new PerspectiveCamera(40, 1, 0.1, 900)
  private readonly post: Post
  private readonly towers: Tower[] = []
  private readonly materials: Material[] = []
  private readonly textures: Texture[] = []
  private readonly chalk: ShaderMaterial
  private readonly crowd: ShaderMaterial
  private readonly sky: ShaderMaterial
  private readonly led: ShaderMaterial
  private readonly ribbon: MeshBasicMaterial
  private readonly ball = new Group()
  private readonly ballSpin: Mesh
  private readonly smear = { value: 0 }
  private readonly shutter = new Matrix4()
  private readonly hemi = new HemisphereLight(0x1c2a3a, 0x050806, 0.25)
  private readonly fog = new FogExp2(0x000000, 0.0042)
  private aspect = 1
  private readonly tmp = { a: new Vector3(), b: new Vector3(), c: new Vector3() }

  constructor(
    private readonly renderer: WebGLRenderer,
    opts: StadiumOptions,
  ) {
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = PCFShadowMap
    this.post = new Post(renderer)
    this.scene.fog = this.fog
    this.scene.add(this.hemi)

    this.sky = this.keep(
      new ShaderMaterial({
        side: BackSide,
        depthWrite: false,
        uniforms: {
          glow: { value: 0 },
          banks: { value: TOWERS.map(([x, z]) => v(x, TOWER_H, z)) },
          levels: { value: [0, 0, 0, 0] },
        },
        vertexShader: /* glsl */ `
          varying vec3 vDir;
          varying vec3 vWorld;
          void main() {
            vDir = normalize(position);
            vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform float glow;
          uniform vec3 banks[4];
          uniform float levels[4];
          varying vec3 vDir;
          varying vec3 vWorld;
          ${NOISE}
          void main() {
            float h = max(vDir.y, 0.0);
            // Each lit bank scatters in the night air around it.
            vec3 view = normalize(vWorld - cameraPosition);
            vec3 scatter = vec3(0.0);
            for (int i = 0; i < 4; i++) {
              float d = max(dot(view, normalize(banks[i] - cameraPosition)), 0.0);
              scatter += vec3(1.0, 0.95, 0.88) * levels[i] * (pow(d, 400.0) * 0.5 + pow(d, 40.0) * 0.05 + pow(d, 6.0) * 0.012);
            }
            vec3 zenith = vec3(0.0016, 0.0022, 0.0042);
            // The stadium's own light hangs in the air above the rim.
            vec3 haze = vec3(0.040, 0.045, 0.05) * glow;
            vec3 c = zenith + haze * exp(-h * 5.0) + vec3(0.004, 0.005, 0.008) * exp(-h * 2.0);
            vec2 p = vDir.xz / max(vDir.y, 0.05) * 60.0;
            float star = step(0.9985, hash12(floor(p))) * smoothstep(0.15, 0.6, h) * (1.0 - glow * 0.7);
            gl_FragColor = vec4(c + scatter + star * 0.03, 1.0);
          }
        `,
      }),
    )
    const sky = new Mesh(new SphereGeometry(600, 32, 16), this.sky)
    sky.renderOrder = -1
    this.scene.add(sky)

    this.buildTurf()
    this.crowd = this.buildBowl()
    this.ribbon = this.buildRibbon()
    this.buildTowers()
    this.buildPosts()
    this.led = this.buildBoard(opts)
    this.chalk = this.buildChalk()
    this.ballSpin = this.buildBall()
  }

  resize(width: number, height: number): void {
    if (!width || !height) return
    // Retina past this costs fill rate a phone doesn't have, and film grain hides it.
    const dpr = Math.min(window.devicePixelRatio || 1, Math.min(width, height) < 700 ? 1.25 : 1.5)
    this.renderer.setPixelRatio(dpr)
    this.renderer.setSize(width, height, false)
    this.post.setSize(Math.round(width * dpr), Math.round(height * dpr))
    this.aspect = width / height
    this.camera.aspect = this.aspect
  }

  render(t: number): void {
    const lamp = new Color()
    const lights = this.towers.map((tw) => {
      let sum = 0
      tw.strikes.forEach((on, i) => {
        const k = strike(t - on)
        sum += k
        tw.lens.setColorAt(i, lamp.setRGB(1, 0.94, 0.84).multiplyScalar(0.015 + k * 16))
      })
      if (tw.lens.instanceColor) tw.lens.instanceColor.needsUpdate = true
      return sum / tw.strikes.length
    })
    const lit = lights.reduce((a, b) => a + b, 0) / lights.length

    this.towers.forEach((tw, i) => {
      const k = lights[i]
      tw.glare.material.uniforms['strength'].value = k
      tw.beam.material.uniforms['strength'].value = k
      tw.lights.forEach((l) => (l.intensity = l.userData['base'] * k))
    })
    this.hemi.intensity = 0.2 + lit * 0.5
    this.fog.color.setRGB(0.006 + 0.034 * lit, 0.008 + 0.038 * lit, 0.011 + 0.042 * lit)
    this.sky.uniforms['glow'].value = lit
    this.sky.uniforms['levels'].value = lights
    this.crowd.uniforms['lit'].value = lit
    this.crowd.uniforms['time'].value = t
    this.crowd.uniforms['fogTint'].value = this.fog.color
    this.ribbon.color.setScalar(0.04 + lit * 1.6)

    const led = this.led.uniforms
    led['power'].value = smooth(range(t, 0.55, 0.9))
    led['wipe'].value = easeInOut(range(t, SCORE, SCORE + 0.32))
    led['logo'].value = range(t, LOGO[0], LOGO[1])
    led['time'].value = t

    this.chalk.uniforms['time'].value = t
    this.chalk.uniforms['erase'].value = smooth(range(t, ERASE[0], ERASE[1]))

    const tau = ballClock(t - KICK)
    const flying = t >= KICK && tau < 1.6
    this.ball.visible = flying
    if (flying) {
      const p = ballAt(tau, this.tmp.a)
      const vel = this.tmp.b.copy(BALL_V).setY(BALL_V.y - GRAVITY * tau).normalize()
      this.ball.position.copy(p)
      this.ball.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), vel)
      // A tight spiral, about ten turns a second.
      this.ballSpin.rotation.y = tau * Math.PI * 2 * 10
      // Shutter smear in u: ten turns a second over half a 60 fps frame.
      this.smear.value = (10 * ballRate(t - KICK)) / 120
    }

    // Where the camera was when a 1/90 s shutter opened, for motion blur.
    this.shot(t - 1 / 90)
    this.camera.updateMatrixWorld()
    this.shutter.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse)
    const cam = this.shot(t)
    this.camera.updateMatrixWorld()
    this.post.render(this.scene, this.camera, {
      ...cam,
      shutter: this.shutter,
      bloom: 0.55,
      // The iris is stopped down while the lens looks into the lamps.
      exposure: MathUtils.lerp(0.4, 1, smooth(range(t, 0.55, 1.4))),
      fade: 0,
      time: t,
    })
  }

  dispose(): void {
    this.post.dispose()
    this.materials.forEach((m) => m.dispose())
    this.textures.forEach((x) => x.dispose())
    this.scene.traverse((o) => {
      if (o instanceof Mesh) o.geometry.dispose()
    })
    this.renderer.dispose()
  }

  // ── Timeline ──────────────────────────────────────────────────────────────

  /** The camera move: off a light bank, the skycam, down beside the kick, up to the board. */
  private shot(t: number): { focus: number; aperture: number } {
    const a = this.aspect
    const portrait = a < 0.85
    // Pull the final frame back until the board fills ~80% of the width.
    const hfovEnd = 2 * Math.atan(Math.tan(MathUtils.degToRad(this.fovAt(SCENE_LENGTH)) / 2) * a)
    const dEnd = BOARD.w / 2 / Math.tan(hfovEnd / 2) / (portrait ? 0.86 : 0.74)
    const end = v(BOARD.x - dEnd, BOARD.y - 2.5 - dEnd * 0.04, 0)
    // A phone's tall frame puts the board high, with the posts and crowd under it.
    const endLook = v(BOARD.x, BOARD.y - (portrait ? 8 : 1), 0)

    const pos = track(
      [
        [0, v(84, 55.5, 60)],
        [0.7, v(76, 49, 50)],
        [1.3, v(30, 26, 8)],
        [2.1, v(19, 17, -2)],
        [KICK - 0.05, v(27.6, 1.35, -4.8), v(1.6, -0.2, 0.3)],
        [KICK + 0.6, v(28.8, 1.6, -4.4)],
        [ARRIVE - 0.5, v(40, 4.6, -2.6)],
        [ARRIVE, v(47, 6.4, -2.2)],
        [4.85, end.clone().add(v(-2, -1, 0))],
        [SCENE_LENGTH, end],
      ],
      t,
      this.tmp.a,
    )
    const look = track(
      [
        [0, v(98, 64, 74)],
        [0.7, v(93, 59, 67)],
        [1.3, v(44, 0, 0)],
        [2.1, v(40, 0, 0)],
        [KICK - 0.05, v(48, 4.6, -0.8), v(2, 1, 0)],
        [KICK + 0.6, v(50, 5.5, -0.2)],
        [ARRIVE, v(62, 9.5, 0)],
        [4.85, endLook],
        [SCENE_LENGTH, endLook],
      ],
      t,
      this.tmp.b,
    )
    // The operator follows the ball, a beat behind it.
    const s = t - KICK
    const ball = ballAt(ballClock(Math.max(0, s - 0.08)), this.tmp.c)
    const follow = 0.85 * smooth(range(s, -0.3, 0)) * (1 - smooth(range(s, 0.35, 1.3)))
    // A crane is never perfectly still.
    pos.x += Math.sin(t * 1.7) * 0.05
    pos.y += Math.sin(t * 2.3 + 1) * 0.04
    this.camera.position.copy(pos)
    // Blend headings, not points, so a near ball and far posts share the frame fairly.
    const far = look.distanceTo(pos)
    const heading = look.sub(pos).normalize().lerp(ball.sub(pos).normalize(), follow).normalize()
    this.camera.lookAt(heading.multiplyScalar(far).add(pos))
    this.camera.fov = this.fovAt(t)
    this.camera.updateProjectionMatrix()

    if (s < 0) return { focus: far, aperture: 4 }
    const ballDist = pos.distanceTo(ballAt(ballClock(s), this.tmp.c))
    const pull = smooth(range(t, ARRIVE - 0.25, ARRIVE + 0.35))
    return { focus: MathUtils.lerp(ballDist, far, pull), aperture: MathUtils.lerp(12, 3, pull) }
  }

  /** Vertical fov: a phone gets more of it so the frame keeps its width. */
  private fovAt(t: number): number {
    const h = MathUtils.lerp(60, 44, smooth(range(t, 0, 2.6))) - 6 * smooth(range(t, ARRIVE - 0.4, 5))
    const vfov = 2 * MathUtils.radToDeg(Math.atan(Math.tan(MathUtils.degToRad(h) / 2) / this.aspect))
    return Math.min(vfov, this.aspect < 0.85 ? 66 : 48)
  }

  // ── Builders ──────────────────────────────────────────────────────────────

  private keep<T extends Material>(m: T): T {
    this.materials.push(m)
    return m
  }

  private texture<T extends Texture>(x: T): T {
    this.textures.push(x)
    return x
  }

  private buildTurf(): void {
    const paint = this.texture(new CanvasTexture(paintField(4096)))
    paint.colorSpace = SRGBColorSpace
    paint.anisotropy = this.renderer.capabilities.getMaxAnisotropy()
    const mat = this.keep(new MeshStandardMaterial({ roughness: 0.9, metalness: 0 }))
    mat.onBeforeCompile = (shader) => {
      shader.uniforms['uPaint'] = { value: paint }
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWorldT;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvWorldT = (modelMatrix * vec4(transformed, 1.0)).xyz;')
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nvarying vec3 vWorldT;\nuniform sampler2D uPaint;\n${NOISE}`)
        .replace(
          '#include <map_fragment>',
          /* glsl */ `
          vec2 fp = vWorldT.xz;
          float fine = 1.0 - smoothstep(0.15, 0.6, fwidth(fp.x * 6.0));
          float n1 = vnoise(fp * 0.21);
          float n2 = vnoise(fp * 1.7);
          float n3 = vnoise(fp * 6.0);
          float n4 = vnoise(fp * 23.0);
          vec3 grass = mix(vec3(0.034, 0.078, 0.024), vec3(0.058, 0.090, 0.030), n1 * 0.7 + n2 * 0.3);
          grass *= 0.86 + 0.18 * n2 + (0.16 * (n3 - 0.5) + 0.2 * (n4 - 0.5)) * fine;
          // Mowing stripes: five-yard bands laid in alternating directions. Looking
          // with the grain the blades show their tops, against it their sides.
          float band = mod(floor((fp.x + 50.0) / 5.0), 2.0) * 2.0 - 1.0;
          vec3 toCam = normalize(cameraPosition - vWorldT);
          float play = (1.0 - smoothstep(60.0, 61.0, abs(fp.x))) * (1.0 - smoothstep(${(SIDELINE + 2).toFixed(2)}, ${(SIDELINE + 3).toFixed(2)}, abs(fp.y)));
          grass *= 1.0 + band * (0.08 + 0.3 * clamp(toCam.x * 3.0, -1.0, 1.0)) * play;
          vec2 puv = vec2((fp.x + ${PAINT_X.toFixed(1)}) / ${(PAINT_X * 2).toFixed(1)}, 1.0 - (fp.y + ${PAINT_Z.toFixed(1)}) / ${(PAINT_Z * 2).toFixed(1)});
          vec4 paint = texture2D(uPaint, puv);
          // Paint sits in the turf, so the grass shows through it a little.
          float worn = 0.78 + 0.22 * mix(0.6, n4, fine);
          diffuseColor.rgb = mix(grass, paint.rgb * 0.55, paint.a * worn);
          `,
        )
    }
    const turf = new Mesh(new PlaneGeometry(260, 220), mat)
    turf.rotation.x = -Math.PI / 2
    turf.receiveShadow = true
    this.scene.add(turf)
  }

  private buildBowl(): ShaderMaterial {
    const crowd = this.keep(
      new ShaderMaterial({
        fog: false,
        uniforms: {
          lit: { value: 0 },
          time: { value: 0 },
          rows: { value: 30 },
          fogTint: { value: new Color() },
          fogDensity: { value: this.fog.density },
        },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          varying float vDist;
          void main() {
            vUv = uv;
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            vDist = length(mv.xyz);
            gl_Position = projectionMatrix * mv;
          }
        `,
        fragmentShader: /* glsl */ `
          uniform float lit;
          uniform float time;
          uniform float rows;
          varying vec2 vUv;
          varying float vDist;
          ${NOISE}
          ${FOG}
          void main() {
            vec2 cell = vec2(vUv.x / 0.55, vUv.y);
            vec2 id = floor(cell);
            vec2 f = fract(cell);
            float aisle = step(mod(id.x + 7.0, 30.0), 1.5);
            float here = step(0.12, hash12(id)) * (1.0 - aisle);
            float hue = hash12(id + 3.7);
            // Mostly dark coats, some white, the home colour scattered through.
            vec3 shirt = vec3(0.025, 0.026, 0.03) + vec3(0.07, 0.068, 0.064) * hash12(id + 9.1);
            shirt = mix(shirt, vec3(0.2, 0.2, 0.19), step(0.9, hue));
            shirt = mix(shirt, vec3(0.006, 0.07, 0.05), step(0.82, hue) * step(hue, 0.9));
            vec3 skin = mix(vec3(0.17, 0.10, 0.065), vec3(0.05, 0.03, 0.018), hash12(id + 1.3));
            vec3 seat = vec3(0.01, 0.011, 0.014);
            vec2 jit = (vec2(hash12(id + 2.2), hash12(id + 4.4)) - 0.5) * vec2(0.3, 0.14);
            vec2 q = f - vec2(0.5, 0.0) - jit;
            float torso = smoothstep(0.36, 0.3, length(vec2(q.x, max(q.y - 0.3, 0.0) * 1.6)));
            float headM = smoothstep(0.15, 0.11, length((q - vec2(0.0, 0.68)) * vec2(1.0, 1.15)));
            vec3 c = mix(seat, shirt, torso * here);
            c = mix(c, skin, headM * here);
            // The row in front shades the bottom of each one.
            c *= 0.45 + 0.55 * smoothstep(0.0, 0.4, f.y);
            // Once a seat is under a pixel, show the average rather than shimmer.
            float px = max(fwidth(cell.x), fwidth(cell.y));
            vec3 avg = mix(seat, shirt * 0.5 + skin * 0.1, 0.55 * here) * 0.75;
            c = mix(c, avg, smoothstep(0.3, 0.8, px));
            // Sections fill unevenly.
            c *= 0.7 + 0.6 * vnoise(vec2(vUv.x * 0.04, vUv.y * 0.12));
            float rowK = vUv.y / rows;
            c *= 0.1 + lit * (1.5 - 0.9 * rowK);
            // Phone flashes, a scatter all night and a burst when it's good.
            float burst = smoothstep(${SCORE.toFixed(2)}, ${(SCORE + 0.1).toFixed(2)}, time);
            float rate = 0.9995 - burst * 0.0025;
            float fh = hash12(id * 1.37 + floor(time * 6.0));
            float age = fract(time * 6.0);
            float flash = step(rate, fh) * exp(-age * 9.0) * here;
            float dot = mix(smoothstep(0.16, 0.0, length(q - vec2(0.0, 0.62))), 0.25, smoothstep(0.3, 1.0, px));
            c += vec3(5.0, 4.9, 4.6) * flash * dot;
            gl_FragColor = vec4(fogged(c, vDist), 1.0);
          }
        `,
      }),
    )
    // Lower bowl, then the upper deck set back over a fascia.
    const lower = new Mesh(tier(1, 30, 1.6, 19, 30), crowd)
    this.scene.add(lower)
    const upper = new Mesh(tier(30, 20, 23.5, 38, 20), crowd)
    this.scene.add(upper)

    const wall = this.keep(new MeshStandardMaterial({ color: 0x0b1420, roughness: 0.8 }))
    this.scene.add(new Mesh(tier(0, 1, 0, 1.6, 1), wall))
    const roof = this.keep(new MeshStandardMaterial({ color: 0x080a0e, roughness: 0.9 }))
    this.scene.add(new Mesh(tier(50, 3, 38, 41, 1), roof))
    return crowd
  }

  /** The LED ribbon around the bowl's fascia. */
  private buildRibbon(): MeshBasicMaterial {
    const tex = this.texture(new CanvasTexture(paintRibbon()))
    tex.colorSpace = SRGBColorSpace
    tex.wrapS = RepeatWrapping
    tex.repeat.set(1 / 40, 1)
    const mat = this.keep(new MeshBasicMaterial({ map: tex, fog: true }))
    const g = tier(30.2, 0.4, 19.6, 22.6, 1)
    // tier() gives yards along the ring as u; one texture repeat per 40 yards.
    const ribbon = new Mesh(g, mat)
    this.scene.add(ribbon)
    const fascia = this.keep(new MeshStandardMaterial({ color: 0x07090c, roughness: 0.7 }))
    this.scene.add(new Mesh(tier(30, 0.2, 19, 23.5, 1), fascia))
    return mat
  }

  private buildTowers(): void {
    const glareTex = this.texture(radialTexture())
    const frame = this.keep(new MeshStandardMaterial({ color: 0x1a1d22, roughness: 0.6, metalness: 0.5 }))
    const lensMat = this.keep(new MeshBasicMaterial({ color: 0xffffff, fog: false, map: this.texture(reflectorTexture()) }))
    const field = v(10, 0, 0)
    for (const [x, z] of TOWERS) {
      const sx = Math.sign(x)
      const base = v(x, 0, z)
      const top = base.clone().setY(TOWER_H)
      const pole = new Mesh(new CylinderGeometry(0.5, 1.1, TOWER_H, 10), frame)
      pole.position.copy(base).setY(TOWER_H / 2)
      this.scene.add(pole)

      const headGroup = new Group()
      headGroup.position.copy(top)
      headGroup.lookAt(field)
      this.scene.add(headGroup)
      const back = new Mesh(new BoxGeometry(15, 8.4, 0.5), frame)
      back.position.z = -0.6
      headGroup.add(back)
      const rail = new Mesh(new BoxGeometry(15.4, 0.25, 1.6), frame)
      rail.position.set(0, -4.4, 0.2)
      headGroup.add(rail)

      // Each fixture: a housing, a lens and a visor, aimed a little differently.
      const n = 7 * 4
      const housing = new BoxGeometry(1.6, 1.5, 1.1)
      housing.translate(0, 0, -0.1)
      const lensGeo = new CylinderGeometry(0.62, 0.62, 0.06, 20)
      lensGeo.rotateX(Math.PI / 2)
      lensGeo.translate(0, 0, 0.47)
      const visorGeo = new BoxGeometry(1.6, 0.08, 0.7)
      visorGeo.translate(0, 0.78, 0.7)
      const bodies = new InstancedMesh(housing, frame, n)
      const visors = new InstancedMesh(visorGeo, frame, n)
      const lens = new InstancedMesh(lensGeo, lensMat, n)
      const strikes: number[] = []
      const o = new Object3D()
      const r0 = rand(this.towers.length + 3)
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 7; c++) {
          const i = r * 7 + c
          o.position.set((c - 3) * 1.95, (1.5 - r) * 1.85, 0)
          o.rotation.set((r0() - 0.5) * 0.12 - 0.05, (r0() - 0.5) * 0.14, 0)
          o.updateMatrix()
          bodies.setMatrixAt(i, o.matrix)
          visors.setMatrixAt(i, o.matrix)
          lens.setMatrixAt(i, o.matrix)
          lens.setColorAt(i, new Color(0, 0, 0))
          // The bank comes up row by row, with a little scatter.
          strikes.push(TOWER_ON[this.towers.length] + i * 0.007 + r0() * 0.03)
        }
      }
      headGroup.add(bodies, visors, lens)

      const glare = new Mesh(
        new PlaneGeometry(1, 1),
        this.keep(
          new ShaderMaterial({
            transparent: true,
            depthWrite: false,
            blending: AdditiveBlending,
            uniforms: { map: { value: glareTex }, strength: { value: 0 } },
            vertexShader: /* glsl */ `
              varying vec2 vUv;
              varying float vFade;
              void main() {
                vUv = uv;
                // Always faces the lens, and keeps roughly the same size on
                // screen like a real flare; up close it gives way to the lamps.
                vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
                float dist = length(mv.xyz);
                vFade = smoothstep(30.0, 70.0, dist);
                mv.xy += position.xy * dist * 0.22;
                gl_Position = projectionMatrix * mv;
              }
            `,
            fragmentShader: /* glsl */ `
              uniform sampler2D map;
              uniform float strength;
              varying vec2 vUv;
              varying float vFade;
              void main() {
                float g = texture2D(map, vUv).r;
                vec2 p = vUv - 0.5;
                // Faint six-blade aperture star.
                float a = atan(p.y, p.x);
                float star = pow(abs(cos(a * 3.0)), 60.0) * smoothstep(0.5, 0.0, length(p));
                gl_FragColor = vec4(vec3(1.0, 0.95, 0.86) * (g * 0.5 + star * 0.2) * strength * vFade, 1.0);
              }
            `,
          }),
        ),
      )
      glare.position.copy(top).add(field.clone().sub(top).normalize().multiplyScalar(1.5))
      glare.renderOrder = 2
      this.scene.add(glare)

      // The beam through the haze, from the bank down onto the field.
      const toField = field.clone().sub(top)
      const len = toField.length()
      const beamGeo = new CylinderGeometry(4, 24, len, 32, 1, true)
      beamGeo.translate(0, -len / 2, 0)
      const beam = new Mesh(
        beamGeo,
        this.keep(
          new ShaderMaterial({
            transparent: true,
            depthWrite: false,
            side: DoubleSide,
            blending: AdditiveBlending,
            uniforms: { strength: { value: 0 }, len: { value: len } },
            vertexShader: /* glsl */ `
              varying vec3 vN;
              varying vec3 vView;
              varying float vAlong;
              varying vec3 vWorld;
              uniform float len;
              void main() {
                vAlong = -position.y / len;
                vec4 w = modelMatrix * vec4(position, 1.0);
                vWorld = w.xyz;
                vN = normalize(mat3(modelMatrix) * normal);
                vView = normalize(cameraPosition - w.xyz);
                gl_Position = projectionMatrix * viewMatrix * w;
              }
            `,
            fragmentShader: /* glsl */ `
              uniform float strength;
              varying vec3 vN;
              varying vec3 vView;
              varying float vAlong;
              varying vec3 vWorld;
              ${NOISE}
              void main() {
                float edge = pow(abs(dot(normalize(vN), normalize(vView))), 1.6);
                float along = clamp(vAlong, 0.0, 1.0);
                float fall = smoothstep(0.0, 0.08, along) * pow(1.0 - along, 1.4);
                float drift = 0.6 + 0.8 * vnoise(vWorld.xy * 0.05 + vWorld.z * 0.03);
                // Haze right at the lens would fog the frame; real beams only show at a distance.
                drift *= smoothstep(10.0, 50.0, length(cameraPosition - vWorld));
                gl_FragColor = vec4(vec3(1.0, 0.96, 0.9) * edge * fall * drift * strength * 0.035, 1.0);
              }
            `,
          }),
        ),
      )
      beam.position.copy(top)
      beam.quaternion.copy(new Quaternion().setFromUnitVectors(v(0, -1, 0), toField.clone().normalize()))
      this.scene.add(beam)

      const lights: SpotLight[] = []
      const wide = new SpotLight(0xfff3e2, 1, 0, 0.62, 1, 0)
      wide.position.copy(top)
      wide.target.position.copy(field)
      wide.userData['base'] = sx > 0 ? 2.2 : 3.0
      this.scene.add(wide, wide.target)
      lights.push(wide)
      // The two banks behind the posts throw the posts' shadows up the field.
      if (sx > 0) {
        const key = new SpotLight(0xfff3e2, 1, 0, 0.2, 0.9, 0)
        key.position.copy(top)
        key.target.position.set(52, 0, 0)
        key.castShadow = true
        const map = Math.min(window.innerWidth, window.innerHeight) < 700 ? 1024 : 2048
        key.shadow.mapSize.set(map, map)
        key.shadow.bias = -0.0004
        key.shadow.normalBias = 0.02
        key.shadow.camera.near = 40
        key.shadow.camera.far = 200
        key.userData['base'] = 2.6
        this.scene.add(key, key.target)
        lights.push(key)
      }
      this.towers.push({ lens, strikes, glare, beam, lights })
    }
  }

  private buildPosts(): void {
    const paint = this.keep(new MeshStandardMaterial({ color: 0xb88a22, roughness: 0.42, metalness: 0.2 }))
    const pad = this.keep(new MeshStandardMaterial({ color: 0x0d1830, roughness: 0.85 }))
    const g = new Group()
    const r = 0.075
    const neck = new CatmullRomCurve3([v(62.4, 0, 0), v(62.4, 2.2, 0), v(62.1, 3.0, 0), v(61.0, CROSSBAR, 0), v(POSTS_X, CROSSBAR, 0)])
    g.add(new Mesh(new TubeGeometry(neck, 40, r * 1.6, 12), paint))
    const bar = new Mesh(new CylinderGeometry(r, r, UPRIGHT_GAP + r * 2, 12), paint)
    bar.rotation.x = Math.PI / 2
    bar.position.set(POSTS_X, CROSSBAR, 0)
    g.add(bar)
    for (const z of [-UPRIGHT_GAP / 2, UPRIGHT_GAP / 2]) {
      const up = new Mesh(new CylinderGeometry(r * 0.9, r, 35 / 3, 12), paint)
      up.position.set(POSTS_X, CROSSBAR + 35 / 6, z)
      g.add(up)
      const ribbon = new Mesh(
        new PlaneGeometry(0.12, 1.3),
        this.keep(new MeshStandardMaterial({ color: 0xc8401c, roughness: 0.7, side: DoubleSide })),
      )
      ribbon.position.set(POSTS_X + 0.25, CROSSBAR + 35 / 3 - 0.55, z)
      ribbon.rotation.set(0.1, 0.5, 0.35)
      g.add(ribbon)
    }
    const padding = new Mesh(new CylinderGeometry(0.32, 0.32, 2.2, 16), pad)
    padding.position.set(62.4, 1.1, 0)
    g.add(padding)
    g.traverse((o) => (o.castShadow = true))
    this.scene.add(g)
  }

  private buildBoard(opts: StadiumOptions): ShaderMaterial {
    const frame = (c: HTMLCanvasElement) => {
      const t = this.texture(new CanvasTexture(c))
      t.colorSpace = SRGBColorSpace
      t.minFilter = t.magFilter = NearestFilter
      t.generateMipmaps = false
      return t
    }
    const led = this.keep(
      new ShaderMaterial({
        fog: false,
        uniforms: {
          tA: { value: frame(paintScore({ home: '20', away: '21', clock: '0:03', note: 'FIELD GOAL UNIT' })) },
          tB: { value: frame(paintScore({ home: '23', away: '21', clock: '0:00', note: 'IT IS GOOD' })) },
          tC: { value: frame(paintLogo(opts.logo, opts.tagline)) },
          res: { value: new Vector2(256, 96) },
          power: { value: 0 },
          wipe: { value: 0 },
          logo: { value: 0 },
          time: { value: 0 },
        },
        vertexShader: /* glsl */ `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform sampler2D tA;
          uniform sampler2D tB;
          uniform sampler2D tC;
          uniform vec2 res;
          uniform float power;
          uniform float wipe;
          uniform float logo;
          uniform float time;
          varying vec2 vUv;
          ${NOISE}
          void main() {
            vec2 cell = vUv * res;
            vec2 id = floor(cell);
            vec2 uv = (id + 0.5) / res;
            vec3 a = texture2D(tA, uv).rgb;
            vec3 b = texture2D(tB, uv).rgb;
            vec3 c = texture2D(tC, uv).rgb;
            // Score update: a column wipe with a bright scan edge.
            float x = uv.x;
            vec3 col = mix(a, b, step(x, wipe));
            col += vec3(0.2, 0.24, 0.22) * smoothstep(0.02, 0.0, abs(x - wipe)) * step(0.001, wipe) * step(wipe, 0.999);
            // Then the logo: the score drops out, the logo opens from the centre.
            col *= 1.0 - smoothstep(0.0, 0.25, logo);
            float d = abs(x - 0.5) * 2.0;
            float open = (logo - 0.3) / 0.7 * 1.1;
            col = mix(col, c, step(d, open));
            col += vec3(0.2, 0.24, 0.22) * smoothstep(0.03, 0.0, abs(d - open)) * step(0.0, open) * step(open, 1.05);
            // Modules power up in a ripple.
            float module = hash12(floor(id / vec2(32.0, 24.0)));
            col *= step(module * 0.7, power * 1.05 - 0.05) * power;
            vec2 f = fract(cell) - 0.5;
            float px = max(fwidth(cell.x), fwidth(cell.y));
            float diode = smoothstep(0.42, 0.3 - min(px * 0.4, 0.25), length(f));
            // Seen from afar the dots merge; keep their average, not their moire.
            diode = mix(diode, 0.42, smoothstep(0.4, 1.2, px));
            vec3 off = vec3(0.012, 0.013, 0.016) * (0.6 + 0.4 * diode);
            gl_FragColor = vec4(off + col * diode * 4.2, 1.0);
          }
        `,
      }),
    )
    const housing = this.keep(new MeshStandardMaterial({ color: 0x14171c, roughness: 0.55, metalness: 0.6 }))
    const g = new Group()
    g.position.set(BOARD.x, BOARD.y, 0)
    const box = new Mesh(new BoxGeometry(2.4, BOARD.h + 1.6, BOARD.w + 1.6), housing)
    box.position.x = 1.2
    g.add(box)
    const face = new Mesh(new PlaneGeometry(BOARD.w, BOARD.h), led)
    face.rotation.y = -Math.PI / 2
    face.position.x = -0.02
    g.add(face)
    // A lip around the face so it reads as a recessed panel.
    for (const [w, h, y, z] of [
      [BOARD.w + 1.6, 0.8, BOARD.h / 2 + 0.4, 0],
      [BOARD.w + 1.6, 0.8, -BOARD.h / 2 - 0.4, 0],
      [0.8, BOARD.h, 0, BOARD.w / 2 + 0.4],
      [0.8, BOARD.h, 0, -BOARD.w / 2 - 0.4],
    ]) {
      const lip = new Mesh(new BoxGeometry(0.7, h, w), housing)
      lip.position.set(-0.3, y, z)
      g.add(lip)
    }
    for (const z of [-9, 9]) {
      const leg = new Mesh(new BoxGeometry(1.4, 20, 1.4), housing)
      leg.position.set(1.4, -BOARD.h / 2 - 10, z)
      g.add(leg)
    }
    this.scene.add(g)
    return led
  }

  private buildChalk(): ShaderMaterial {
    const mat = this.keep(
      new ShaderMaterial({
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        uniforms: { time: { value: 0 }, erase: { value: 0 } },
        vertexShader: /* glsl */ `
          attribute vec2 aAlong;
          attribute float aSide;
          attribute vec2 aTiming;
          varying vec2 vAlong;
          varying float vSide;
          varying vec2 vTiming;
          void main() {
            vAlong = aAlong;
            vSide = aSide;
            vTiming = aTiming;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: /* glsl */ `
          uniform float time;
          uniform float erase;
          varying vec2 vAlong;
          varying float vSide;
          varying vec2 vTiming;
          ${NOISE}
          void main() {
            float drawn = clamp((time - vTiming.x) / vTiming.y, 0.0, 1.0);
            // The pen eases into and out of each stroke.
            drawn = drawn * drawn * (3.0 - 2.0 * drawn);
            if (vAlong.x > drawn || drawn <= 0.0) discard;
            float s = abs(vSide);
            float len = vAlong.y;
            // Dry chalk: dragged streaks, a ragged edge, and gaps where it skipped.
            float streak = vnoise(vec2(len * 2.4, vSide * 3.0 + 7.0));
            float grit = vnoise(vec2(len * 38.0, vSide * 14.0));
            float edge = 0.7 + 0.28 * vnoise(vec2(len * 6.0, vSide * 2.0 + 3.0)) - 0.25 * grit;
            float a = 1.0 - smoothstep(edge - 0.12, edge, s);
            a *= smoothstep(0.12, 0.42, grit * 0.7 + streak * 0.5);
            a *= 0.8 + 0.2 * streak;
            vec3 c = vec3(1.3, 1.26, 1.12);
            gl_FragColor = vec4(c, a * (1.0 - erase));
          }
        `,
      }),
    )
    const mesh = new Mesh(chalkGeometry(playbook(), 0.3), mat)
    mesh.renderOrder = 1
    this.scene.add(mesh)
    return mat
  }

  private buildBall(): Mesh {
    const { albedo, bump } = paintBall()
    const map = this.texture(new CanvasTexture(albedo))
    map.colorSpace = SRGBColorSpace
    map.wrapS = RepeatWrapping
    const bumpMap = this.texture(new CanvasTexture(bump))
    bumpMap.wrapS = RepeatWrapping
    const mat = this.keep(new MeshStandardMaterial({ map, bumpMap, bumpScale: 1.2, roughness: 0.62, metalness: 0 }))
    // Ten turns a second is a sixth of a turn per frame: smear the texture
    // across that arc so the laces blur like a real shutter, not strobe.
    mat.onBeforeCompile = (shader) => {
      shader.uniforms['uSmear'] = this.smear
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uSmear;').replace(
        '#include <map_fragment>',
        /* glsl */ `
        vec4 sampledDiffuseColor = vec4(0.0);
        for (int i = 0; i < 8; i++) {
          sampledDiffuseColor += texture2D(map, vMapUv + vec2((float(i) / 7.0 - 0.5) * uSmear, 0.0));
        }
        sampledDiffuseColor /= 8.0;
        diffuseColor *= sampledDiffuseColor;
        `,
      )
    }
    // An American football: a prolate spheroid drawn to points.
    const L = 0.153
    const R = 0.094
    const profile: Vector2[] = []
    for (let i = 0; i <= 32; i++) {
      const y = -L + (2 * L * i) / 32
      profile.push(new Vector2(R * Math.pow(Math.max(0, 1 - (y / L) ** 2), 0.72) + 0.002, y))
    }
    const mesh = new Mesh(new LatheGeometry(profile, 48), mat)
    mesh.castShadow = true
    this.ball.add(mesh)
    this.ball.visible = false
    this.scene.add(this.ball)
    return mesh
  }
}

export interface IntroScene {
  resize(width: number, height: number): void
  render(t: number): void
  dispose(): void
}

/**
 * Builds the scene once the logo and the scoreboard font are in. Resolves
 * null when the device can't give us WebGL 2. An object so tests can stub it.
 */
export const stage = {
  async open(canvas: HTMLCanvasElement, tagline: string): Promise<IntroScene | null> {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, stencil: false, powerPreference: 'high-performance' })
    if (!gl) return null
    const logo = new Image()
    logo.src = '/assets/img/xomper-banner.png'
    await Promise.all([
      logo.decode(),
      // The board falls back to Impact rather than hold the intro for a slow font.
      Promise.race([document.fonts.load('400 40px "Bebas Neue"'), new Promise((r) => setTimeout(r, 1200))]),
    ])
    const stadium = new Stadium(new WebGLRenderer({ canvas, context: gl }), { logo, tagline })
    stadium.resize(canvas.clientWidth, canvas.clientHeight)
    // Compile every shader now, ball and shadows included, so the kick doesn't hitch.
    stadium.render(KICK + 0.3)
    return stadium
  },
}
