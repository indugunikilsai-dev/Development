import { TestBed } from '@angular/core/testing';

import { DomaincadmapService } from './domaincadmap-service';
import { testProviders } from '../../../../testing/test-providers';

describe('DomaincadmapService', () => {
  let service: DomaincadmapService;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: testProviders() });
    service = TestBed.inject(DomaincadmapService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
