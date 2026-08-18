import { defineConfig } from 'tsdown'

// Host-only plugin: a plain ESM library the cordis Loader imports. No browser
// half, so none of the client-bundle contract applies here.
export default defineConfig({
  name: 'dsh-plugin-discord/host',
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  sourcemap: true,
})
