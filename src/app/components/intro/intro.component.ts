import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  NgZone,
  afterNextRender,
  inject,
  output,
  viewChild,
} from '@angular/core'
import { DOCUMENT } from '@angular/common'
import { environment } from '../../../environments/environment'
import { IntroScene, SCENE_LENGTH, stage } from './stadium'

// From the first rendered frame to the end of the exit fade in intro.component.scss.
export const INTRO_LENGTH = SCENE_LENGTH * 1000

/**
 * The ~5.5 s landing intro: a stadium at night as a broadcast open. The lights
 * strike, a telestrator draws the play on the turf, the camera drops behind a
 * field goal and cranes up to the scoreboard as it turns to the Xomper logo.
 * The scene is three.js (stadium.ts); `index.html` paints the dark first frame
 * as a poster before any of it loads.
 */
@Component({
  selector: 'app-intro',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './intro.component.html',
  styleUrl: './intro.component.scss',
  host: {
    role: 'region',
    'aria-label': 'Xomper intro',
    '(document:keydown.escape)': 'done.emit()',
  },
})
export class IntroComponent {
  readonly done = output<void>()
  private readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas')

  constructor() {
    const doc = inject(DOCUMENT)
    const zone = inject(NgZone)
    const host: HTMLElement = inject(ElementRef).nativeElement
    let scene: IntroScene | null = null
    let frame = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let destroyed = false

    inject(DestroyRef).onDestroy(() => {
      destroyed = true
      cancelAnimationFrame(frame)
      clearTimeout(timer)
      window.removeEventListener('resize', resize)
      scene?.dispose()
    })

    const resize = () => scene?.resize(window.innerWidth, window.innerHeight)

    afterNextRender(() => {
      stage.open(this.canvas().nativeElement, environment.appEyebrow).then(
        (s) => {
          if (destroyed) return s?.dispose()
          // No WebGL 2: straight to the landing.
          if (!s) return this.done.emit()
          scene = s
          zone.runOutsideAngular(() => {
            resize()
            window.addEventListener('resize', resize)
            let start = 0
            const tick = () => {
              const now = performance.now()
              if (!start) {
                start = now
                // The scene has its own first frame now; the poster can go.
                doc.documentElement.dataset['intro'] = 'playing'
                host.classList.add('is-playing')
                timer = setTimeout(() => zone.run(() => this.done.emit()), INTRO_LENGTH)
              }
              s.render((now - start) / 1000)
              frame = requestAnimationFrame(tick)
            }
            frame = requestAnimationFrame(tick)
          })
        },
        // A logo or shader that fails to load costs the intro, not the landing.
        () => this.done.emit(),
      )
    })
  }
}
