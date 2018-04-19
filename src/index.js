'use strict'

const PeerInfo = require('peer-info')
const dht = require('ipfs-api/src/dht')
const defaultConfig = require('ipfs-api/src/utils/default-config')

const DEFAULT_IPFS_API = {
  protocol: 'https',
  port: 443,
  host: 'ipfs.io'
}

/**
 * An implementation of content routing, using a delegated peer.
 */
class DelegatedContentRouting {
  /**
   * Create a new KadDHT.
   *
   * @param {object} api - the api endpoint of the delegated node to use.
   */
  constructor (api) {
    this.api = Object.assign({}, defaultConfig(), api || DEFAULT_IPFS_API)
    this.dht = dht(this.api)
  }

  /**
   * Search the dht for providers of the given CID.
   *
   * - call `findProviders` on the delegated node.
   * - does not support the `timeout` parameter, as this is specific to the delegate node.
   *
   * @param {CID} key
   * @param {function(Error, Array<PeerInfo>)} callback
   * @returns {void}
   */
  findProviders (key, callback) {
    this.dht.findprovs(key, (err, results) => {
      if (err) {
        return callback(err)
      }

      // cleanup result from ipfs-api
      const infos = []
      results
        .filter((res) => Boolean(res.Responses))
        .forEach((res) => {
          res.Responses.forEach((raw) => {
            const info = new PeerInfo(raw.ID)
            if (raw.Addrs) {
              raw.Addrs.forEach((addr) => info.multiaddrs.add(addr))
            }
            infos.push(info)
          })
        })

      callback(null, infos)
    })
  }

  /**
   * Announce to the network that the delegated node can provide the given key.
   *
   * @param {CID} key
   * @param {function(Error)} callback
   * @returns {void}
   */
  provide (key, callback) {
    // TODO: Implement me
    callback()
  }
}

module.exports = DelegatedContentRouting
