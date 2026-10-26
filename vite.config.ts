import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `base: './'` keeps every asset URL relative, so the build works on any GitHub Pages
// project path (https://<user>.github.io/<repo>/) without knowing the repo name.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
});
