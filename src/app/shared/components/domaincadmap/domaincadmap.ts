import {
  Component,
  OnInit,
  Inject,
  PLATFORM_ID,
  ChangeDetectorRef, ChangeDetectionStrategy
, inject } from '@angular/core';

import {
  CommonModule,
  isPlatformBrowser
} from '@angular/common';

import {
  FormBuilder,
  FormGroup,
  ReactiveFormsModule,
  FormsModule
} from '@angular/forms';

import { Router, RouterLink } from '@angular/router';

import { Auth } from '../../../core/auth/auth';
import { DomaincadmapService } from '../../../features/services/domaincadmap/domaincadmap-service';
import { DomainServices } from '../../../features/services/domain/domain-services';
import { CadService } from '../../../features/services/cad/cad-service';
import { Feedback } from '../../feedback/feedback';
import { AppValidators, FieldError } from '../../validation';

import { ConfirmService } from '../confirm-dialog/confirm';
import { toList } from '../../models/api-response.model';
@Component({
  selector: 'app-domaincadmap',
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  imports: [
    FieldError,
    CommonModule,
    ReactiveFormsModule,
    FormsModule,
    RouterLink
  ],
  templateUrl: './domaincadmap.html',
  styleUrls: ['./domaincadmap.css']
})
export class DomainCadMapComponent implements OnInit {

  private confirmDialog = inject(ConfirmService);


  feedback = new Feedback();

  domainCadForm!: FormGroup;

  mappings: any[] = [];
  filteredMappings: any[] = [];

  domains: any[] = [];

  cads: any[] = [];

  submitted = false;
  editMode = false;
  showModal = false;

  selectedId: number | null = null;

  loading = false;

  searchText = '';

  constructor(
    private fb: FormBuilder,
    private api: DomaincadmapService,
    private domainService: DomainServices,
    private cadService: CadService,
    private router: Router,
    public auth: Auth,
    private cd: ChangeDetectorRef,
    @Inject(PLATFORM_ID) private platformId: Object
  ) {}

  ngOnInit(): void {

    this.buildForm();

    if (!isPlatformBrowser(this.platformId)) return;

    this.loadDomains();

    this.loadCads();

    this.loadMappings();

  }

  buildForm(): void {

    this.domainCadForm = this.fb.group({

      domainName: ['', [AppValidators.required]],

      cadName: ['', [AppValidators.required]],

      yearNumber: [1, [AppValidators.required, AppValidators.integer, AppValidators.min(1), AppValidators.max(10)]],

      semester: [1, [AppValidators.required, AppValidators.integer, AppValidators.min(1), AppValidators.max(2)]]

    });

  }

  //==========================
  // MODAL
  //==========================

  openAddModal(): void {
    this.resetForm();
    this.showModal = true;
  }

  closeModal(): void {
    this.showModal = false;
    this.resetForm();
  }

  //========================
  // Load Domains
  //========================

  loadDomains() {

    this.domainService.getDomains().subscribe({

      next: (res: any) => {
        this.cd.markForCheck();


        this.domains = toList(res);

      }

    });

  }

  //========================
  // Load CADs
  //========================

  loadCads() {

    this.cadService.getCads().subscribe({

      next: (res: any) => {
        this.cd.markForCheck();


        this.cads = toList(res);

      }

    });

  }

  //========================
  // Load Mapping
  //========================

  loadMappings() {

    this.loading = true;

    this.api.getDomaincadmaps().subscribe({

      next: (res: any) => {
        this.cd.markForCheck();


        this.loading = false;

        this.mappings = toList(res);

        if (!Array.isArray(this.mappings)) {

          this.mappings = [];

        }

        this.filteredMappings = [...this.mappings];

      },

      error: err => {
        this.feedback.fail(err, 'Unable to load domain-CAD mappings.');
        this.cd.markForCheck();


        this.loading = false;


      }

    });

  }

  //==========================
  // SAVE
  //==========================

  save(): void {

    this.submitted = true;

    if (this.editMode) {

      if (!this.auth.hasPermission('UPDATE_DOMAIN_CAD_MAP')) return;

    } else {

      if (!this.auth.hasPermission('CREATE_DOMAIN_CAD_MAP')) return;

    }

    if (this.domainCadForm.invalid) {

      this.domainCadForm.markAllAsTouched();

      return;

    }

    const payload = this.domainCadForm.value;

    if (this.editMode) {

      if (this.selectedId == null) return;

      this.api.updateDomaincadmap(this.selectedId, payload).subscribe({

        next: () => {
          this.cd.markForCheck();


          this.loadMappings();

          this.closeModal();
          this.feedback.ok('Mapping updated successfully');

        },

        error: err => {
        this.cd.markForCheck();

        this.feedback.fail(err);
      }

      });

    } else {

      this.api.createDomaincadmap(payload).subscribe({

        next: () => {
          this.cd.markForCheck();


          this.loadMappings();

          this.closeModal();
          this.feedback.ok('Mapping added successfully');

        },

        error: err => {
        this.cd.markForCheck();

        this.feedback.fail(err);
      }

      });

    }

  }

  //========================
  // EDIT
  //========================

  edit(item: any) {

    if (!this.auth.hasPermission('UPDATE_DOMAIN_CAD_MAP')) return;

    this.editMode = true;

    this.selectedId = item.id;

    this.domainCadForm.patchValue({

      domainName: item.domainName,

      cadName: item.cadName,

      yearNumber: item.yearNumber,

      semester: item.semester

    });

    this.showModal = true;

  }

  //========================
  // DELETE
  //========================

  async delete(id: number): Promise<void> {

    if (!this.auth.hasPermission('DELETE_DOMAIN_CAD_MAP')) return;

    if (!(await this.confirmDialog.ask('Delete this mapping?'))) return;

    this.api.deleteDomaincadmap(id).subscribe({

      next: (res: any) => {
        this.cd.markForCheck();


        this.loadMappings();
        this.feedback.ok('Mapping deleted successfully', res);

      },

      error: err => {
        this.cd.markForCheck();

        this.feedback.fail(err);
      }

    });

  }

  //========================
  // RESET
  //========================

  resetForm() {

    this.submitted = false;

    this.editMode = false;

    this.selectedId = null;

    this.domainCadForm.reset({

      domainName: '',

      cadName: '',

      yearNumber: 1,

      semester: 1

    });

  }

  //==========================
  // SEARCH
  //==========================

  search(): void {

    const value = this.searchText.toLowerCase();

    this.filteredMappings = this.mappings.filter(x =>

      x.domainName.toLowerCase().includes(value) ||

      x.cadName.toLowerCase().includes(value)

    );

  }

}
