'use strict'

const dht = require('ipfs-http-client/src/dht')
const refs = require('ipfs-http-client/src/files-regular/refs')
const defaultConfig = require('ipfs-http-client/src/utils/default-config')
const { default: PQueue } = require('p-queue')
const debug = require('debug')

const log = debug('libp2p-delegated-content-routing')
log.error = debug('libp2p-delegated-content-routing:error')

const DEFAULT_MAX_TIMEOUT = 30e3 // 30 second default
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

    this.api = Object.assign({}, defaultConfig(), DEFAULT_IPFS_API, api)
    this.dht = dht(this.api)
    this.refs = refs(this.api)
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
   * @param {number} options.maxTimeout How long the query can take. Defaults to 30 seconds
   * @returns {AsyncIterable<PeerInfo>}
   */
  async * findProviders (key, options = {}) {
    const keyString = key.toBaseEncodedString()
    log('findProviders starts: ' + keyString)
    options.maxTimeout = options.maxTimeout || DEFAULT_MAX_TIMEOUT

    const results = await this._httpQueue.add(() => this.dht.findProvs(key, {
      timeout: `${options.maxTimeout}ms` // The api requires specification of the time unit (s/ms)
    }))

    for (let i = 0; i < results.length; i++) {
      yield results[i]
    }
    log('findProviders finished: ' + keyString)
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
    const keyString = key.toBaseEncodedString()
    log('provide starts: ' + keyString)
    await this._httpQueueRefs.add(() =>
      this.refs(keyString, { recursive: false })
    )
    log('provide finished: ' + keyString)
  }
}

module.exports = DelegatedContentRouting
