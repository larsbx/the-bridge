import { forward } from '#lib/server/backend.js';
export const GET = event => forward(event, '/healthz');
