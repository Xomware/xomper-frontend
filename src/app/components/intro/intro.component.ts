import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  afterNextRender,
  inject,
  output,
} from '@angular/core'
import { DOCUMENT } from '@angular/common'
import { environment } from '../../../environments/environment'

// Matches the exit fade at the end of intro.component.scss.
export const INTRO_LENGTH = 5300

// The field is drawn in a 800 × 1000 viewBox, sliced to fill the screen: a
// phone sees x 170-630, a desktop y 250-750, so everything that matters
// stays inside that box. Depth is z (1 = near touchline, 4.4 = goal line),
// projected onto a vanishing line at y = 340.
const HORIZON = 340
const DEPTH = 440
const project = (z: number) => HORIZON + DEPTH / z

interface Line {
  y: number
  half: number
}

interface Player {
  x: number
  y: number
  size: number
  delay: number
}

const yardLine = (z: number): Line => {
  const y = project(z)
  return { y, half: (y - HORIZON) * 1.3 }
}

export const YARD_LINES: readonly Line[] = Array.from({ length: 11 }, (_, i) =>
  yardLine(1 + i * 0.34),
)

const player = (x: number, z: number, delay: number): Player => ({
  x,
  y: project(z),
  size: 1.6 / z,
  delay,
})

// Offense on the line, a QB behind, receivers split wide; the defense a step
// upfield. Pops in left to right, offense first.
export const OFFENSE: readonly Player[] = [
  player(232, 1.5, 0),
  player(352, 1.5, 60),
  player(376, 1.5, 90),
  player(400, 1.5, 120),
  player(424, 1.5, 150),
  player(448, 1.5, 180),
  player(568, 1.5, 240),
  player(400, 1.2, 300),
]

export const DEFENSE: readonly Player[] = [
  player(246, 1.78, 380),
  player(340, 1.78, 420),
  player(380, 1.78, 450),
  player(420, 1.78, 480),
  player(460, 1.78, 510),
  player(556, 1.78, 570),
  player(400, 2.3, 620),
]

// Lamp banks: the inner pair frames a phone, the outer pair a desktop.
export const TOWERS: readonly number[] = [90, 205, 595, 710]

/**
 * The ~5 s landing intro: stadium lights flick on over a night field, a play
 * is drawn up in X's and O's, the ball spirals through the uprights, and the
 * scoreboard flips over to the Xomper logo. CSS animations on transforms and
 * opacity; `index.html` paints the scene's first frame as a poster before JS.
 */
@Component({
  selector: 'app-intro',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './intro.component.html',
  styleUrl: './intro.component.scss',
  host: { role: 'region', 'aria-label': 'Xomper intro' },
})
export class IntroComponent {
  readonly done = output<void>()
  readonly lines = YARD_LINES
  readonly offense = OFFENSE
  readonly defense = DEFENSE
  readonly towers = TOWERS
  readonly lamps = [0, 1, 2, 3, 4, 5, 6, 7]
  readonly slats = [0, 1, 2, 3, 4, 5]
  readonly tagline = environment.appEyebrow

  constructor() {
    const doc = inject(DOCUMENT)
    const destroyRef = inject(DestroyRef)
    afterNextRender(() => {
      // The scene has painted over the poster, which can go.
      doc.documentElement.dataset['intro'] = 'playing'
      const id = setTimeout(() => this.done.emit(), INTRO_LENGTH)
      destroyRef.onDestroy(() => clearTimeout(id))
    })
  }
}
