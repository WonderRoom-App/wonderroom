import path from 'path'
import { fileURLToPath } from 'url'
import { buildEngineConfig } from '@wonderroom/core'

import { catalog } from './catalog'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const appDir = path.resolve(dirname, '..')

export default buildEngineConfig({
  catalog,
  configDir: path.resolve(appDir, process.env.WONDERROOM_CONFIG_DIR || '../config'),
  dataDir: path.resolve(appDir, process.env.WONDERROOM_DATA_DIR || '../data'),
  databaseUrl: process.env.DATABASE_URL || '',
  secret: process.env.PAYLOAD_SECRET || '',
  importMapBaseDir: dirname,
  typesOutputFile: path.resolve(dirname, 'payload-types.ts'),
})
