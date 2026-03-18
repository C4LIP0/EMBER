import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    proxy: {
      '/tiles': 'http://localhost:8080',
      '/api': 'http://localhost:8080',
    }
  }
})
