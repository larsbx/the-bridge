import { forward } from '#lib/server/backend.js';
export const POST = event => forward(event, '/login');
