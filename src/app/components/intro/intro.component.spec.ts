import { ComponentFixture, TestBed } from '@angular/core/testing'

import { INTRO_LENGTH, IntroComponent } from './intro.component'
import { IntroScene, stage } from './stadium'

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

describe('IntroComponent', () => {
  let fixture: ComponentFixture<IntroComponent>
  let done: number
  let scene: jasmine.SpyObj<IntroScene>
  const html = document.documentElement

  function create() {
    fixture = TestBed.createComponent(IntroComponent)
    done = 0
    fixture.componentInstance.done.subscribe(() => done++)
    fixture.detectChanges()
  }

  // The scene's promise settles, then its first frame draws.
  async function settle() {
    await Promise.resolve()
    await frame()
    await frame()
  }

  beforeEach(() => {
    scene = jasmine.createSpyObj<IntroScene>('scene', ['resize', 'render', 'dispose'])
  })

  afterEach(() => {
    fixture.destroy()
    delete html.dataset['intro']
  })

  it('takes over from the poster once the scene has drawn a frame', async () => {
    html.dataset['intro'] = 'poster'
    spyOn(stage, 'open').and.resolveTo(scene)
    create()
    expect(html.dataset['intro']).toBe('poster')

    await settle()

    expect(scene.render).toHaveBeenCalled()
    expect(scene.render.calls.first().args[0]).toBe(0)
    expect(html.dataset['intro']).toBe('playing')
  })

  it('goes straight to the landing without WebGL 2', async () => {
    spyOn(stage, 'open').and.resolveTo(null)
    create()
    await settle()
    expect(done).toBe(1)
  })

  it('goes straight to the landing when the scene fails to load', async () => {
    spyOn(stage, 'open').and.rejectWith(new Error('logo 404'))
    create()
    await settle()
    expect(done).toBe(1)
  })

  it('ends when Skip is pressed', () => {
    spyOn(stage, 'open').and.resolveTo(scene)
    create()
    const skip: HTMLButtonElement = fixture.nativeElement.querySelector('button')
    expect(skip.textContent?.trim()).toBe('Skip')
    expect(skip.getAttribute('aria-label')).toBe('Skip intro')

    skip.click()

    expect(done).toBe(1)
  })

  it('ends on Escape', () => {
    spyOn(stage, 'open').and.resolveTo(scene)
    create()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(done).toBe(1)
  })

  it('ends on its own once the scene has played, timed from its first frame', async () => {
    jasmine.clock().install()
    try {
      spyOn(stage, 'open').and.resolveTo(scene)
      create()
      await settle()

      jasmine.clock().tick(INTRO_LENGTH - 1)
      expect(done).toBe(0)
      jasmine.clock().tick(1)
      expect(done).toBe(1)
    } finally {
      jasmine.clock().uninstall()
    }
  })

  it('releases the scene when it unmounts', async () => {
    spyOn(stage, 'open').and.resolveTo(scene)
    create()
    await settle()

    fixture.destroy()

    expect(scene.dispose).toHaveBeenCalled()
  })
})
