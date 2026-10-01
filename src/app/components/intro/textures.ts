// Everything painted on a 2D canvas for the stadium: the field markings, the
// football's leather, and the frames the scoreboard shows. Units are yards.

// Half the field's 160 ft width, in yards.
export const SIDELINE = 160 / 3 / 2
export const PAINT_X = 70
export const PAINT_Z = 40

const DISPLAY = '"Bebas Neue", Impact, "Arial Narrow", sans-serif'

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d')
  if (!g) throw new Error('2D canvas unavailable')
  return [c, g]
}

function rand(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * The painted markings, transparent where it's grass. Canvas x is field x
 * (-70..70), canvas y is field z (-40..40). The near sideline is z < 0.
 */
export function paintField(width: number): HTMLCanvasElement {
  const k = width / (PAINT_X * 2)
  const [c, g] = canvas(width, Math.round(PAINT_Z * 2 * k))
  g.translate(PAINT_X * k, PAINT_Z * k)
  g.scale(k, k)
  const paint = 'rgba(236, 234, 226, 0.94)'
  const S = SIDELINE

  // End zones: deep navy paint with the name across, read from the field.
  g.fillStyle = 'rgba(16, 26, 44, 0.9)'
  g.fillRect(50, -S, 10, S * 2)
  g.fillRect(-60, -S, 10, S * 2)
  for (const end of [1, -1]) {
    g.save()
    g.translate(55 * end, 0)
    g.rotate((end * Math.PI) / 2)
    g.font = `400 7.4px ${DISPLAY}`
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.lineJoin = 'round'
    g.strokeStyle = 'rgba(236, 234, 226, 0.92)'
    g.lineWidth = 0.22
    g.fillStyle = 'rgba(0, 150, 104, 0.55)'
    g.scale(1.25, 1)
    for (let i = 0; i < 6; i++) {
      const x = (i - 2.5) * 5.6
      g.fillText('XOMPER'[i], x, 0.4)
      g.strokeText('XOMPER'[i], x, 0.4)
    }
    g.restore()
  }

  g.fillStyle = paint
  // The six-foot white border outside the sidelines and end lines.
  g.fillRect(-62, -S - 2, 124, 2)
  g.fillRect(-62, S, 124, 2)
  g.fillRect(-62, -S, 2, S * 2)
  g.fillRect(60, -S, 2, S * 2)
  // Goal lines.
  g.fillRect(50 - 0.22, -S, 0.22, S * 2)
  g.fillRect(-50, -S, 0.22, S * 2)

  for (let x = -49; x <= 49; x++) {
    if (x % 5 === 0) {
      g.fillRect(x - 0.055, -S + 0.22, 0.11, S * 2 - 0.44)
      continue
    }
    for (const z of [-S, 3.08, -3.08 - 0.67, S - 0.67]) g.fillRect(x - 0.055, z, 0.11, 0.67)
  }
  // Try lines.
  g.fillRect(47.95, -0.5, 0.11, 1)
  g.fillRect(-48.05, -0.5, 0.11, 1)

  // Numbers: tops nine yards in from each sideline, read from that sideline.
  g.font = `400 2.9px ${DISPLAY}`
  g.textBaseline = 'alphabetic'
  for (let x = -40; x <= 40; x += 10) {
    const label = String(50 - Math.abs(x))
    for (const side of [1, -1]) {
      g.save()
      g.translate(x, side * (S - 7))
      if (side < 0) g.rotate(Math.PI)
      g.scale(1.45, 1)
      g.textAlign = 'right'
      g.fillText(label[0], -0.3, 0)
      g.textAlign = 'left'
      g.fillText(label[1], 0.3, 0)
      g.restore()

      if (x === 0) continue
      // The arrow points at the nearer goal line.
      const dir = Math.sign(x)
      const ax = x + dir * 2.45
      const az = side * (S - 8)
      g.beginPath()
      g.moveTo(ax + dir * 0.6, az)
      g.lineTo(ax, az - 0.3)
      g.lineTo(ax, az + 0.3)
      g.closePath()
      g.fill()
    }
  }
  return c
}

/** Leather albedo and a matching pebble height map, u around the ball and v along it. */
export function paintBall(): { albedo: HTMLCanvasElement; bump: HTMLCanvasElement } {
  const W = 512
  const H = 256
  const [albedo, g] = canvas(W, H)
  const [bump, b] = canvas(W, H)
  const r = rand(7)

  const leather = g.createLinearGradient(0, 0, 0, H)
  leather.addColorStop(0, '#3e1f10')
  leather.addColorStop(0.18, '#6a3519')
  leather.addColorStop(0.5, '#7b4020')
  leather.addColorStop(0.82, '#6a3519')
  leather.addColorStop(1, '#3e1f10')
  g.fillStyle = leather
  g.fillRect(0, 0, W, H)
  b.fillStyle = '#808080'
  b.fillRect(0, 0, W, H)

  // Pebbled grain.
  for (let i = 0; i < 9000; i++) {
    const x = r() * W
    const y = r() * H
    const s = 0.8 + r() * 1.4
    const v = r()
    g.fillStyle = v > 0.5 ? 'rgba(150, 90, 50, 0.16)' : 'rgba(30, 12, 4, 0.22)'
    g.fillRect(x, y, s, s)
    b.fillStyle = `rgba(${v > 0.3 ? 200 : 40}, ${v > 0.3 ? 200 : 40}, ${v > 0.3 ? 200 : 40}, 0.5)`
    b.beginPath()
    b.arc(x, y, s * 0.8, 0, Math.PI * 2)
    b.fill()
  }

  // Four panels; seams sink into the leather.
  for (let i = 0; i < 4; i++) {
    const x = (i * W) / 4
    g.fillStyle = 'rgba(20, 8, 2, 0.75)'
    g.fillRect(x - 1.5, 0, 3, H)
    b.fillStyle = '#202020'
    b.fillRect(x - 2, 0, 4, H)
  }

  // Laces across the seam at u = 0.5.
  const cx = W / 2
  const lace = (x: number, y: number, w: number, h: number) => {
    g.fillStyle = 'rgba(0, 0, 0, 0.35)'
    g.fillRect(x + 1, y + 1.5, w, h)
    g.fillStyle = '#e9e3d2'
    g.fillRect(x, y, w, h)
    b.fillStyle = '#f0f0f0'
    b.fillRect(x, y, w, h)
  }
  lace(cx - 3, H * 0.3, 6, H * 0.4)
  for (let i = 0; i < 8; i++) lace(cx - 15, H * 0.32 + i * H * 0.05, 30, 4)
  return { albedo, bump }
}

export interface BoardFrame {
  home: string
  away: string
  clock: string
  note: string
}

const LED_W = 256
const LED_H = 96

/** One scoreboard frame at LED resolution: one texel is one diode. */
export function paintScore(f: BoardFrame): HTMLCanvasElement {
  const [c, g] = canvas(LED_W, LED_H)
  g.fillStyle = '#000'
  g.fillRect(0, 0, LED_W, LED_H)
  g.textAlign = 'center'
  g.textBaseline = 'alphabetic'

  g.font = `400 15px ${DISPLAY}`
  g.fillStyle = '#9aa3a8'
  g.fillText('HOME', 52, 22)
  g.fillText('AWAY', 204, 22)
  g.font = `400 54px ${DISPLAY}`
  g.fillStyle = '#e8fff4'
  g.fillText(f.home, 52, 76)
  g.fillStyle = '#f2f0e8'
  g.fillText(f.away, 204, 76)

  g.font = `400 15px ${DISPLAY}`
  g.fillStyle = '#9aa3a8'
  g.fillText('4TH', 128, 22)
  g.font = `400 30px ${DISPLAY}`
  g.fillStyle = '#ffb347'
  g.fillText(f.clock, 128, 52)
  g.font = `400 13px ${DISPLAY}`
  g.fillStyle = '#e8fff4'
  g.fillText(f.note, 128, 84)

  // The home side's accent bar.
  g.fillStyle = '#00c486'
  g.fillRect(16, 88, 72, 3)
  return c
}

export function paintLogo(logo: HTMLImageElement, tagline: string): HTMLCanvasElement {
  const [c, g] = canvas(LED_W, LED_H)
  g.fillStyle = '#000'
  g.fillRect(0, 0, LED_W, LED_H)
  const h = 72
  const w = (logo.naturalWidth / logo.naturalHeight) * h
  g.drawImage(logo, (LED_W - w) / 2, 2, w, h)
  g.font = `400 14px ${DISPLAY}`
  g.textAlign = 'center'
  g.fillStyle = '#cfd6d2'
  g.fillText(tagline.toUpperCase(), LED_W / 2, 89)
  return c
}

/** The ribbon board on the bowl's fascia: one long strip of text, tiled. */
export function paintRibbon(): HTMLCanvasElement {
  const [c, g] = canvas(1024, 32)
  g.fillStyle = '#05080a'
  g.fillRect(0, 0, 1024, 32)
  g.font = `400 24px ${DISPLAY}`
  g.textBaseline = 'middle'
  const items = ['XOMPER', 'FANTASY FOOTBALL', 'XOMPER', 'MEASURED']
  let x = 20
  for (const item of items) {
    g.fillStyle = item === 'XOMPER' ? '#00c486' : '#c9d2d0'
    g.fillText(item, x, 17)
    x += g.measureText(item).width + 60
  }
  return c
}
