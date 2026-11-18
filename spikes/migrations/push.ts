// Approach C: push the schema at start. Throwaway. WR_PLUGINS picks the plugins.
import { getPayload } from 'payload'
import config from './payload.config.ts'
await getPayload({ config })
console.log('started')
process.exit(0)
