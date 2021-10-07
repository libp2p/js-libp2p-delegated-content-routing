'use strict'

const debug = require('debug')
const drain = require('it-drain')
const { default: PQueue } = require('p-queue')

const log = debug('libp2p-delegated-content-routing:value-store')
const CONCURRENT_HTTP_REQUESTS = 4

/**
 * @typedef {{import('peer-id')}.PeerId} PeerId
 *
 * @typedef {object} GetValueResult
 * @property {PeerId} from
 * @property {Uint8Array} val
 */

/**
 * An implementation of the ValueStoreInterface using a delegated node.
 */
class DelegatedValueStore {
  /**
   * Create a new DelegatedValueStore instance.
   *
   * @param {PeerId} delegateId - the peer id of the delegate node
   * @param {object} client  - an instance of the ipfs-http-client module
   */
  constructor (delegateId, client) {
    if (delegateId == null) {
      throw new Error('missing delegate peer id')
    }

    if (client == null) {
      throw new Error('missing ipfs http client')
    }

    this._delegateId = delegateId
    this._client = client
    const concurrency = { concurrency: CONCURRENT_HTTP_REQUESTS }
    this._httpQueue = new PQueue(concurrency)

    const {
      protocol,
      host,
      port
    } = client.getEndpointConfig()

    log(`enabled DelegatedValueStore via ${protocol}://${host}:${port}`)
  }

  /**
   * Stores a value in the backing key/value store of the delegated content router.
   * This may fail if the delegated node's content routing implementation does not
   * use a key/value store, or if the delegated operation fails.
   *
   * @param {Uint8Array} key - the key to store the value under
   * @param {Uint8Array} value - a value to associate with the key.
   * @param {object} [options]
   * @param {number} [options.timeout] - a timeout in ms. Defaults to 30s.
   * @returns {Promise<void>}
   */
  async put (key, value, options = {}) {
    const timeout = options.timeout || 3000
    log(`put value start: ${key}`)
    await this._httpQueue.add(async () => {
      await drain(this._client.dht.put(key, value, { timeout }))
    })
    log(`put value finished: ${key}`)
  }

  /**
   * Fetches an value from the backing key/value store of the delegated content router.
   * This may fail if the delegated node's content routing implementation does not
   * use a key/value store, or if the delegated operation fails.
   *
   * @param {Uint8Array|string} key - the key to lookup. If a Uint8Array is given, it MUST contain valid UTF-8 text.
   * @param {object} [options]
   * @param {number} [options.timeout] - a timeout in ms. Defaults to 30s.
   * @returns {Promise<GetValueResult>} the value for the given key.
   */
  async get (key, options = {}) {
    const timeout = options.timeout || 3000
    log(`get value start: ${key}`)
    let val
    await this._httpQueue.add(async () => {
      val = await this._client.dht.get(key, { timeout })
    })
    log(`get value finished: ${key}`)

    const from = this._delegateId
    return { from, val }
  }
}

module.exports = DelegatedValueStore
