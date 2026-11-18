import { evaluateRouterPolicy } from '../src/main/router/router-evaluation'

const result = evaluateRouterPolicy()
console.log(JSON.stringify(result, null, 2))
if (result.accuracy < 1) process.exitCode = 1
