/* eslint-env mocha */
'use strict'

const { expect } = require('aegir/utils/chai')
const { createFactory } = require('ipfsd-ctl')
const { CID } = require('ipfs-http-client')
const PeerId = require('peer-id')
const all = require('it-all')
const drain = require('it-drain')
const { isNode } = require('ipfs-utils/src/env')
const uint8ArrayFromString = require('uint8arrays/from-string')
const factory = createFactory({
  type: 'go',
  ipfsHttpModule: require('ipfs-http-client'),
  ipfsBin: isNode ? require('go-ipfs').path() : undefined,
  test: true,
  endpoint: 'http://localhost:57483'
})

const DelegatedContentRouting = require('../src')

async function spawnNode (bootstrap = []) {
  const node = await factory.spawn({
    // Lock down the nodes so testing can be deterministic
    ipfsOptions: {
      config: {
        Bootstrap: bootstrap,
        Discovery: {
          MDNS: {
            Enabled: false
          }
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
    return factory.clean()
  })

  describe('create', () => {
    it('should require peerInfo', () => {
      expect(() => new DelegatedContentRouting()).to.throw()
    })

    it('should default to https://node0.delegate.ipfs.io as the delegate', () => {
      const router = new DelegatedContentRouting(selfId)

      expect(router.api).to.include({
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
        protocol: 'https',
        port: 443,
        host: 'other.ipfs.io'
      })
    })

    it('should allow for overriding the api', () => {
      const api = {
        protocol: 'http',
        port: 8000,
        host: 'localhost'
      }
      const router = new DelegatedContentRouting(selfId, api)

      expect(router.api).to.include(api)
    })
  })

  describe('findProviders', () => {
    const data = uint8ArrayFromString('some data')
    const cid = new CID('QmVv4Wz46JaZJeH5PMV4LGbRiiMKEmszPYY3g6fjGnVXBS') // 'some data'

    before('register providers', async () => {
      await Promise.all([
        bootstrapNode.api.add(data),
        selfNode.api.add(data)
      ])
      await Promise.all([
        drain(bootstrapNode.api.dht.provide(cid)),
        drain(selfNode.api.dht.provide(cid))
      ])
    })

    it('should be able to find providers through the delegate node', async function () {
      const opts = delegateNode.apiAddr.toOptions()
      const routing = new DelegatedContentRouting(selfId, {
        protocol: 'http',
        port: opts.port,
        host: opts.host
      })

      const providers = await all(routing.findProviders(cid, { numProviders: 2 }))

      // We should get the bootstrap node as provider
      // The delegate node is not included, because it is handling the requests
      expect(providers.map((p) => p.id.toB58String())).to.include(bootstrapId.id, 'Did not include bootstrap node')
      expect(providers.map((p) => p.id.toB58String())).to.include(selfId.toB58String(), 'Did not include self node')
    })

    it('should be able to specify a timeout', async () => {
      const opts = delegateNode.apiAddr.toOptions()
      const routing = new DelegatedContentRouting(selfId, {
        protocol: 'http',
        port: opts.port,
        host: opts.host
      })

      const providers = await all(routing.findProviders(cid, { numProviders: 2, timeout: 5e3 }))

      expect(providers.map((p) => p.id.toB58String())).to.include(bootstrapId.id, 'Did not include bootstrap node')
    })
  })

  describe('provide', () => {
    it('should be able to register as a content provider to the delegate node', async () => {
      const opts = delegateNode.apiAddr.toOptions()
      const contentRouter = new DelegatedContentRouting(selfId, {
        protocol: 'http',
        port: opts.port,
        host: opts.host
      })

      const { cid } = await selfNode.api.add(uint8ArrayFromString(`hello-${Math.random()}`))

      await contentRouter.provide(cid)

      const providers = await all(delegateNode.api.dht.findProvs(cid, { numProviders: 2 }))

      // We are hosting the file, validate we're the provider
      expect(providers.map((p) => p.id)).to.include(selfId.toB58String(), 'Did not include self node')
    })
  })
})
