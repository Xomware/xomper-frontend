import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  inject,
  signal,
} from '@angular/core'
import { DOCUMENT } from '@angular/common'

import { IntroComponent } from './intro.component'

// How long the poster may wait for the intro chunk to paint before the landing
// is shown without it.
export const INTRO_PATIENCE = 5000

/**
 * Plays the landing intro when the head script in src/index.html asked for it
 * (`html[data-intro=poster]`: signed out on `/`, motion allowed). The scene is
 * a deferred chunk, so no other page or signed-in user downloads it.
 */
@Component({
  selector: 'app-intro-gate',
  standalone: true,
  imports: [IntroComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (playing()) {
      @defer (on immediate) {
        <app-intro (done)="end()" />
      }
    }
  `,
})
export class IntroGateComponent {
  private readonly doc = inject(DOCUMENT)
  private readonly host: HTMLElement = inject(ElementRef).nativeElement
  private hidden: Element[] = []

  readonly playing = signal(
    this.doc.documentElement.dataset['intro'] === 'poster',
  )

  constructor() {
    if (!this.playing()) return

    afterNextRender(() => {
      // Everything else in app-root sits under the intro; keep focus off it.
      const siblings = Array.from(this.host.parentElement?.children ?? [])
      this.hidden = siblings.filter(
        (el) => el !== this.host && !el.hasAttribute('inert'),
      )
      this.hidden.forEach((el) => el.setAttribute('inert', ''))
    })

    // Still on the poster after this long means the chunk failed or stalled.
    const timer = setTimeout(() => {
      if (this.doc.documentElement.dataset['intro'] === 'poster') this.end()
    }, INTRO_PATIENCE)
    inject(DestroyRef).onDestroy(() => clearTimeout(timer))
  }

  end(): void {
    if (!this.playing()) return
    // A keyboard user on Skip would be left focused on nothing once it unmounts.
    const refocus = this.host.contains(this.doc.activeElement)
    this.playing.set(false)
    delete this.doc.documentElement.dataset['intro']
    this.hidden.forEach((el) => el.removeAttribute('inert'))
    if (refocus) {
      this.doc
        .getElementById('main-content')
        ?.focus({ preventScroll: true })
    }
  }
}
