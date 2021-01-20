'use strict'

const debug = require('debug')
const PeerId = require('peer-id')

const { default: PQueue } = require('p-queue')
const all = require('it-all')
const defer = require('p-defer')

const log = debug('libp2p-delegated-content-routing')
log.error = debug('libp2p-delegated-content-routing:error')

const DEFAULT_TIMEOUT = 30e3 // 30 second default
const CONCURRENT_HTTP_REQUESTS = 4

/**
 * An implementation of content routing, using a delegated peer.
 */
class DelegatedContentRouting {
  /**
   * Create a new DelegatedContentRouting instance.
   *
   * @param {PeerID} peerId - the id of the node that is using this routing.
   * @param {object} client - an instance of the ipfs-http-client module
   */
  constructor (peerId, client) {
    if (peerId == null) {
      throw new Error('missing self peerId')
    }

    if (client == null) {
      throw new Error('missing ipfs http client')
    }

    this._client = client
    this.peerId = peerId

    // limit concurrency to avoid request flood in web browser
    // https://github.com/libp2p/js-libp2p-delegated-content-routing/issues/12
    const concurrency = { concurrency: CONCURRENT_HTTP_REQUESTS }
    this._httpQueue = new PQueue(concurrency)
    // sometimes refs requests take long time, they need separate queue
    // to not suffocate regular bussiness
    this._httpQueueRefs = new PQueue(Object.assign({}, concurrency, {
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
   *
   * @param {CID} key
   * @param {object} options
   * @param {number} options.timeout - How long the query can take. Defaults to 30 seconds
   * @param {number} options.numProviders - How many providers to find, defaults to 20
   * @returns {AsyncIterable<{ id: PeerId, multiaddrs: Multiaddr[] }>}
   */
  async * findProviders (key, options = {}) {
    log(`findProviders starts: ${key}`)
    options.timeout = options.timeout || DEFAULT_TIMEOUT

    let providers = 0
    const onStart = defer()
    const onFinish = defer()

    this._httpQueue.add(() => {
      onStart.resolve()
      return onFinish.promise
    })

    try {
      await onStart.promise

      for await (const { id, addrs } of this._client.dht.findProvs(key, {
        numProviders: options.numProviders,
        timeout: options.timeout
      })) {
        yield {
          id: PeerId.createFromCID(id),
          multiaddrs: addrs
        }
        providers++
      }
    } catch (err) {
      log.error('findProviders errored:', err)
      throw err
    } finally {
      onFinish.resolve()
      log(`findProviders finished: ${key} found ${providers} providers`)
    }
  }

  /**
   * Announce to the network that the delegated node can provide the given key.
   *
   * Currently this uses the following hack
   * - delegate is one of bootstrap nodes, so we are always connected to it
   * - call block stat on the delegated node, so it fetches the content
   * - the delegate runs a re-provide on every block in the block store so
   *   eventually the block will be published to the DHT
   *
   * N.B. this must be called for every block in the dag you want provided otherwise
   * the delegate will only be able to supply the root block of the dag when asked
   * for the data by an interested peer.
   *
   * @param {CID} key
   * @returns {Promise<void>}
   */
  async provide (key) {
    log(`provide starts: ${key}`)
    const results = await this._httpQueueRefs.add(() => this._client.block.stat(key))
    log(`provide finished: ${key}`, results)
  }
}

module.exports = DelegatedContentRouting
