import { logger } from '@libp2p/logger'
import drain from 'it-drain'
import PQueue from 'p-queue'
import defer from 'p-defer'
import type { IPFSHTTPClient, CID } from 'ipfs-http-client'
import type { HTTPClientExtraOptions } from 'ipfs-http-client/types/src/types'
import type { AbortOptions } from 'ipfs-core-types/src/utils'

const log = logger('libp2p-delegated-content-routing')

const DEFAULT_TIMEOUT = 30e3 // 30 second default
const CONCURRENT_HTTP_REQUESTS = 4

/**
 * An implementation of content routing, using a delegated peer
 */
export class DelegatedContentRouting {
  private readonly client: IPFSHTTPClient
  private readonly httpQueue: PQueue
  private readonly httpQueueRefs: PQueue

  /**
   * Create a new DelegatedContentRouting instance
   */
  constructor (client: IPFSHTTPClient) {
    if (client == null) {
      throw new Error('missing ipfs http client')
    }

    this.client = client

    // limit concurrency to avoid request flood in web browser
    // https://github.com/libp2p/js-libp2p-delegated-content-routing/issues/12
    const concurrency = { concurrency: CONCURRENT_HTTP_REQUESTS }
    this.httpQueue = new PQueue(concurrency)
    // sometimes refs requests take long time, they need separate queue
    // to not suffocate regular business
    this.httpQueueRefs = new PQueue(Object.assign({}, concurrency, {
      concurrency: 2
    }))

    const {
      protocol,
      host,
      port
    } = client.getEndpointConfig()

    log(`enabled DelegatedContentRouting via ${protocol}://${host}:${port}`)
  }

  /**
   * Search the dht for providers of the given CID.
   *
   * - call `findProviders` on the delegated node.
   */
  async * findProviders (key: CID, options: HTTPClientExtraOptions & AbortOptions = {}) {
    log('findProviders starts: %c', key)
    options.timeout = options.timeout ?? DEFAULT_TIMEOUT

    const onStart = defer()
    const onFinish = defer()

    void this.httpQueue.add(async () => {
      onStart.resolve()
      return await onFinish.promise
    })

    try {
      await onStart.promise

      yield * this.client.dht.findProvs(key, {
        timeout: options.timeout
      })
    } catch (err) {
      log.error('findProviders errored:', err)
      throw err
    } finally {
      onFinish.resolve()
      log('findProviders finished: %c', key)
    }
  }

  /**
   * Announce to the network that the delegated node can provide the given key.
   *
   * Currently this uses the following hack
   * - delegate is one of bootstrap nodes, so we are always connected to it
   * - call block stat on the delegated node, so it fetches the content
   * - call dht provide with the passed cid
   *
   * N.B. this must be called for every block in the dag you want provided otherwise
   * the delegate will only be able to supply the root block of the dag when asked
   * for the data by an interested peer.
   */
  async provide (key: CID) {
    log('provide starts: %c', key)
    await this.httpQueueRefs.add(async () => {
      await this.client.block.stat(key)
      await drain(this.client.dht.provide(key))
    })
    log('provide finished: %c', key)
  }
}
