// Settings for `npm run start:remote`: API calls go to /api, which proxy.remote.json forwards to the remote server.
export const environment = {
  defaultApiBase: '/api',
  // Keep every call on the proxy (the remote host does not allow localhost:4200 via CORS).
  singleInstance: true,
  // FuCad desktop stream started with fucad-stream/docker-compose.yml.
  fucadStreamUrl: 'http://localhost:3000/',
  // FreeCAD file service: File > Open / Save work with this PC (fucad-stream/bridge).
  fucadFilesUrl: 'http://localhost:3002/',
};
