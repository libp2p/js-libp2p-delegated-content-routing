'use strict'

const dht = require('ipfs-http-client/src/dht')
const swarm = require('ipfs-http-client/src/swarm')
const refs = require('ipfs-http-client/src/files-regular/refs')
const defaultConfig = require('ipfs-http-client/src/utils/default-config')
const multiaddr = require('multiaddr')
const { default: PQueue } = require('p-queue')

const DEFAULT_MAX_TIMEOUT = 30e3 // 30 second default
const DEFAULT_IPFS_API = {
  protocol: 'https',
  port: 443,
  host: 'node0.delegate.ipfs.io'
}

const DEFAULT_BOOSTRAP_NODES = [
  '/ipfs/QmSoLer265NRgSp2LA3dPaeykiS1J6DifTC88f5uVQKNAd',
  '/ipfs/QmSoLMeWqB7YGVLJN3pNLQpmmEk35v6wYtsMGLzSr5QBU3',
  '/ipfs/QmSoLPppuBtQSGwKDZT2M73ULpjvfd3aZ6ha4oFGL1KrGM',
  '/ipfs/QmSoLSafTMBsPKadTEgaXctDQVcqN88CNLHXMkTNwMKPnu',
  '/ipfs/QmSoLueR4xBeUbY9WZ9xGUUxunbKWcrNFTDAadQJmocnWm',
  '/ipfs/QmSoLV4Bbm51jM9C4gDYZQ9Cy3U6aXMJDAbzgu2fzaDs64',
  '/ipfs/QmZMxNdpMkewiVZLMRxaNxUeZpDUb34pWjZ1kZvsd16Zic',
  '/ipfs/Qmbut9Ywz9YEDrz8ySBSgWyJk41Uvm2QJPhwDJzJyGFsD6'
]

/**
 * An implementation of content routing, using a delegated peer.
 */
class DelegatedContentRouting {
  /**
   * Create a new DelegatedContentRouting instance.
   *
   * @param {PeerID} peerId - the id of the node that is using this routing.
   * @param {object} [api] - (Optional) the api endpoint of the delegated node to use.
   * @param {Array<Multiaddr>} [bootstrappers] - (Optional) list of bootstrapper nodes we are connected to.
   */
  constructor (peerId, api, bootstrappers) {
    if (peerId == null) {
      throw new Error('missing self peerId')
    }

    this.api = Object.assign({}, defaultConfig(), DEFAULT_IPFS_API, api)
    this.dht = dht(this.api)
    this.swarm = swarm(this.api)
    this.refs = refs(this.api)

    this.peerId = peerId
    this.bootstrappers = bootstrappers || DEFAULT_BOOSTRAP_NODES.map((addr) => multiaddr(addr))

    // limit concurrency to avoid request flood in web browser
    // (backport of: https://github.com/libp2p/js-libp2p-delegated-content-routing/pull/16/)
    this._httpQueue = new PQueue({ concurrency: 4 })
    // sometimes refs requests take long time, they need separate queue
    // to not suffocate regular bussiness
    this._httpQueueRefs = new PQueue({ concurrency: 2 })
  }

  /**
   * Search the dht for providers of the given CID.
   *
   * - call `findProviders` on the delegated node.
   *
   * @param {CID} key
   * @param {object} options
   * @param {number} options.maxTimeout How long the query can take. Defaults to 30 seconds
   * @param {function(Error, Array<PeerInfo>)} callback
   * @returns {void}
   */
  findProviders (key, options, callback) {
    if (typeof options === 'function') {
      callback = options
      options = {}
    } else if (typeof options === 'number') { // This will be deprecated in a next release
      options = {
        maxTimeout: options
      }
    } else {
      options = options || {}
    }

    options.maxTimeout = options.maxTimeout || DEFAULT_MAX_TIMEOUT

    this._httpQueue.add(() =>
      this.dht.findProvs(key.toString(), {
        timeout: `${options.maxTimeout}ms` // The api requires specification of the time unit (s/ms)
      })
    ).then(res => callback(null, res), callback)
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
   * @returns {void}
   */
  provide (key, callback) {
    this._httpQueueRefs.add(() =>
      this.refs(key.toString(), { recursive: false })
    ).then(() => callback(), callback)
  }
}

module.exports = DelegatedContentRouting
