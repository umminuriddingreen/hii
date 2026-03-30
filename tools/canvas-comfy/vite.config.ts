import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3333,
    proxy: {
      '/comfy': {
        target: 'http://127.0.0.1:8188',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/comfy/, ''),
        ws: true,
      },
    },
  },
})
