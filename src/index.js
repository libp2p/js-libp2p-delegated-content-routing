'use strict'

const debug = require('debug')
const PeerId = require('peer-id')
const PeerInfo = require('peer-info')
const createFindProvs = require('ipfs-http-client/src/dht/find-provs')
const createRefs = require('ipfs-http-client/src/refs')

const { default: PQueue } = require('p-queue')
const all = require('it-all')
const defer = require('p-defer')

const log = debug('libp2p-delegated-content-routing')
log.error = debug('libp2p-delegated-content-routing:error')

const DEFAULT_TIMEOUT = 30e3 // 30 second default
const DEFAULT_IPFS_API = {
  protocol: 'https',
  port: 443,
  host: 'node0.delegate.ipfs.io'
}

const CONCURRENT_HTTP_REQUESTS = 4

/**
 * An implementation of content routing, using a delegated peer.
 */
class DelegatedContentRouting {
  /**
   * Create a new DelegatedContentRouting instance.
   *
   * @param {PeerID} peerId - the id of the node that is using this routing.
   * @param {object} [api] - (Optional) the api endpoint of the delegated node to use.
   */
  constructor (peerId, api) {
    if (peerId == null) {
      throw new Error('missing self peerId')
    }

    this.api = Object.assign({}, DEFAULT_IPFS_API, api)
    this.dht = { findProvs: createFindProvs(this.api) }
    this.refs = createRefs(this.api)
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
    log(`enabled DelegatedContentRouting via ${this.api.protocol}://${this.api.host}:${this.api.port}`)
  }

  /**
   * Search the dht for providers of the given CID.
   *
   * - call `findProviders` on the delegated node.
   *
   * @param {CID} key
   * @param {object} options
   * @param {number} options.timeout How long the query can take. Defaults to 30 seconds
   * @returns {AsyncIterable<PeerInfo>}
   */
  async * findProviders (key, options = {}) {
    const keyString = `${key}`
    log('findProviders starts:', keyString)
    options.timeout = options.timeout || DEFAULT_TIMEOUT

    const onStart = defer()
    const onFinish = defer()

    this._httpQueue.add(() => {
      onStart.resolve()
      return onFinish.promise
    })

    try {
      await onStart.promise

      const providers = this.dht.findProvs(key, {
        numProviders: options.numProviders,
        timeout: `${options.timeout}ms` // The api requires specification of the time unit (s/ms)
      })

      for await (const { id, addrs } of providers) {
        const peerInfo = new PeerInfo(PeerId.createFromCID(id))
        addrs.forEach(addr => peerInfo.multiaddrs.add(addr))
        yield peerInfo
      }
    } finally {
      onFinish.resolve()
      log('findProviders finished:', keyString)
    }
  }

  /**
   * Announce to the network that the delegated node can provide the given key.
   *
   * Currently this uses the following hack
   * - delegate is one of bootstrap nodes, so we are always connected to it
   * - call refs on the delegated node, so it fetches the content
   *
   * @param {CID} key
   * @param {function(Error)} callback
   * @returns {Promise<void>}
   */
  async provide (key) {
    const keyString = `${key}`
    log('provide starts:', keyString)
    const results = await this._httpQueueRefs.add(() =>
      all(this.refs(keyString, { recursive: false }))
    )
    log('provide finished:', keyString, results)
  }
}

module.exports = DelegatedContentRouting
