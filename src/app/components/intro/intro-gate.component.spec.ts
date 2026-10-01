import { Component } from '@angular/core'
import {
  ComponentFixture,
  DeferBlockBehavior,
  DeferBlockState,
  TestBed,
  fakeAsync,
  tick,
} from '@angular/core/testing'

import { INTRO_PATIENCE, IntroGateComponent } from './intro-gate.component'
import { IntroScene, stage } from './stadium'

@Component({
  standalone: true,
  imports: [IntroGateComponent],
  template: `
    <main id="main-content" tabindex="-1">Landing</main>
    <app-intro-gate />
  `,
})
class HostComponent {}

describe('IntroGateComponent', () => {
  const html = document.documentElement

  // Manual, so a test decides when the scene's chunk "arrives".
  beforeEach(() => {
    TestBed.configureTestingModule({ deferBlockBehavior: DeferBlockBehavior.Manual })
    // The WebGL scene itself is out of scope here; a stand-in draws its frames.
    spyOn(stage, 'open').and.resolveTo(jasmine.createSpyObj<IntroScene>('scene', ['resize', 'render', 'dispose']))
  })
  afterEach(() => delete html.dataset['intro'])

  function create() {
    const fixture = TestBed.createComponent(HostComponent)
    fixture.detectChanges()
    return fixture
  }

  async function arrive(fixture: ComponentFixture<HostComponent>) {
    const [block] = await fixture.getDeferBlocks()
    await block.render(DeferBlockState.Complete)
    fixture.detectChanges()
    // The scene resolves, then draws its first frame.
    await Promise.resolve()
    for (let i = 0; i < 2; i++) await new Promise((r) => requestAnimationFrame(r))
  }

  it('stays out of the way when the head script did not ask for the intro', async () => {
    const fixture = create()

    expect(await fixture.getDeferBlocks()).toEqual([])
    expect(fixture.nativeElement.querySelector('main').hasAttribute('inert')).toBeFalse()
  })

  it('plays over the poster, then hands the page back on Skip', async () => {
    html.dataset['intro'] = 'poster'
    const fixture = create()
    await arrive(fixture)

    const main: HTMLElement = fixture.nativeElement.querySelector('main')
    expect(html.dataset['intro']).toBe('playing')
    expect(main.hasAttribute('inert')).toBeTrue()

    const skip: HTMLButtonElement = fixture.nativeElement.querySelector('app-intro button')
    skip.focus()
    skip.click()
    fixture.detectChanges()

    expect(fixture.nativeElement.querySelector('app-intro')).toBeNull()
    expect(html.dataset['intro']).toBeUndefined()
    expect(main.hasAttribute('inert')).toBeFalse()
    expect(document.activeElement).toBe(main)
  })

  it('gives up on an intro chunk that never paints', fakeAsync(() => {
    html.dataset['intro'] = 'poster'
    const fixture = create()

    tick(INTRO_PATIENCE)
    fixture.detectChanges()

    expect(html.dataset['intro']).toBeUndefined()
    expect(fixture.nativeElement.querySelector('main').hasAttribute('inert')).toBeFalse()
  }))

  it('lets a playing intro run past the patience window', async () => {
    jasmine.clock().install()
    try {
      html.dataset['intro'] = 'poster'
      const fixture = create()
      await arrive(fixture)

      jasmine.clock().tick(INTRO_PATIENCE)

      expect(html.dataset['intro']).toBe('playing')
      expect(fixture.nativeElement.querySelector('app-intro')).not.toBeNull()
      fixture.destroy()
    } finally {
      jasmine.clock().uninstall()
    }
  })
})
