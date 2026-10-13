import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { reserveEphemeralPort, waitForHttpReady } from './portUtils'

describe('http port helpers', () => {
  const cleanup: Array<() => Promise<void>> = []

  afterEach(async () => {
    while (cleanup.length > 0) {
      await cleanup.pop()?.()
    }
  })

  it('reserves a bindable ephemeral port', async () => {
    const port = await reserveEphemeralPort()
    expect(port).toBeGreaterThan(0)

    const server = createServer((_request, response) => {
      response.statusCode = 200
      response.end('ok')
    })

    cleanup.push(async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error)
          else resolve()
        })
      })
    })

    await new Promise<void>((resolve, reject) => {
      server.listen(port, '127.0.0.1', (error?: Error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  })

  it('waits for a local http endpoint to become ready', async () => {
    const port = await reserveEphemeralPort()
    const server = createServer((_request, response) => {
      response.statusCode = 404
      response.end()
    })

    cleanup.push(async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error)
          else resolve()
        })
      })
    })

    setTimeout(() => {
      server.listen(port, '127.0.0.1')
    }, 50)

    await expect(waitForHttpReady(port, { timeoutMs: 2_000 })).resolves.toBe(true)
  })
})
