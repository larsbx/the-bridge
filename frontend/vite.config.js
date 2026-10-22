import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
export default defineConfig({ plugins: [sveltekit({ adapter: adapter(), paths: { origin: process.env.PUBLIC_URL || 'http://localhost:3000' } })] });
