import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fixture } from './fixture/plugin'

const apiTarget = process.env.VITE_API_TARGET ?? 'http://localhost:8000'
const useFixture = process.env.VITE_FIXTURE === '1'

export default defineConfig({
  plugins: [react(), ...(useFixture ? [fixture()] : [])],
  server: {
    port: 5180,
    strictPort: true,
    proxy: useFixture ? undefined : { '/api': apiTarget },
  },
})
