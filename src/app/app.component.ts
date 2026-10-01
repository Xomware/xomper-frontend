import { Component, OnDestroy } from '@angular/core'
import { NavigationEnd, Router } from '@angular/router'
import { Subscription, filter } from 'rxjs'
import { LeagueService } from './services/league.service'
import { UserService } from './services/user.service'
import { TeamService } from './services/team.service'
import { PlayerService } from './services/player.service'
import { SpaceBackdropComponent } from './components/space-backdrop/space-backdrop.component'
import { ToolbarComponent } from './components/toolbar/toolbar.component'
import { ToastComponent } from './components/toast/toast.component'
import { RouterOutlet } from '@angular/router'
import { NgIf } from '@angular/common'
import { FooterComponent } from './components/footer/footer.component'
import { XomperNewShellDirective } from './directives/xomper-new-shell.directive'
import { ShellLayoutComponent } from './components/shell-layout/shell-layout.component'
import { IntroGateComponent } from './components/intro/intro-gate.component'

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss'],
  standalone: true,
  imports: [
    SpaceBackdropComponent,
    ToolbarComponent,
    ToastComponent,
    RouterOutlet,
    NgIf,
    FooterComponent,
    XomperNewShellDirective,
    ShellLayoutComponent,
    IntroGateComponent,
  ],
})
export class AppComponent implements OnDestroy {
  title = 'Xomper'

  /**
   * The public landing page renders without app chrome.
   *
   * It used to inherit the sidebar, toolbar and footer, which put signed-in
   * furniture in front of visitors who have never signed in and left the page
   * looking like a broken dashboard rather than a front door.
   */
  isPublicLanding = false

  private routerSub?: Subscription

  constructor(
    private leagueService: LeagueService,
    private userService: UserService,
    private teamService: TeamService,
    private playerService: PlayerService,
    private router: Router,
  ) {
    this.isPublicLanding = this.landingFor(this.router.url)
    this.routerSub = this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe((e) => {
        this.isPublicLanding = this.landingFor(e.urlAfterRedirects)
      })
  }

  /** Only the root path is chrome-free; everything else keeps the shell. */
  private landingFor(url: string): boolean {
    const path = (url || '/').split('?')[0].split('#')[0]
    return path === '/' || path === ''
  }

  ngOnDestroy(): void {
    this.routerSub?.unsubscribe()
    this.leagueService.reset()
    this.userService.reset()
    this.teamService.reset()
    this.playerService.reset()
  }
}
