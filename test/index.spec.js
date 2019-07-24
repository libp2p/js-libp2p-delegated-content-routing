/* eslint-env mocha */
'use strict'

const expect = require('chai').expect
const IPFSFactory = require('ipfsd-ctl')
const CID = require('cids')
const PeerId = require('peer-id')
const all = require('async-iterator-all')
const factory = IPFSFactory.create({
  type: 'go'
})

const DelegatedContentRouting = require('../src')

async function spawnNode (bootstrap = []) {
  const node = await factory.spawn({
    // Lock down the nodes so testing can be deterministic
    config: {
      Bootstrap: bootstrap,
      Discovery: {
        MDNS: {
          Enabled: false
        }
      }
    }
  })

  const id = await node.api.id()

  return {
    node,
    id
  }
}

describe('DelegatedContentRouting', function () {
  this.timeout(20 * 1000) // we're spawning daemons, give ci some time

  let selfNode
  let selfId
  let delegateNode
  let bootstrapNode
  let bootstrapId

  before(async () => {
    // Spawn a "Boostrap" node that doesnt connect to anything
    const bootstrap = await spawnNode()
    bootstrapNode = bootstrap.node
    bootstrapId = bootstrap.id

    // Spawn our local node and bootstrap the bootstrapper node
    const self = await spawnNode(bootstrapId.addresses)
    selfNode = self.node
    selfId = PeerId.createFromB58String(self.id.id)

    // Spawn the delegate node and bootstrap the bootstrapper node
    const delegate = await spawnNode(bootstrapId.addresses)
    delegateNode = delegate.node
  })

  after(() => {
    return Promise.all([
      selfNode.stop(),
      delegateNode.stop(),
      bootstrapNode.stop()
    ])
  })

  describe('create', () => {
    it('should require peerInfo', () => {
      expect(() => new DelegatedContentRouting()).to.throw()
    })

    it('should default to https://node0.delegate.ipfs.io as the delegate', () => {
      const router = new DelegatedContentRouting(selfId)

      expect(router.api).to.include({
        'api-path': '/api/v0/',
        protocol: 'https',
        port: 443,
        host: 'node0.delegate.ipfs.io'
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
    const cid = new CID('QmS4ustL54uo8FzR9455qaxZwuMiUhyvMcX9Ba8nUH4uVv')

    before('register providers', async () => {
      await bootstrapNode.api.dht.provide(cid)
      await selfNode.api.dht.provide(cid)
    })

    it('should be able to find providers through the delegate node', async () => {
      const opts = delegateNode.apiAddr.toOptions()
      const routing = new DelegatedContentRouting(selfId, {
        protocol: 'http',
        port: opts.port,
        host: opts.host
      })

      const providers = await all(routing.findProviders(cid))

      // We should get the bootstrap node as provider
      // The delegate node is not included, because it is handling the requests
      expect(providers.map((p) => p.id.toB58String())).to.include(bootstrapId.id, 'Did not include bootstrap node')
      expect(providers.map((p) => p.id.toB58String())).to.include(selfId.toB58String(), 'Did not include self node')
    })

    it('should be able to specify a maxTimeout', async () => {
      const opts = delegateNode.apiAddr.toOptions()
      const routing = new DelegatedContentRouting(selfId, {
        protocol: 'http',
        port: opts.port,
        host: opts.host
      })

      const cid = new CID('QmS4ustL54uo8FzR9455qaxZwuMiUhyvMcX9Ba8nUH4uVv')
      const providers = await all(routing.findProviders(cid, { maxTimeout: 5e3 }))

      expect(providers.map((p) => p.id.toB58String())).to.include(bootstrapId.id, 'Did not include bootstrap node')
    })
  })

  describe('provide', () => {
    it('should be able to register as a content provider to the delegate node', async () => {
      let contentRouter
      let cid

      const opts = delegateNode.apiAddr.toOptions()
      contentRouter = new DelegatedContentRouting(selfId, {
        protocol: 'http',
        port: opts.port,
        host: opts.host
      })

      const res = await selfNode.api.add(Buffer.from(`hello-${Math.random()}`))
      cid = new CID(res[0].hash)
      await contentRouter.provide(cid)
      const providers = await delegateNode.api.dht.findProvs(cid.toBaseEncodedString())

      // We are hosting the file, validate we're the provider
      expect(providers.map((p) => p.id.toB58String())).to.include(selfId.toB58String(), 'Did not include self node')
    })
  })
})
