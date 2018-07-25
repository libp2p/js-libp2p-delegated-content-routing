/* eslint-env mocha */
'use strict'

const expect = require('chai').expect
const IPFSFactory = require('ipfsd-ctl')
const async = require('async')
const CID = require('cids')

const factory = IPFSFactory.create({ type: 'go' })

const DelegatedContentRouting = require('../src')

function spawnNode (boostrap, callback) {
  if (typeof boostrap === 'function') {
    callback = boostrap
    boostrap = []
  }

  factory.spawn({
    // Lock down the nodes so testing can be deterministic
    config: {
      Bootstrap: boostrap,
      Discovery: {
        MDNS: {
          Enabled: false
        }
      }
    }
  }, (err, node) => {
    if (err) return callback(err)

    node.api.id((err, id) => {
      if (err) return callback(err)

      callback(null, node, id)
    })
  })
}

describe('DelegatedContentRouting', function () {
  this.timeout(20 * 1000) // we're spawning daemons, give ci some time

  let selfNode
  let selfId
  let delegatedNode
  let bootstrapNode
  let bootstrapId

  before((done) => {
    async.waterfall([
      // Spawn a "Boostrap" node that doesnt connect to anything
      (cb) => spawnNode(cb),
      (ipfsd, id, cb) => {
        bootstrapNode = ipfsd
        bootstrapId = id
        cb()
      },
      // Spawn our local node and bootstrap the bootstrapper node
      (cb) => spawnNode(bootstrapId.addresses, cb),
      (ipfsd, id, cb) => {
        selfNode = ipfsd
        selfId = id
        cb()
      },
      // Spawn the delegate node and bootstrap the bootstrapper node
      (cb) => spawnNode(bootstrapId.addresses, cb),
      (ipfsd, id, cb) => {
        delegatedNode = ipfsd
        cb()
      }
    ], done)
  })

  after((done) => {
    async.parallel([
      (cb) => selfNode.stop(cb),
      (cb) => delegatedNode.stop(cb),
      (cb) => bootstrapNode.stop(cb)
    ], done)
  })

  describe('create', () => {
    it('should require peerInfo', () => {
      expect(() => new DelegatedContentRouting()).to.throw()
    })

    it('should default to https://ipfs.io as the delegate', () => {
      const router = new DelegatedContentRouting(selfId)

      expect(router.api).to.include({
        'api-path': '/api/v0/',
        protocol: 'https',
        port: 443,
        host: 'ipfs.io'
      })
    })

    it('should allow for just specifying the host', () => {
      const router = new DelegatedContentRouting(selfId, {
        host: 'other.ipfs.io'
      })

      expect(router.api).to.include({
        'api-path': '/api/v0/',
        protocol: 'https',
        port: 443,
        host: 'other.ipfs.io'
      })
    })

    it('should allow for overriding the api', () => {
      const api = {
        'api-path': '/api/v1/',
        protocol: 'http',
        port: 8000,
        host: 'localhost'
      }
      const router = new DelegatedContentRouting(selfId, api)

      expect(router.api).to.include(api)
    })
  })

  describe('findProviders', () => {
    it('should be able to find providers through the delegate node', function (done) {
      async.waterfall([
        (cb) => {
          const opts = delegatedNode.apiAddr.toOptions()
          const routing = new DelegatedContentRouting(selfId, {
            protocol: 'http',
            port: opts.port,
            host: opts.host
          })
          const cid = 'QmS4ustL54uo8FzR9455qaxZwuMiUhyvMcX9Ba8nUH4uVv'
          routing.findProviders(cid, cb)
        },
        (providers, cb) => {
          // We should get our local node and the bootstrap node as providers.
          // The delegate node is not included, because it is handling the requests
          expect(providers).to.have.length(2)
          expect(providers.map((p) => p.id)).to.have.members([
            bootstrapId.id,
            selfId.id
          ])
          cb()
        }
      ], done)
    })
  })

  describe('provide', () => {
    it('should be able to register as a content provider to the delegate node', function (done) {
      let contentRouter
      let cid

      async.waterfall([
        (cb) => {
          const opts = delegatedNode.apiAddr.toOptions()
          contentRouter = new DelegatedContentRouting(selfId, {
            protocol: 'http',
            port: opts.port,
            host: opts.host
          })

          selfNode.api.files.add(Buffer.from(`hello-${Math.random()}`), cb)
        },
        (res, cb) => {
          cid = new CID(res[0].hash)
          contentRouter.provide(cid, cb)
        },
        (cb) => {
          delegatedNode.api.dht.findprovs(cid.toBaseEncodedString(), cb)
        },
        (provs, cb) => {
          let providers = []
          provs.filter((res) => Boolean(res.Responses)).forEach((res) => {
            providers = providers.concat(res.Responses)
          })

          // We are hosting the file, validate we're the provider
          const res = providers.find((prov) => prov.ID === selfId.id)
          expect(res.ID).to.equal(selfId.id)

          cb()
        }
      ], done)
    })
  })
})
