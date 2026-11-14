import { ChangeDetectorRef, Component, Inject, PLATFORM_ID, ChangeDetectionStrategy } from '@angular/core';
import { Student } from '../../../features/services/student/student';
import { Router } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { catchError, forkJoin, map, of } from 'rxjs';
import { CommonModule, isPlatformBrowser } from '@angular/common';
import { FormsModule, ReactiveFormsModule } from '@angular/forms';
import { Breadcrumb, BreadcrumbItem } from '../breadcrumb/breadcrumb';
import { Auth } from '../../../core/auth/auth';
import { Feedback } from '../../../shared/feedback/feedback';

@Component({
  selector: 'app-student-courses',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule,FormsModule,ReactiveFormsModule, Breadcrumb],
  templateUrl: './student-courses.html',
  styleUrl: './student-courses.css',
})
export class StudentCourses {

  feedback = new Feedback();
   courses: any[] = [];
  loading = false;
  // True only when the courses request failed, so an error is never mistaken for "no courses".
  loadFailed = false;
  domainId!: number ;
  domainName = '';
  // True when the student may open FuCad and a CAD is mapped to this domain.
  hasCad = false;

  get breadcrumb(): BreadcrumbItem[] {
    return [
      { label: 'My Domains', link: '/main/student-domain' },
      { label: this.domainName || 'My Courses' }
    ];
  }

  constructor(
    private api: Student,
    private cd: ChangeDetectorRef,
    private router:Router,
    public auth: Auth,
    @Inject(PLATFORM_ID) private platformId: object
  ) {}

  ngOnInit(): void {
    if (!isPlatformBrowser(this.platformId)) return;

    this.domainId = history.state?.domainId;
    this.domainName = history.state?.domainName ?? '';

    if (this.domainId == null) {
      this.router.navigate(['/main/student-domain']);
      return;
    }

    this.loadstudentcourse();
  }

  loadstudentcourse(): void {
  if (this.domainId == null) {
    return;
  }

  this.loading = true;
  this.loadFailed = false;

  // FuCad is offered only with VIEW_STUDENT_CADS and a CAD mapped to this domain.
  // A failed CAD lookup counts as "no CAD" and never hides the courses.
  const hasCad$ = this.auth.hasPermission('VIEW_STUDENT_CADS')
    ? this.api.getstudentcads(this.domainId).pipe(
        map((r: any) => Array.isArray(r?.data) && r.data.length > 0),
        catchError(() => of(false))
      )
    : of(false);

  forkJoin({ res: this.api.getstudentcourse(this.domainId), hasCad: hasCad$ }).subscribe({

    next: ({ res, hasCad }: { res: any; hasCad: boolean }) => {
      this.cd.markForCheck();

      this.hasCad = hasCad;
      const allCourses = res?.data ?? [];

      const hasDomainField = allCourses.some(
        (c: any) => c.domainId !== undefined && c.domainId !== null
      );

      this.courses = hasDomainField
        ? allCourses.filter((c: any) => c.domainId === this.domainId)
        : allCourses;

      this.loading = false;

      // A domain with no courses opens the FuCad design workspace instead of an empty list,
      // but only with VIEW_STUDENT_CADS and a CAD mapped to this domain; otherwise the empty list shows.
      if (this.courses.length === 0 && this.auth.hasPermission('VIEW_STUDENT_CADS')) {
        this.api.getstudentcads(this.domainId).subscribe({
          next: (cads: any) => {
            if (Array.isArray(cads?.data) && cads.data.length > 0) {
              this.router.navigate(['/main/freecad'], { replaceUrl: true });
            }
          },
          // No answer means no CAD: keep the empty course list.
          error: () => {}
        });
      }
    },

    error: (err: HttpErrorResponse) => {
      this.feedback.fail(err, 'Unable to load your courses.');
      this.loadFailed = true;
      this.cd.markForCheck();


      this.courses = [];
      this.loading = false;
    }

  });
}
  openContent(courseId: number, courseName?: string): void {
    this.router.navigate(['/main/student-content'], {
      state: { domainId: this.domainId, domainName: this.domainName, courseId, courseName }
    });
  }

  view(courseId: number, courseName?: string): void {
  this.router.navigate(['/main/student-assignments'], {
    state: { domainId: this.domainId, domainName: this.domainName, courseId, courseName }
  });
}
}
