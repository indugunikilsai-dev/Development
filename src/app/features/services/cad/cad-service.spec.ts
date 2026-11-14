import { TestBed } from '@angular/core/testing';

import { CadService } from './cad-service';
import { testProviders } from '../../../../testing/test-providers';

describe('CadService', () => {
  let service: CadService;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: testProviders() });
    service = TestBed.inject(CadService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
