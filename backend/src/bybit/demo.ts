// Single shared Bybit DEMO client (keys from backend .env only).
import { requireEnv } from '../env.js'
import { BybitDemoClient } from './client.js'

export const bybit = new BybitDemoClient(requireEnv('BYBIT_DEMO_API_KEY'), requireEnv('BYBIT_DEMO_API_SECRET'))
