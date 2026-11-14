import { inject, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { CanActivateFn, Router } from '@angular/router';
import { map } from 'rxjs';
import { Student } from '../../features/services/student/student';

// FuCad opens only when a CAD is mapped to one of the student's domains.
// (The VIEW_STUDENT_CADS permission itself is checked by permissionGuard.)
export const studentCadGuard: CanActivateFn = () => {

  if (!isPlatformBrowser(inject(PLATFORM_ID))) {
    return true;
  }

  const router = inject(Router);

  return inject(Student).hasMappedCad().pipe(
    map(hasCad => hasCad || router.createUrlTree(['/main']))
  );

};
