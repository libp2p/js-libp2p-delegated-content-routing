'use strict'

const debug = require('debug')
const drain = require('it-drain')
const { default: PQueue } = require('p-queue')

const log = debug('libp2p-delegated-content-routing:value-store')
const CONCURRENT_HTTP_REQUESTS = 4

/**
 * An implementation of the ValueStoreInterface using a delegated node.
 */
class DelegatedValueStore {
  /**
   * Create a new DelegatedValueStore instance.
   *
   * @param {object} client  - an instance of the ipfs-http-client module
   */
  constructor (client) {
    if (client == null) {
      throw new Error('missing ipfs http client')
    }

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
   * @returns {Promise<Uint8Array>} the value for the given key.
   */
  async get (key, options = {}) {
    const timeout = options.timeout || 3000
    log(`get value start: ${key}`)
    let value
    await this._httpQueue.add(async () => {
      value = await this._client.dht.get(key, { timeout })
    })
    log(`get value finished: ${key}`)
    return value
  }
}

module.exports = DelegatedValueStore
