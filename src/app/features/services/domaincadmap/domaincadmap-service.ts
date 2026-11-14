import { Injectable } from '@angular/core';
import {Api} from '../../../core/api/api';
@Injectable({
  providedIn: 'root',
})
export class DomaincadmapService {
  constructor(private api:Api){}
  getDomaincadmaps(){
    return this.api.GET('DomainCadMap');
  }
  getDomaincadmapById(id:number){
    return this.api.GET(`DomainCadMap/${id}`);
  }
  createDomaincadmap(data:any){
    return this.api.POST('DomainCadMap',data);
  }
  updateDomaincadmap(id:number,data:any){
    return this.api.PUT(`DomainCadMap/${id}`,data);
  }
  deleteDomaincadmap(id:number){
    return this.api.DELETE(`DomainCadMap/${id}`);
  }
}
