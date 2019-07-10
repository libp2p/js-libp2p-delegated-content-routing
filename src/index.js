'use strict'

const PeerInfo = require('peer-info')
const PeerID = require('peer-id')
const dht = require('ipfs-http-client/src/dht')
const swarm = require('ipfs-http-client/src/swarm')
const refs = require('ipfs-http-client/src/files-regular/refs')
const defaultConfig = require('ipfs-http-client/src/utils/default-config')
const series = require('async/series')
const parallel = require('async/parallel')
const reflect = require('async/reflect')
const multiaddr = require('multiaddr')

const DEFAULT_MAX_TIMEOUT = 30e3 // 30 second default
const DEFAULT_IPFS_API = {
  protocol: 'https',
  port: 443,
  host: 'ipfs.io'
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

    this.dht.findProvs(key.toString(), {
      timeout: `${options.maxTimeout}ms` // The api requires specification of the time unit (s/ms)
    }, callback)
  }

  /**
   * Announce to the network that the delegated node can provide the given key.
   *
   * Currently this uses the following hack
   * - call swarm.connect on the delegated node to us, to ensure we are connected
   * - call refs --recursive on the delegated node, so it fetches the content
   *
   * @param {CID} key
   * @param {function(Error)} callback
   * @returns {void}
   */
  provide (key, callback) {
    const addrs = this.bootstrappers.map((addr) => {
      return addr.encapsulate(`/p2p-circuit/ipfs/${this.peerId.toB58String()}`)
    })

    series([
      (cb) => parallel(addrs.map((addr) => {
        return reflect((cb) => this.swarm.connect(addr.toString(), cb))
      }), (err, results) => {
        if (err) {
          return cb(err)
        }

        // only some need to succeed
        const success = results.filter((res) => res.error == null)
        if (success.length === 0) {
          return cb(new Error('unable to swarm.connect using p2p-circuit'))
        }
        cb()
      }),
      (cb) => {
        this.refs(key.toString(), { recursive: true }, cb)
      }
    ], (err) => callback(err))
  }
}

module.exports = DelegatedContentRouting
