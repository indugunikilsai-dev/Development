// Production settings. `ng build` uses this file; `ng serve` swaps in environment.development.ts.
export const environment = {
  // Registry / default instance: the college list and the per-college host lookup before login.
  defaultApiBase: 'https://college-a.178-104-255-148.sslip.io/api',
  // Each college has its own instance: after picking one, look up its host (Deployment/resolve).
  singleInstance: false,
  // FuCad desktop stream for the FreeCAD page (fucad-stream/). Empty until it is deployed over HTTPS.
  fucadStreamUrl: '',
  // FreeCAD file service (File > Open / Save on this PC). Empty until it is deployed over HTTPS.
  fucadFilesUrl: '',
};
