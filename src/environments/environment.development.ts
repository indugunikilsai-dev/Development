// Settings for `ng serve` (the development configuration): a locally running API.
export const environment = {
  defaultApiBase: 'http://localhost:5000/api',
  // The local API serves every college, so skip the per-college host lookup.
  singleInstance: true,
  // FuCad desktop stream started with fucad-stream/docker-compose.yml.
  fucadStreamUrl: 'http://localhost:3000/',
};
