import { ComponentFixture, TestBed, fakeAsync, tick } from '@angular/core/testing'

import { INTRO_LENGTH, IntroComponent } from './intro.component'

describe('IntroComponent', () => {
  let fixture: ComponentFixture<IntroComponent>
  let done: number
  const html = document.documentElement

  beforeEach(() => {
    fixture = TestBed.createComponent(IntroComponent)
    done = 0
    fixture.componentInstance.done.subscribe(() => done++)
    fixture.detectChanges()
  })

  afterEach(() => {
    fixture.destroy()
    delete html.dataset['intro']
  })

  it('takes over from the poster once it has rendered', () => {
    expect(html.dataset['intro']).toBe('playing')
  })

  it('ends when Skip is pressed', () => {
    const skip: HTMLButtonElement = fixture.nativeElement.querySelector('button')
    expect(skip.textContent?.trim()).toBe('Skip')
    expect(skip.getAttribute('aria-label')).toBe('Skip intro')

    skip.click()

    expect(done).toBe(1)
  })

  it('ends on its own after the scene has played', fakeAsync(() => {
    fixture.destroy()
    fixture = TestBed.createComponent(IntroComponent)
    fixture.componentInstance.done.subscribe(() => done++)
    fixture.detectChanges()

    tick(INTRO_LENGTH - 1)
    expect(done).toBe(0)
    tick(1)
    expect(done).toBe(1)
  }))

  it('draws the scoreboard and the play', () => {
    const el: HTMLElement = fixture.nativeElement
    expect(el.querySelectorAll('.slat').length).toBe(6)
    expect(el.querySelectorAll('.mark--o').length).toBe(8)
    expect(el.querySelectorAll('.mark--x').length).toBe(7)
    expect(el.querySelector('.digits--new')?.textContent).toBe('23')
  })
})
