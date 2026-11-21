// The config the migrate tests run through `npm run migrate -w app`. Each test sets the folders and database.
import { buildEngineConfig } from '../../src/config'
import { catalog } from './catalog'

export default buildEngineConfig({
  catalog,
  configDir: process.env.WONDERROOM_CONFIG_DIR!,
  dataDir: process.env.WONDERROOM_DATA_DIR!,
  databaseUrl: process.env.DATABASE_URL!,
  secret: 'test-secret',
})
