import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const processEnv = (
  globalThis as {
    process?: {
      env?: Record<string, string | undefined>
    }
  }
).process?.env

const repositoryName = processEnv?.GITHUB_REPOSITORY?.split('/')[1]
const base =
  processEnv?.GITHUB_ACTIONS === 'true' && repositoryName
    ? `/${repositoryName}/`
    : '/'

export default defineConfig({
  base,
  plugins: [react()],
})
