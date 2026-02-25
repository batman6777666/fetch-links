import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
    plugins: [react()],
    // Cloudflare Pages compatibility
    build: {
        outDir: 'dist',
        assetsDir: 'assets',
    },
    // Ensure proper base path for deployment
    base: '/',
})
