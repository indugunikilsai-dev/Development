import { Injectable } from '@angular/core';
import {Api} from '../../../core/api/api';
@Injectable({
  providedIn: 'root',
})
export class CadService {
  constructor(private api:Api){}
  getCads(){
    return this.api.GET('Cad');
  }
  getCadById(id:number){
    return this.api.GET(`Cad/${id}`);
  }
  createCad(data:any){
    return this.api.POST('Cad',data);
  }
  updateCad(id:number,data:any){
    return this.api.PUT(`Cad/${id}`,data);
  }
  deleteCad(id:number){
    return this.api.DELETE(`Cad/${id}`);
  }
}
