import net from 'node:net'

/** Whether nothing listens on `127.0.0.1:port` (binding it succeeds). */
export function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.listen({ host: '127.0.0.1', port, exclusive: true }, () => srv.close(() => resolve(true)))
  })
}

/** A loopback port the system reports free right now. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const { port } = srv.address() as net.AddressInfo
      srv.close(() => resolve(port))
    })
  })
}
