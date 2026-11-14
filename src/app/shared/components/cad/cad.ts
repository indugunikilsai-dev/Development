import {
  Component,
  OnInit,
  ChangeDetectorRef,
  Inject,
  PLATFORM_ID,
  ChangeDetectionStrategy,
  inject
} from '@angular/core';

import {
  CommonModule,
  isPlatformBrowser
} from '@angular/common';

import {
  FormBuilder,
  FormGroup,
  ReactiveFormsModule
} from '@angular/forms';

import { Auth } from '../../../core/auth/auth';
import { CadService } from '../../../features/services/cad/cad-service';
import { Feedback } from '../../feedback/feedback';
import { AppValidators, FieldError } from '../../validation';

import { ConfirmService } from '../confirm-dialog/confirm';

@Component({
  selector: 'app-cad',
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  imports: [
    FieldError,
    CommonModule,
    ReactiveFormsModule
  ],
  templateUrl: './cad.html',
  styleUrls: ['./cad.css']
})
export class CadComponent implements OnInit {

  private confirmDialog = inject(ConfirmService);

  feedback = new Feedback();

  cads: any[] = [];

  cadForm!: FormGroup;

  isEditMode = false;

  selectedId = 0;

  loading = false;

  showModal = false;

  constructor(
    private fb: FormBuilder,
    private api: CadService,
    public auth: Auth,
    private cd: ChangeDetectorRef,
    @Inject(PLATFORM_ID) private platformId: Object
  ) {}

  ngOnInit(): void {

    this.cadForm = this.fb.group({
      name: ['', [AppValidators.required, AppValidators.title, AppValidators.minLength(2), AppValidators.maxLength(100)]],
      description: ['', [AppValidators.required, AppValidators.minLength(10), AppValidators.maxLength(1000)]]
    });

    if (!isPlatformBrowser(this.platformId)) return;

    this.loadCads();
  }

  //=============================
  // GET ALL
  //=============================

  loadCads(): void {

    this.loading = true;

    this.api.getCads().subscribe({

      next: (res: any) => {
        this.cd.markForCheck();

        this.loading = false;

        this.cads =
          res.data ??
          res.result ??
          res.items ??
          res;

        if (!Array.isArray(this.cads)) {
          this.cads = [];
        }

      },

      error: (err) => {
        this.feedback.fail(err, 'Unable to load CADs.');
        this.cd.markForCheck();

        this.loading = false;
      }

    });

  }

  //=============================
  // MODAL CONTROLS
  //=============================

  openAddModal(): void {

    if (!this.auth.hasPermission('CREATE_CAD')) {
      this.feedback.fail('You do not have permission to perform this action.');
      return;
    }

    this.resetForm();

    this.showModal = true;

  }

  closeModal(): void {

    this.showModal = false;

    this.resetForm();

  }

  //=============================
  // CREATE
  //=============================

  createCad(): void {

    if (!this.auth.hasPermission('CREATE_CAD')) {
      this.feedback.fail('You do not have permission to perform this action.');
      return;
    }

    if (this.cadForm.invalid) {
      this.cadForm.markAllAsTouched();
      return;
    }

    this.api.createCad(this.cadForm.value).subscribe({

      next: () => {
        this.cd.markForCheck();

        this.feedback.ok('CAD added successfully');

        this.resetForm();

        this.loadCads();

      },

      error: (err) => {
        this.cd.markForCheck();

        this.feedback.fail(err);
      }

    });

  }

  //=============================
  // EDIT
  //=============================

  editCad(cad: any): void {

    if (!this.auth.hasPermission('UPDATE_CAD')) {
      this.feedback.fail('You do not have permission to perform this action.');
      return;
    }

    this.isEditMode = true;

    this.selectedId = cad.id;

    this.cadForm.patchValue({
      name: cad.name,
      description: cad.description
    });

    this.showModal = true;

  }

  //=============================
  // UPDATE
  //=============================

  updateCad(): void {

    if (!this.auth.hasPermission('UPDATE_CAD')) {
      this.feedback.fail('You do not have permission to perform this action.');
      return;
    }

    if (this.cadForm.invalid) {
      this.cadForm.markAllAsTouched();
      return;
    }

    this.api.updateCad(
      this.selectedId,
      this.cadForm.value
    ).subscribe({

      next: () => {
        this.cd.markForCheck();

        this.feedback.ok('CAD updated successfully');

        this.resetForm();

        this.loadCads();

      },

      error: (err) => {
        this.cd.markForCheck();

        this.feedback.fail(err);
      }

    });

  }

  //=============================
  // DELETE
  //=============================

  async deleteCad(id: number): Promise<void> {

    if (!this.auth.hasPermission('DELETE_CAD')) {
      this.feedback.fail('You do not have permission to perform this action.');
      return;
    }

    if (!(await this.confirmDialog.ask('Delete this CAD?'))) return;

    this.api.deleteCad(id).subscribe({

      next: (res: any) => {
        this.cd.markForCheck();

        this.feedback.ok('CAD deleted successfully', res);

        this.loadCads();

      },

      error: (err) => {
        this.cd.markForCheck();

        this.feedback.fail(err);
      }

    });

  }

  //=============================
  // RESET
  //=============================

  resetForm(): void {

    this.isEditMode = false;

    this.selectedId = 0;

    this.showModal = false;

    this.cadForm.reset({
      name: '',
      description: ''
    });

  }

}
