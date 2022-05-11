import { logger } from '@libp2p/logger'
import drain from 'it-drain'
import PQueue from 'p-queue'
import defer from 'p-defer'
import { peerIdFromString } from '@libp2p/peer-id'
import { Multiaddr } from '@multiformats/multiaddr'
import errCode from 'err-code'
import anySignal from 'any-signal'
import type { IPFSHTTPClient, CID } from 'ipfs-http-client'
import type { HTTPClientExtraOptions } from 'ipfs-http-client/types/src/types'
import type { AbortOptions } from 'ipfs-core-types/src/utils'
import type { ContentRouting } from '@libp2p/interfaces/content-routing'
import type { PeerInfo } from '@libp2p/interfaces/peer-info'
import type { Startable } from '@libp2p/interfaces/startable'

const log = logger('libp2p:delegated-content-routing')

const DEFAULT_TIMEOUT = 30e3 // 30 second default
const CONCURRENT_HTTP_REQUESTS = 4
const CONCURRENT_HTTP_REFS_REQUESTS = 2

/**
 * An implementation of content routing, using a delegated peer
 */
export class DelegatedContentRouting implements ContentRouting, Startable {
  private readonly client: IPFSHTTPClient
  private readonly httpQueue: PQueue
  private readonly httpQueueRefs: PQueue
  private started: boolean
  private abortController: AbortController

  /**
   * Create a new DelegatedContentRouting instance
   */
  constructor (client: IPFSHTTPClient) {
    if (client == null) {
      throw new Error('missing ipfs http client')
    }

    this.client = client
    this.started = false

    // limit concurrency to avoid request flood in web browser
    // https://github.com/libp2p/js-libp2p-delegated-content-routing/issues/12
    this.httpQueue = new PQueue({
      concurrency: CONCURRENT_HTTP_REQUESTS
    })
    // sometimes refs requests take long time, they need separate queue
    // to not suffocate regular business
    this.httpQueueRefs = new PQueue({
      concurrency: CONCURRENT_HTTP_REFS_REQUESTS
    })

    const {
      protocol,
      host,
      port
    } = client.getEndpointConfig()

    log(`enabled DelegatedContentRouting via ${protocol}://${host}:${port}`)

    this.abortController = new AbortController()
  }

  isStarted () {
    return this.started
  }

  start () {
    this.started = true
  }

  stop () {
    this.httpQueue.clear()
    this.httpQueueRefs.clear()
    this.abortController.abort()
    this.abortController = new AbortController()
    this.started = false
  }

  /**
   * Search the dht for providers of the given CID.
   *
   * - call `findProviders` on the delegated node.
   */
  async * findProviders (key: CID, options: HTTPClientExtraOptions & AbortOptions = {}) {
    log('findProviders starts: %c', key)
    options.timeout = options.timeout ?? DEFAULT_TIMEOUT
    options.signal = anySignal([this.abortController.signal].concat((options.signal != null) ? [options.signal] : []))

    const onStart = defer()
    const onFinish = defer()

    void this.httpQueue.add(async () => {
      onStart.resolve()
      return await onFinish.promise
    })

    try {
      await onStart.promise

      for await (const event of this.client.dht.findProvs(key, options)) {
        if (event.name === 'PROVIDER') {
          yield * event.providers.map(prov => {
            const peerInfo: PeerInfo = {
              id: peerIdFromString(prov.id),
              protocols: [],
              multiaddrs: prov.multiaddrs.map(m => new Multiaddr(m.toString()))
            }

            return peerInfo
          })
        }
      }
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
  async provide (key: CID, options: HTTPClientExtraOptions & AbortOptions = {}) {
    log('provide starts: %c', key)
    options.timeout = options.timeout ?? DEFAULT_TIMEOUT
    options.signal = anySignal([this.abortController.signal].concat((options.signal != null) ? [options.signal] : []))

    await this.httpQueueRefs.add(async () => {
      await this.client.block.stat(key, options)
      await drain(this.client.dht.provide(key, options))
    })
    log('provide finished: %c', key)
  }

  /**
   * Stores a value in the backing key/value store of the delegated content router.
   * This may fail if the delegated node's content routing implementation does not
   * use a key/value store, or if the delegated operation fails.
   */
  async put (key: Uint8Array, value: Uint8Array, options: HTTPClientExtraOptions & AbortOptions = {}) {
    log('put value start: %b', key)
    options.timeout = options.timeout ?? DEFAULT_TIMEOUT
    options.signal = anySignal([this.abortController.signal].concat((options.signal != null) ? [options.signal] : []))

    await this.httpQueue.add(async () => {
      await drain(this.client.dht.put(key, value, options))
    })

    log('put value finished: %b', key)
  }

  /**
   * Fetches an value from the backing key/value store of the delegated content router.
   * This may fail if the delegated node's content routing implementation does not
   * use a key/value store, or if the delegated operation fails.
   */
  async get (key: Uint8Array, options: HTTPClientExtraOptions & AbortOptions = {}) {
    log('get value start: %b', key)
    options.timeout = options.timeout ?? DEFAULT_TIMEOUT
    options.signal = anySignal([this.abortController.signal].concat((options.signal != null) ? [options.signal] : []))

    return await this.httpQueue.add(async () => {
      for await (const event of this.client.dht.get(key, options)) {
        if (event.name === 'VALUE') {
          log('get value finished: %b', key)
          return event.value
        }
      }

      throw errCode(new Error('Not found'), 'ERR_NOT_FOUND')
    })
  }
}
